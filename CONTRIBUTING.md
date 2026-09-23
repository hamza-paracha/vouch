# Contributing to Vouch

Reproducible bugs, clear documentation, and focused fixes are welcome. This is an alpha; help us make its supported local workflows dependable before widening its scope.

## Setup and checks

Use Node.js 22+ and npm:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run verify:demo
npm run verify:install
npm run verify:example
```

On Linux, install Chromium with `--with-deps`. These commands need no provider credentials. Do not add live paid calls to the default test suite or CI.

## Make a focused change

Explain the problem, the resulting behavior, and how you checked it. Add regression coverage for changes in behavior. Verifier code is in `src/verify/`; its tests are `test/verification*.test.ts`. The legacy explorer and runner remain in `src/` and have their own tests.

Changes to HTTP restrictions, write permissions, model routing, budgets, cancellation, or evidence handling need tests that exercise the relevant failure path. Keep models disabled by default; model output must never replace independent assertions or expand permissions. Never automatically refund uncertain paid requests or silently retry writes.

Run typechecking and the full test suite before submitting. Run `verify:install` when changing packaging, dependencies, CLI, or MCP behavior. Keep docs and examples aligned with shipped behavior.

## Reports that help

Include your commit/version, Node version, OS, a minimal disposable reproduction, expected outcome, and actual status/reason. Redact reports before sharing: accessibility observations can contain application data. Never upload `.env`, credentials, saved sessions, or a production data dump.

Report security vulnerabilities privately using [the security policy](SECURITY.md). Normal application failures found by the verifier belong in your application’s issue tracker.
