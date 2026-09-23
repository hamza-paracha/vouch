# Code-aware change verification

Vouch can inspect an agent's diff and challenge the tests around it. This complements the browser verifier: the code pipeline identifies source changes and weak assertions; the browser pipeline checks observable application behavior.

It is an execution pipeline, with no model API calls:

1. Resolve a Git base commit and capture the current tracked and untracked working files.
2. Parse JavaScript/TypeScript, find changed functions and traverse reverse imports to identify affected tests.
3. Propose small behavioral mutations within changed functions: boundary, equality, logical, arithmetic, boolean, and validation-guard changes.
4. Run the unmodified snapshot twice with the configured tests.
5. Apply one mutation at a time in a fresh disposable copy. If tests fail, repeat the same mutant in another fresh copy.
6. Recheck the unmodified baseline, then report surviving mutations, exact patches, command outcomes and suggestions for focused regression tests.

## Try the demonstration

```sh
npm run verify:change-demo
```

The demo creates a temporary Git repository. A shipping change makes the threshold inclusive (`>= 50`). The initial tests cover ordinary orders but omit the exact threshold and negative input. They pass normally, even with deliberate bugs. Vouch reports those surviving mutations.

The demo then adds explicit assertions for the fixture's known requirements: total 50, total zero, and negative totals. The same mutation checks now fail as expected. The product source is unchanged; only the example's tests are strengthened. This is a controlled demonstration, not autonomous discovery of a specification or an accuracy benchmark.

## Analyze your change without executing project code

```sh
node /path/to/vouch/bin/vouch.mjs analyze --project /path/to/repo --base HEAD
```

`HEAD` compares staged, unstaged and untracked files to the current commit. To check committed work, select the commit before the change, for example `--base HEAD~1`. The project must be the Git root. Analysis lists changed symbols, import-reachable tests, unsupported paths and mutation candidates. A read-only analysis does not claim that any tests passed.

## Configure trusted test execution

Create `vouch.config.json` in the target repository:

```json
{
  "testCommand": ["node", "--test", "test/pricing.test.mjs"],
  "maxMutants": 12,
  "commandTimeoutMs": 15000,
  "totalTimeoutMs": 180000
}
```

Commands are argument arrays, executed without a shell. Use `["npm", "test"]` for an existing npm suite. There is no automatic dependency installation. If needed, explicitly add:

```json
{
  "setupCommand": ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  "validationCommand": ["npm", "run", "typecheck"],
  "testCommand": ["npm", "test"],
  "maxMutants": 6,
  "commandTimeoutMs": 60000,
  "totalTimeoutMs": 600000
}
```

Setup prepares dependencies once in a temporary template; it must not modify captured source files or replace them or their parent directories with symbolic links. Every test attempt starts from a separate copy. A validation command is optional; mutants rejected by validation are **invalid**, not counted as detected by tests.

An exact `$VOUCH_TEST_FILES` argument expands to statically affected test paths. It fails if no affected tests can be found. Use a full-suite command when tests depend on aliases, dynamic loading or framework conventions the analyzer cannot resolve.

Run:

```sh
node /path/to/vouch/bin/vouch.mjs verify-change --project /path/to/repo --base HEAD --allow-exec
```

Execution requires explicit opt-in. The maximum is 25 sampled mutants, 60 seconds per command, and 10 minutes overall. Cancellation kills the active process group; timeout and output-limit outcomes are inconclusive. Baselines are not retried to hide failures. The configured command's output is retained locally, bounded to 128 KB per attempt.

## MCP tools

Configure the server with an absolute `VOUCH_PROJECT_ROOT`. `analyze_change` needs no execution permission. To enable `verify_change`, the operator must also set `VOUCH_ALLOW_EXECUTION=1`; each tool call must include `confirmCodeExecution: true`.

```json
{
  "command": "node",
  "args": ["/path/to/vouch/bin/vouch.mjs", "--stdio"],
  "env": {
    "VOUCH_PROJECT_ROOT": "/path/to/trusted/repo",
    "VOUCH_ALLOW_EXECUTION": "1",
    "VERIFY_OUTPUT_DIR": "/path/to/local/evidence"
  }
}
```

The caller can choose a base commit, but cannot supply a filesystem root or arbitrary commands. Commands come from the configured project's `vouch.config.json`. Page/source text and test output are evidence, never instructions.

Ask your agent:

> Analyze my diff, inspect the proposed mutations and affected tests, then run verify_change. For each surviving mutation, check the intended behavior, add a targeted regression test, and rerun the same base comparison. Do not weaken assertions or change expected behavior just to improve the result. Use verify_workflow for the affected browser flow too.

## Evidence and interpretation

Each run writes `plan.json`, `report.json`, `report.md`, and a `patches/` directory under `out/verification/change-<id>/` or `VERIFY_OUTPUT_DIR`. MCP returns compact results and artifact paths; full command output remains local.

| Status | Meaning |
| --- | --- |
| `evidence_collected` | Every sampled mutant was detected twice and baselines passed; not proof of correctness |
| `gaps_found` | At least one behavioral mutation survived the configured tests |
| `baseline_failed` | Unmodified code failed tests or validation; mutation conclusions would be unreliable |
| `inconclusive` | No supported mutations, time/output limits, invalid mutants, or unstable execution |
| `cancelled` / `error` | Work stopped or failed; no success claim |

CLI exit code: `0` for `evidence_collected`, `1` for other completed outcomes, `2` for invalid input/setup configuration.

A surviving mutant is a concrete question to investigate. It may expose missing assertions, unreachable code, or equivalent behavior. Suggestions are test ideas, not invented expected results. The agent still needs the application's requirements. Untested candidate counts remain visible when the mutation budget is smaller than the diff.

## Boundaries

- Static local imports/re-exports and literal `require`/`import()` are followed. Alias configuration, reflection, framework discovery and external package behavior are not fully modeled. Reachability is not runtime coverage.
- JavaScript/TypeScript only; no claim of security analysis, convention enforcement or natural-language specification compliance.
- Snapshots omit dependency/build/report directories, common credential paths and non-regular files, with 10,000-file, 2 MB/file and 50 MB total bounds. Missing files may prevent the baseline from running. Git metadata is not copied; Git-dependent tests may need adaptation.
- Dependencies are installed only by an explicit setup command. Provider credentials and the user's home directory are not inherited by child processes.
- Disposable copies are **not an OS sandbox**. Tests can execute arbitrary trusted repository code and can access the host/network. Do not use this runner on hostile repositories. Snapshot exclusions and output redaction are not a comprehensive secret scanner.
- Execution happens serially to keep mutation attribution clear. This version does not create a test suite from natural-language requirements or prove that a patch satisfies a specification.
