# Vouch · v0.2.0 alpha

## Release introduction

A browser can say “Saved” while the application stores nothing.

Vouch gives coding agents a way to check the outcome: run the browser workflow, assert the visible result, read the application state independently, and return evidence the agent can use to fix the source.

It runs through MCP or a CLI, with local plugin bundles for Codex and Claude Code. Exact matches and assertions need no model. Optional Jev routing can resolve ambiguous controls, with explicit call limits and persistent reservations.

The first alpha includes accessible-control discovery, state assertions, structured reports, replay files, HTTP origin and write restrictions, cancellation, and installation checks. A seeded missing-write bug was reproduced through the installed runtime, repaired in source, and verified against an independent disk read.

Try the free demonstration:

```sh
git clone https://github.com/hamza-paracha/vouch.git
cd vouch
npm ci
npx playwright install chromium
npm run verify:demo
```

Node.js 22+ required. Linux users may need `npx playwright install --with-deps chromium`.

This is a local HTTP verification alpha. OpenRouter routing is mock-tested only; broad accuracy and cost-saving claims have not been established. See [validation](validation.md) and [supported boundaries](verification.md#bounds-and-current-limits).

## Short announcement

Vouch is open source: browser verification for coding agents, with independent state assertions and replayable evidence.

The demo catches a form that says “Saved” without saving, then verifies the working version. No API key required. MCP + CLI. Local Codex and Claude Code plugins. MIT licensed.

Try it: https://github.com/hamza-paracha/vouch

## Artwork

Use [the launch banner](assets/vouch-hero.png). It is conceptual artwork, not a screenshot. The [generation prompt](assets/README.md) is included.
