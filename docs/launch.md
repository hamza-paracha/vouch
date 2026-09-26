# proof-jev · Jev-powered code review and verification

## Release introduction

Your coding agent makes the change. proof-jev uses Jev to review it and returns evidence to help the agent verify the result.

Jev reviews each changed file for breaking behavior, risk, missing tests, error handling, input validation, side effects and merge readiness. The report keeps probabilities and uncertainty visible. Mutation checks expose tests that miss changed behavior, and browser workflows check visible outcomes and application state independently.

It runs through MCP or a CLI, with local plugin bundles for Codex and Claude Code. Jev review and optional browser decisions require an API key, explicit call limits and persistent reservations. Exact matches, browser assertions and mutation checks need no model. See the [Jev review setup](structured-review.md).

The alpha includes seven MCP tools and a standalone review package that needs no browser. A seeded missing-write bug was reproduced through the installed runtime, repaired in source, and verified against an independent disk read.

Try the free demonstration:

```sh
git clone https://github.com/hamza-paracha/proof-jev.git
cd proof-jev
npm ci
npx playwright install chromium
npm run verify:demo
```

Node.js 22+ required. Linux users may need `npx playwright install --with-deps chromium`.

This is an alpha for trusted repositories and controlled local HTTP(S) applications. OpenRouter routing is mock-tested only; broad accuracy and cost-saving claims have not been established. See [validation](validation.md) and [supported boundaries](verification.md#bounds-and-current-limits).

## Short announcement

Proof-Jev is an open-source project using Jev: Jev-powered code review for coding agents, backed by mutation checks, browser assertions and replayable evidence.

The demo catches a form that says “Saved” without saving, then verifies the working version. No API key required. MCP + CLI. Local Codex and Claude Code plugins. MIT licensed.

Try it: https://github.com/hamza-paracha/proof-jev
