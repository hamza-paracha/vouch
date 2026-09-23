# Vouch Guard: structured code review

Vouch Guard reviews a Git diff using Jev's `noul`, `choice` and `score` primitives. Each changed file gets one model request containing eight questions: breaking behavior, risk, change type, missing tests, error handling, input validation, side effects and merge readiness. A PR assessment adds four questions about scope, splitting, security relevance and urgency.

This is an advisory review layer. It does not run project code, execute browser workflows or merge changes. The full Vouch package also provides browser and mutation verification; the standalone Guard package runs without Playwright, Chromium or the AST parser.

## Install and connect

From the Vouch source checkout:

```sh
npm ci
node bin/guard.mjs --help
```

To create a standalone local package:

```sh
npm run review:build
npm install /absolute/path/to/vouch/out/review-package
```

The package is not published to npm. Install the generated directory or use its absolute `bin/guard.mjs` path directly. Node 22+ and Git are required; Chromium is not.

Configure the server process explicitly:

```sh
export TYPESAFE_API_KEY='your-provider-key'
export JEV_GUARD_PROJECT_ROOT=/absolute/path/to/trusted/repository
export JEV_GUARD_MAX_CALLS=20
export JEV_GUARD_MAX_ESTIMATED_USD=0.03
export JEV_GUARD_ESTIMATE_PER_CALL_USD=0.0015
export JEV_GUARD_BUDGET_LEDGER=/absolute/private/path/vouch-review-budget.json
```

Reservations persist across calls and server restarts. The example permits at most 20 attempts with $0.03 of estimated reservations; it is not a provider billing cap. Failed or uncertain requests retain their reservations. Investigate an exhausted budget before deliberately extending it; do not delete the ledger to bypass it. With no budget configuration, models remain disabled. The normal CLI does not load `.env` automatically.

Register the review-only MCP server:

```sh
codex mcp add vouch-guard -- node /absolute/path/to/vouch/bin/guard.mjs --stdio
claude mcp add --transport stdio vouch-guard -- node /absolute/path/to/vouch/bin/guard.mjs --stdio
```

Make the environment above available to the registered server, using your client's MCP environment configuration or the launching environment. Restart the client task/session after changing its configuration. The full `bin/vouch.mjs --stdio` server exposes these same three tools alongside Vouch's four existing tools.

## Tools and CLI

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `review_change` | `base` (default `HEAD~1`), optional exact-file `focus` array | Per-file review of the selected diff |
| `assess_pr` | `base` (default `main`), optional `title` and `description` | Per-file review plus one overall assessment |
| `check_file` | repository-relative `file`, `base` (default `HEAD`) | One changed file, one model request |

`HEAD` includes staged, unstaged and untracked working files; use a prior commit to review committed work. The configured path must be the Git root. These tools read the local branch, not a remote GitHub PR. They accept no arbitrary shell commands or root override.

```sh
node bin/guard.mjs review --project /path/to/repo --base HEAD
node bin/guard.mjs assess-pr --project /path/to/repo --base main --title 'Inclusive shipping threshold'
node bin/guard.mjs check-file --project /path/to/repo --file src/pricing.ts --base HEAD
```

The full Vouch CLI supports the same commands. `--focus path` can be repeated with `review`. Exit codes are `0` clean, `1` attention/high risk, and `2` error, cancellation or exhausted budget. A no-change result explicitly says that no model review was performed.

Ask your coding agent:

> Review my diff with review_change. Investigate flags against the source and requirements, report uncertain judgments, and use the existing tests and Vouch's browser/mutation tools to validate fixes. A model's merge-readiness answer is not permission to merge.

## Verdicts and confidence

The current SDK differs from the original assessment examples:

- `noul` returns a yes probability, without a separate confidence field. Guard derives a boolean at 0.5 and reports the selected outcome's probability as confidence, with `confidenceSource: selected_probability`.
- `choice` returns a label, distribution and provider-reported confidence.
- `score` takes an ordered array and returns a numeric expected level, which may lie between levels, plus distribution and confidence. Risk levels are 0 low, 1 medium, 2 high and 3 critical.

Threshold defaults are 0.90 high and 0.70 medium. High-confidence concerns become flags; medium-confidence concerns become warnings; low-confidence answers become uncertain items. Even uncertain favorable answers prevent a clean result. Incomplete context, skipped files and partial reviews also prevent clean results.

These are operational thresholds, not accuracy guarantees calibrated on your codebase. Returned probabilities, provenance and uncertainty remain visible. Guard never automatically changes code or merges on a confidence score. See TypeSafe's [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score) and [model reference](https://docs.typesafe.ai/models).

Example verdict shape (illustrative values):

```json
{
  "question": "needs_tests",
  "type": "noul",
  "answer": true,
  "confidence": 0.94,
  "confidenceSource": "selected_probability",
  "level": "high_confidence",
  "probabilities": {"yes": 0.94, "no": 0.06}
}
```

Each run retains owner-only `report.json` and `report.md` files. Reports include the base commit, diff fingerprint, file coverage, skipped paths, latency, complete verdicts and distributions, token usage, estimated price and reservations. Provider-reported billing is unknown. Lost or invalid responses leave usage/cost unknown rather than assuming zero.

## Configuration

| Variable | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY` | Provider credential; never included in reports |
| `JEV_GUARD_PROJECT_ROOT` | Repository root; falls back to `VOUCH_PROJECT_ROOT` |
| `JEV_GUARD_MODEL` | Default `jev-1.13.0` |
| `JEV_GUARD_MAX_CALLS` | Persistent lifetime attempts, 0 by default, maximum 20 |
| `JEV_GUARD_MAX_ESTIMATED_USD` | Maximum reserved estimates |
| `JEV_GUARD_ESTIMATE_PER_CALL_USD` | Reservation before each dispatch |
| `JEV_GUARD_BUDGET_LEDGER` | Absolute persistent ledger path |
| `JEV_GUARD_MAX_CALLS_PER_RUN` | 12 by default, maximum 20 |
| `JEV_GUARD_CONCURRENCY` | 5 by default, range 1–10 |
| `JEV_GUARD_THRESHOLD_HIGH` / `JEV_GUARD_THRESHOLD_MEDIUM` | 0.90 / 0.70; high must exceed medium |
| `JEV_GUARD_INPUT_PRICE_PER_MILLION` | Optional explicit price estimate; pinned Jev 1.13 uses $0.042; other models default to unknown |
| `VERIFY_OUTPUT_DIR` | Local artifact root |

Browser model budgets remain separately configured. A review never enables or increases either budget through tool arguments.

## Bounds and measured validation

The reader handles added, modified, deleted and Git-detected renamed files. It excludes common credential/build paths, binary files, external links and files larger than 100 KB. A review includes at most 50 files and 10 KB of unified diff per file; model state is bounded to 5 KB, prioritizing additions and marking truncation. Fixed questions are supplied separately. Secret values and common key formats are scrubbed before transmission, but scrubbing is not a comprehensive secret scanner. Only enable review for code authorized to be sent to the provider.

Model requests have an eight-second timeout and no retries. The review has a 45-second deadline and bounded concurrency. Larger diffs may exhaust the configured budget; reports explicitly identify incomplete evidence.

A real-provider smoke test exercised all three MCP tools over stdio against a synthetic repository: 13 calls total, with the ten-file review completing in 638 ms at concurrency 5. This is one measurement, not an SLA or held-out accuracy/calibration benchmark. The test preserved warnings and uncertainty rather than asserting that model judgments were correct. Details are recorded in the main repository's `docs/review-validation.json` artifact.

For an explicitly enabled repeatable smoke test, `npm run verify:review-live -- --live` has its own persistent 13-call ledger and uses synthetic source only. An exhausted ledger stops further calls. CI uses simulated provider responses and spends nothing.
