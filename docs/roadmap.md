# vouch-jev implementation roadmap

The product has two complementary directions: make browser verification usable for real local apps, and inspect source changes deeply enough to expose weak tests. This tracks shipped implementations and remaining scope, not adoption or correctness claims.

## Current implementation

- [x] HTTPS loopback transport with per-request origin/write enforcement inside CONNECT; explicit CA trust or per-workflow self-signed opt-in.
- [x] Named session import: cookies/localStorage bound to an exact origin, owner-only profiles, values redacted from evidence.
- [x] Multi-page same-origin flows with redirects, secure cookies and URL assertions.
- [x] Selector existence/visibility/text and exact attribute assertions.
- [x] Settling based on completed proxy responses, including apps which leave fetch bodies unread.
- [x] Git diff snapshot and AST analysis of changed JavaScript/TypeScript functions.
- [x] Transitive import impact analysis and affected-test discovery.
- [x] Bounded mutation execution with baseline checks, fresh copies, repeated failures and concrete surviving-mutant evidence.
- [x] CLI and MCP access, plus a weak-tests → strengthened-tests demonstration.

## Structured review assessment implementation

- [x] Bounded multi-language Git diff reader: working changes, additions, deletions and renames.
- [x] Eight per-file Jev questions and four PR questions using the actual SDK primitive shapes.
- [x] Advisory confidence bands, validated distributions, explicit uncertainty and no automatic merging.
- [x] Persistent model budgets, bounded parallelism, no retries, deadlines and local evidence.
- [x] `review_change`, `assess_pr`, `check_file` via full vouch-jev and standalone Guard CLI/MCP.
- [x] Standalone package without Playwright or AST dependencies; client setup and honest limits documented.
- [x] Simulated-provider tests plus a bounded real-provider check of all three tools.
- [x] Ten-file latency measured at 638 ms in one live smoke run; broader performance is not guaranteed.

The combined vouch-jev server retains browser, mutation and structured review capabilities. Its standalone Guard package provides the code-only workflow. Repository-specific confidence calibration remains unproven; reports identify confidence provenance and uncertainty.

## Next depth improvements

- Runtime coverage to distinguish unexecuted mutations from weak assertions.
- Framework/alias-aware test selection and wider language support.
- Requirement-grounded test generation with reviewable expected behavior.
- Specification compliance and cross-file semantic analysis beyond import reachability.
- Held-out evaluation of model-assisted decisions; no claims of calibrated thresholds or general correctness until measured.

## Remaining browser/product work

- Explicitly scoped cross-origin flows and third-party login redirects (current navigation stays on one origin).
- WebSocket-dependent applications, visual assertions and screenshot baselines.
- Parallel workflow execution, watch mode and a reusable GitHub Action.
- HTML reports and configurable state polling.
- npm publication under an available package identity (GitHub distribution remains supported).
