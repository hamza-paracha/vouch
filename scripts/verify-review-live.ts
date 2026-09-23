import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { changeFixture } from "../test/helpers/change-fixture.ts";
import type { GuardReport } from "../src/review/review.ts";

if (process.argv[2] !== "--live") throw new Error("Pass --live to run the explicitly bounded 13-call code-review check");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const fixture = await changeFixture();
const output = resolve("out/review-live"); await mkdir(output, { recursive: true, mode: 0o700 });
const client = new Client({ name: "vouch-review-live-check", version: "1" });
const results: { tool: string; report: GuardReport; wallMs: number }[] = [];
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/guard.mjs"), "--stdio"], stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      JEV_GUARD_PROJECT_ROOT: fixture.root, JEV_GUARD_MODEL: "jev-1.13.0", JEV_GUARD_MAX_CALLS: "13", JEV_GUARD_MAX_CALLS_PER_RUN: "12",
      JEV_GUARD_MAX_ESTIMATED_USD: "0.02", JEV_GUARD_ESTIMATE_PER_CALL_USD: "0.0015", JEV_GUARD_CONCURRENCY: "5",
      JEV_GUARD_BUDGET_LEDGER: join(output, "ledger.json"), VERIFY_OUTPUT_DIR: output } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["review_change", "assess_pr", "check_file"]);
  const run = async (tool: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const report = result.structuredContent as unknown as GuardReport;
    assert.ok(report?.schemaVersion === 1, JSON.stringify(result));
    results.push({ tool, report, wallMs: Date.now() - started });
    assert.ok(!["error", "cancelled", "budget_exhausted"].includes(report.status), report.summary);
    assert.equal(report.incomplete, false);
    return report;
  };
  await run("check_file", { file: "src/pricing.mjs" });
  await run("assess_pr", { base: "HEAD", title: "Include exactly 50 in free shipping", description: "The public threshold is inclusive; existing tests omit equality." });
  for (let i = 0; i < 9; i++) await writeFile(join(fixture.root, `src/example-${i}.mjs`), `export function eligible(value) { return value >= ${i + 1}; }\n`);
  const ten = await run("review_change", { base: "HEAD" });
  assert.equal(ten.totals.filesReviewed, 10); assert.equal(ten.cost.totalCalls, 10);
} finally {
  await client.close(); await fixture.close();
  const summary = { recordedAt: new Date().toISOString(), suite: "structured-review-live-v1", syntheticRepositoryOnly: true,
    results: results.map(({ tool, report, wallMs }) => ({ tool, status: report.status, wallMs, filesReviewed: report.totals.filesReviewed,
      totals: report.totals, cost: report.cost, report: report.artifacts.report })),
    calls: results.reduce((sum, r) => sum + r.report.cost.totalCalls, 0),
    tenFileUnderTwoSeconds: results.find(r => r.tool === "review_change") ? results.find(r => r.tool === "review_change")!.wallMs < 2000 : null,
    note: "Provider integration smoke test, not accuracy or calibration evidence. Latency includes MCP and Git processing; a single measurement is not an SLA. Persistent reservations are never reset by this script." };
  await writeFile(join(output, "results.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
}
