# Proof-Jev improvement loop

Proof-Jev is an open-source project using Jev for structured code review, supported by executable mutation tests and real browser assertions. Keep these three capabilities together. The public presentation uses typography, examples, and measured results; do not restore the decorative hero illustration.

Each improvement pass should inspect current work and choose a concrete problem from the roadmap. Reproduce a defect or define a measurable outcome, implement a focused change, run the checks that exercise it, and review the resulting diff. Record what changed, its evidence, and the next useful step here. Keep uncommitted work from other tasks intact. Reuse a relevant open PR; avoid repeatedly creating duplicate changes.

Favor actual correctness, review quality, usable installation, useful evidence, and documented limits over feature count. Preserve existing command aliases and operator-configured budgets. Paid evaluations must use explicit bounded configurations with persistent ledgers; an exhausted ledger is not a reason to create an equivalent fresh one. Keep changes reviewable and do not automatically merge or publish releases.

## Prioritized next passes

1. Add independently labelled missing-context and adversarial-comment cases; keep labels grounded and report abstentions honestly. The initial eight-call baseline is complete, and its live budget is exhausted. Offline replay remains free.
2. Improve diff fidelity and edge-case handling, including unusual Git paths, deleted files, large changes, and snapshots that change during collection. Add regressions for demonstrated defects.
3. Make review evidence easier to act on: retain exact source locations for changed hunks and connect model concerns to the relevant bounded context without inventing model explanations.
4. Improve mutation test selection for aliases/frameworks and distinguish unexecuted mutations from assertions that genuinely miss a behavior.
5. Expand browser examples for session import, HTTPS, and multi-page persistence, with fresh-install validation.

## Completed passes

### September 26, 2026 — naming and measurable review quality

- Renamed the project to Proof-Jev with legacy CLI aliases and clean text presentation.
- Added eight regression/control fixtures, executable label checks, live evaluation, offline replay, and metrics for coverage, misses, false alarms, uncertainty, and probability error.
- Recorded a bounded eight-call Jev run: four regressions detected and four clean controls unflagged. This is limited synthetic evidence, not general accuracy or calibration validation.
- Validation: 151 automated tests, TypeScript, full and standalone fresh installs, legacy command aliases, and plugin/skill validators pass locally. CI also replays the real recorded answers without API calls.
- Next: broaden evaluation cases independently and improve diff evidence locations.
