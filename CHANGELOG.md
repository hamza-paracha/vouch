# Changelog

## 0.3.0 — Change verification and browser foundations

- Added diff-aware JS/TS analysis, reverse-import test discovery, and bounded behavioral mutation runs in disposable repository copies.
- Added `analyze_change` and `verify_change` MCP tools and corresponding CLI commands, with baseline checks, repeated mutant failures, exact patches and local reports.
- Added HTTPS with upstream certificate validation, named cookie/localStorage session import, and URL, CSS selector and attribute assertions for multi-page same-origin flows.
- Fixed false network-settling timeouts when applications leave fetch bodies unread; genuinely streaming responses still abstain.
- Added deterministic demonstrations of weak tests surviving deliberate bugs and targeted regression tests detecting them. No model calls are required.

## 0.2.0 — Vouch alpha

- Renamed the product, CLI, MCP server and plugin to Vouch.

- Added `inspect_page` and `verify_workflow` MCP tools, plus CLI inspection and readiness checks.
- Added structured workflows, independent persisted-state assertions, evidence reports and rules-only replay files.
- Added deterministic → Jev → optional explicitly enabled stronger-model routing. All tiers share call and estimated-spend limits; provider costs remain unknown when not reported.
- Persisted paid-use reservations across restarts with a locked ledger. Tool inputs cannot raise limits or select models.
- Enforced HTTP origin and write-path restrictions at every redirect hop with a streaming proxy.
- Added candidate discovery, cancellation, deadlines, bounded state/provider responses, source fingerprints and compact MCP output.
- Added native Codex and Claude Code plugin manifests, a workflow skill and a self-contained local bundle build.
- Tested clean package installation, live Jev decisions, native client loading and a source-level persistence repair. See `docs/validation.md` for measured results and limits.

The original MIT-licensed browser-jev explorer and runner remain available.
