import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { jevAdapter, ModelBudget } from "../src/verify/routing.ts";
import { verifyWorkflow } from "../src/verify/runtime.ts";
import { startVerificationFixture } from "../test/helpers/verification-fixture.ts";

if (process.argv[2] !== "--live") throw new Error("Pass --live to explicitly enable this three-call provider smoke test");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const budget = new ModelBudget(3, 0.01, 0.003, resolve("out/verification/live-smoke-ledger.json"));
const adapter = jevAdapter();
const results = [];
for (const scenario of [
  { name: "exact-match", broken: false, intent: "Save changes", expected: "passed" },
  { name: "semantic-choice", broken: false, intent: "Persist the updated profile", expected: "passed" },
  { name: "false-success", broken: true, intent: "Persist the updated profile", expected: "failed" },
  { name: "unrelated-intent", broken: false, intent: "Download my tax statement", expected: "abstained" },
]) {
  const fixture = await startVerificationFixture({ broken: scenario.broken });
  try {
    const input = fixture.workflow();
    input.steps[1]!.intent = scenario.intent;
    const report = await verifyWorkflow({ ...input, policy: "adaptive", stepTimeoutMs: 1500 }, { adapter, budget });
    results.push({ scenario: scenario.name, expected: scenario.expected, actual: report.status, matched: report.status === scenario.expected,
      reason: report.reason, cost: report.cost, calls: report.calls, report: report.artifacts.report });
  } finally { await fixture.close(); }
}
const tokens = results.every((r) => r.cost.inputTokens !== null) ? results.reduce((s, r) => s + r.cost.inputTokens!, 0) : null;
const summary = {
  suite: "live-smoke-v1", timestamp: new Date().toISOString(), results,
  totalCalls: budget.usedCalls, totalInputTokens: tokens,
  providerReportedCostUsd: null,
  estimatedTokenCostUsd: tokens !== null && results.every((r) => r.calls.every((c) => c.decision?.model === "jev-1.13.0")) ? tokens * 0.042 / 1_000_000 : null,
  pricingSource: "https://docs.typesafe.ai/models", inputUsdPerMillion: 0.042,
  note: "Small development smoke test, not a benchmark. Token-based cost estimate, not a provider invoice. Output tokens are free at the referenced rate.",
};
const path = resolve("out/verification/live-smoke.json");
await mkdir(resolve("out/verification"), { recursive: true });
await writeFile(path, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
if (results.some((r) => !r.matched)) process.exitCode = 1;
