# Validation evidence

## Version 0.3 candidate

The local 0.3 candidate adds code-aware verification alongside the browser workflow engine. No paid model calls were made for these checks.

- **129 automated tests pass**, including the existing explorer, browser verifier, TLS redirects/cookies, named sessions, DOM assertions, mutation execution, executable file modes, patch application and the real MCP transport.
- Typechecking, the browser demonstration, the disk-backed profile example and the code-verification demonstration pass.
- A fresh tarball installed outside the checkout passes readiness, browser verification over MCP, change analysis, mutation execution over MCP and verification through the CLI. The self-contained plugin builds and reports ready.
- An independent disk-backed task-board audit passes **11/11 expected outcomes** with the original three-second step timeout and unread fetch bodies. The 0.2 release produced only **7/11** under those conditions. The change uses proxy response completion for settling; an actually unfinished streaming response still abstains.
- The code demo begins with tests that pass but miss **3/3 deliberate behavioral mutations**. Adding explicit threshold, zero and negative-input assertions detects **3/3**, with repeated mutant failures and passing baselines. Source code remains unchanged by the engine.
- Additional cases stop attribution when baselines are unstable, distinguish invalid mutants from detections, constrain command output/time, and verify that session redaction preserves report paths and protocol fields even with short localStorage values.

These are controlled regression checks, not proof of general correctness, autonomous specification discovery or production accuracy. Static test reachability is not measured coverage. The runner executes trusted repository code and is not an OS sandbox. See [code verification limits](code-verification.md#boundaries) and the [remaining roadmap](roadmap.md).

Reproduce with `npm test`, `npm run verify:change-demo`, `npm run verify:demo`, `npm run verify:install`, and `npm run verify:example`. Local audit evidence is retained under `out/candidate-audit/`; demo reports are under `out/change-demo/`. Those generated directories are excluded from distribution. The independent audit is summarized in [validation-0.3.json](validation-0.3.json).

## Historical version 0.2 validation

Measured during local development on September 22, 2026 (America/Toronto; UTC records are September 23). Machine-readable results are in [validation.json](validation.json). This is a tested local alpha; these measurements do not establish production accuracy or cost savings.

## Live Jev smoke test

| Scenario | Expected | Observed | Model calls |
| --- | --- | --- | ---: |
| Exact control label | Pass | Pass | 0 |
| “Persist the updated profile” → Save | Pass | Pass | 1 |
| Same action, server lies about saving | Fail persisted-state assertion | Failed | 1 |
| Unrelated request to download a tax statement | Abstain | Abstained | 1 |

The three requests used `jev-1.13.0` and **1,314 input tokens**, with retries disabled. At TypeSafe's published **US$0.042 per million input tokens**, the calculated charge is **US$0.000055188**. This is an estimate based on returned token usage, not a provider-reported invoice. [Official model and pricing reference](https://docs.typesafe.ai/models).

The smoke test's three reservations were retained in `out/verification/live-smoke-ledger.json`; rerunning with that exhausted ledger cannot dispatch more calls. No OpenRouter request or large paid benchmark was run.

## Source-level reproduce → fix → verify

The coding agent used the **installed Codex plugin's runtime over MCP**, rather than importing the verifier from the checkout, against a separate disk-backed profile application:

1. Seeded the application with a missing persistence write. The browser still displayed “Profile saved.”
2. Inspected its accessible controls through `inspect_page` and submitted a workflow through `verify_workflow`.
3. The toast assertion passed; `assertJson` failed because the authoritative read endpoint returned `Original`. A separate direct disk read confirmed `Original`.
4. Fixed the application source to await `writeFile` before returning success.
5. Restarted with independently initialized data and reran the same assertions. The workflow passed; the direct disk read confirmed `Ada Lovelace`.

No model calls were needed for this repair verification. This was a seeded defect repaired by the current coding agent, not an autonomous multi-agent benchmark. Source hashes and outcomes are preserved in `validation.json`; full local action evidence and source snapshots are under `out/acceptance/before/` and `out/acceptance/after/` (excluded from distribution). The example checked into `examples/profile-app/server.mjs` contains the fix and can be exercised with `npm run verify:example`.

## Installation and automated checks

- TypeScript typecheck and **114 tests passed**, covering the upstream explorer plus the new verifier.
- Fresh npm tarball installed into a separate temporary project; CLI readiness and real MCP workflow execution passed without relying on the checkout's dependencies.
- Native plugin manifest and skill validators passed. Before the Vouch rename, Codex installed `browser-verify@personal`; its cached executable ran successfully.
- Claude Code recognized one skill and one bundled MCP server; `claude ... mcp get plugin:browser-verify:browser-verify` reported **Connected**.
- Network tests cover cross-origin redirect blocking, normal same-origin redirects, POST method preservation, 303 conversion to GET, write-path restrictions and cookie continuity.
- Budget tests cover reservations shared between independent processes' budget instances, persistence across restarts, lock contention, corruption, cancellation and exhausted limits. Uncertain attempts are never refunded automatically.
- The optional stronger-model path was tested with simulated API responses: escalation after Jev uncertainty, exact model selection, no provider fallback/retries, malformed JSON, refusals, truncated/oversized responses and budget exhaustion. A deliberately wrong stronger-model selection still failed its independent browser assertion.
- Tests cover read-only inspection, automatic control discovery, bounded/cancellable state responses, structured evidence and credential redaction without corrupting JSON.

## Historical 0.2 release boundaries

Only controlled local HTTP apps are supported. HTTPS, authenticated-session import, WebSocket-dependent workflows, remote/staging targets and visual assertions are not covered. Use a production preview for development frameworks requiring HMR sockets.

The Jev threshold remains uncalibrated on this workload. A representative held-out suite and paired policy comparisons are still needed before claiming reliability or routing savings. OpenRouter has not been live-tested. Native bundles contain dependencies for the machine where they were built; rebuild on another OS/architecture. Public source and an alpha release are distributed through GitHub. There is no npm registry or public plugin marketplace publication.

## Public launch checks

The launch candidate was rechecked on Node.js 22.22.0 with models disabled: all 114 tests, typechecking, the paired demo, fresh tarball installation and MCP execution, the disk-backed example, plugin build and readiness check passed. The JSON workflow printed in the README was also extracted and run unchanged against the example app; it passed and the independent file read returned `Ada Lovelace`.

The example acceptance script now asserts that any successful MCP result also matches the independently read disk value. Public CI repeats typechecking, the full suite, both demos, package installation and plugin readiness on Linux with Node.js 22 and 24. The repository’s [Actions page](https://github.com/hamza-paracha/vouch/actions/workflows/ci.yml) is the source for current CI status.
