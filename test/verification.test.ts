import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ModelBudget, budgetFromEnv, jevAdapter, selectControl, type CallRecord, type DecisionAdapter } from "../src/verify/routing.ts";
import { localTarget, verifyInputSchema } from "../src/verify/schema.ts";
import { verifyWorkflow } from "../src/verify/runtime.ts";
import { startVerificationFixture } from "./helpers/verification-fixture.ts";

const candidates = [{ role: "button" as const, name: "Save changes" }, { role: "button" as const, name: "Discard changes" }];
const decision = { model: "fake-jev", selected: 0, selectedProbability: 0.92, reportedConfidence: 0.6, inputTokens: 100, outputTokens: 10 };
const adapter: DecisionAdapter = { decide: async () => decision };

describe("verification routing and limits (no paid calls)", () => {
  it("rejects remote targets, credentials, broad write paths, unknown inputs and missing assertions", () => {
    for (const url of ["https://example.com", "http://localhost:4000", "http://127.0.0.1", "http://u:p@127.0.0.1:4000", "file:///etc/passwd"]) assert.throws(() => localTarget(url));
    const base = { url: "http://127.0.0.1:4000", steps: [{ kind: "assertText", text: "Ready" }] };
    assert.throws(() => verifyInputSchema.parse({ ...base, shell: "echo hi" }));
    assert.throws(() => verifyInputSchema.parse({ ...base, steps: [{ kind: "goto", path: "/" }] }));
    assert.throws(() => verifyInputSchema.parse({ ...base, allowedWritePaths: ["/save"] }));
    assert.throws(() => verifyInputSchema.parse({ ...base, confirmDisposable: true, allowedWritePaths: ["/api/*"] }));
    assert.throws(() => verifyInputSchema.parse({ ...base, steps: [...base.steps, { kind: "goto", path: "/" }] }));
    assert.throws(() => verifyInputSchema.parse({ ...base, steps: [{ kind: "goto", path: "//example.com" }] }));
  });

  it("routes an exact label without charging; abstains when even a sole control is ambiguous", async () => {
    const budget = new ModelBudget();
    const base = { candidates, adapter, budget, policy: "adaptive" as const, calls: [], step: 0, signal: new AbortController().signal };
    assert.equal((await selectControl({ ...base, intent: "Save changes" })).route, "rules");
    assert.equal(budget.usedCalls, 0);
    await assert.rejects(selectControl({ ...base, policy: "rules", candidates: [candidates[1]!], intent: "Save" }), /No unique exact/);
  });

  it("records probability and confidence separately, reserves failed attempts, and prevents budget bypass across runs", async () => {
    const budget = new ModelBudget(2, 0.02, 0.01);
    const calls: CallRecord[] = [];
    const base = { intent: "Persist profile", candidates, policy: "adaptive" as const, budget, calls, step: 0, signal: new AbortController().signal };
    assert.equal((await selectControl({ ...base, adapter })).route, "jev");
    assert.equal(calls[0]!.decision!.reportedConfidence, 0.6);
    await assert.rejects(selectControl({ ...base, adapter: { decide: async () => { throw new Error("provider unavailable"); } } }), /provider unavailable/);
    assert.equal(calls[1]!.outcome, "error");
    await assert.rejects(selectControl({ ...base, calls: [], adapter }), /limit reached/);
    assert.equal(budget.usedCalls, 2);
    assert.equal(budget.reservedUsd, 0.02);
  });

  it("abstains for low probability, none, NaN and invalid model choices", async () => {
    for (const d of [{ ...decision, selectedProbability: 0.79 }, { ...decision, selected: -1 }, { ...decision, selected: 10 }, { ...decision, selectedProbability: NaN }]) {
      await assert.rejects(selectControl({ intent: "Persist", candidates, policy: "adaptive", adapter: { decide: async () => d }, budget: new ModelBudget(1, 1, 1), calls: [], step: 0, signal: new AbortController().signal }), /Jev did not select/);
    }
  });

  it("fails closed on invalid budget config and disables SDK retries", async () => {
    for (const env of [{ VERIFY_JEV_MAX_CALLS: "NaN" }, { VERIFY_JEV_MAX_CALLS: "1" }, { VERIFY_JEV_MAX_CALLS: "-1" }]) assert.throws(() => budgetFromEnv(env));
    assert.throws(() => budgetFromEnv({ VERIFY_MODEL_MAX_CALLS: "1", VERIFY_MODEL_MAX_ESTIMATED_USD: "1", VERIFY_MODEL_ESTIMATE_PER_CALL_USD: "0.01", VERIFY_BUDGET_LEDGER: "relative.json" }), /absolute path/);
    let requests = 0;
    const client = new TypeSafeClient({ apiKey: "fake", logLevel: "off", retry: { maxRetries: 5 }, fetch: async () => { requests++; return new Response("unavailable", { status: 503 }); } });
    await assert.rejects(jevAdapter(client).decide("Persist", candidates, new AbortController().signal));
    assert.equal(requests, 1);
  });

  it("maps an actual SDK response and sends only intent and candidate labels", async () => {
    const client = new TypeSafeClient({ apiKey: "fake", logLevel: "off", fetch: async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      assert.deepEqual(Object.keys(request.state).sort(), ["intent", "untrustedCandidates"]);
      assert.equal(request.state.untrustedCandidates.length, 2);
      return Response.json({ model: "test-jev", answers: { next: { type: "choice", choice: "a0", confidence: 0.6, probabilities: { a0: 0.92, a1: 0.03, none: 0.05 } } }, usage: { input_tokens: 100, output_tokens: 10 } });
    } });
    assert.deepEqual(await jevAdapter(client).decide("Persist", candidates, new AbortController().signal), { ...decision, model: "test-jev" });
  });

  it("caps attempts per run even when the process budget permits more", async () => {
    const calls: CallRecord[] = [];
    const budget = new ModelBudget(10, 1, 0.01);
    const input = { intent: "Persist", candidates, policy: "adaptive" as const, adapter, budget, calls, step: 0, signal: new AbortController().signal };
    for (let i = 0; i < 3; i++) await selectControl(input);
    await assert.rejects(selectControl(input), /Per-run limit/);
    assert.equal(budget.usedCalls, 3);
  });
});

describe("verification in Chromium", () => {
  let directory: string;
  before(async () => { directory = await mkdtemp(join(tmpdir(), "verification-test-")); });
  after(async () => { await rm(directory, { recursive: true, force: true }); });
  const run = (input: unknown, options: Parameters<typeof verifyWorkflow>[1] = {}) => verifyWorkflow(input, { outputDir: directory, ...options });

  it("rejects a lying success toast, verifies persisted state after repair, and writes free replay evidence", async () => {
    for (const broken of [true, false]) {
      const fixture = await startVerificationFixture({ broken });
      try {
        const report = await run(fixture.workflow());
        assert.equal(report.status, broken ? "failed" : "passed", report.reason);
        assert.equal(report.steps[2]!.status, "passed", "The misleading toast really did pass");
        assert.equal(report.cost.attemptedCalls, 0);
        assert.equal(report.cost.providerReportedCostUsd, 0);
        const replay = JSON.parse(await readFile(report.artifacts.replay, "utf8"));
        assert.equal(replay.steps[1].kind, "click");
        assert.equal(replay.policy, "rules");
        assert.equal(JSON.parse(await readFile(report.artifacts.report, "utf8")).status, report.status);
        if (!broken) assert.equal((await run(replay)).status, "passed");
      } finally { await fixture.close(); }
    }
  });

  it("routes ambiguity to an injected adapter, then checks independently, with unknown provider cost", async () => {
    const fixture = await startVerificationFixture();
    try {
      const workflow = fixture.workflow();
      const step = workflow.steps[1]!;
      step.intent = "Persist the profile";
      const report = await run({ ...workflow, policy: "adaptive" }, { adapter, budget: new ModelBudget(1, 0.01, 0.01) });
      assert.equal(report.status, "passed", report.reason);
      assert.equal(report.steps[1]!.route, "jev");
      assert.equal(report.cost.providerReportedCostUsd, null);
      assert.equal(report.cost.inputTokens, 100);
      assert.equal(report.cost.estimatedReservedUsd, 0.01);
    } finally { await fixture.close(); }
  });

  it("blocks writes by default without reporting the application as passed", async () => {
    const fixture = await startVerificationFixture();
    try {
      const report = await run({ ...fixture.workflow(), allowedWritePaths: [], confirmDisposable: false });
      assert.equal(report.status, "abstained");
      assert.equal(fixture.writes, 0);
      assert.equal(report.blockedRequests[0]!.reason, "write-blocked");
    } finally { await fixture.close(); }
  });

  it("cancels an in-flight model attempt and preserves unknown usage and its budget reservation", async () => {
    const fixture = await startVerificationFixture();
    const controller = new AbortController();
    const slowAdapter: DecisionAdapter = { model: "test-slow", decide: async (_intent, _candidates, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled provider request")), { once: true });
        controller.abort();
      });
    } };
    try {
      const workflow = fixture.workflow();
      workflow.steps[1]!.intent = "Persist the profile";
      const report = await run({ ...workflow, policy: "adaptive" }, { adapter: slowAdapter, budget: new ModelBudget(1, 0.01, 0.01), signal: controller.signal });
      assert.equal(report.status, "cancelled");
      assert.equal(report.steps[1]!.route, "jev");
      assert.equal(report.cost.attemptedCalls, 1);
      assert.equal(report.cost.estimatedReservedUsd, 0.01);
      assert.equal(report.cost.providerReportedCostUsd, null);
      assert.equal(report.cost.inputTokens, null);
      assert.equal(fixture.writes, 0);
    } finally { await fixture.close(); }
  });

  it("fences redirects to another loopback port before they reach the destination", async () => {
    const outside = await startVerificationFixture();
    const fixture = await startVerificationFixture({ externalOrigin: outside.origin });
    try {
      const report = await run({ url: `${fixture.origin}/redirect`, steps: [{ kind: "assertText", text: "Ready" }] });
      assert.equal(report.status, "abstained", report.reason);
      assert.equal(outside.hits, 0);
      const json = await run({ url: `${fixture.origin}/case/a`, steps: [{ kind: "assertJson", path: "/redirect", field: [], equals: true }] });
      assert.equal(json.status, "failed");
      assert.equal(outside.hits, 0);
    } finally { await fixture.close(); await outside.close(); }
  });

  it("follows same-origin redirects and stops cancellation/deadlines with evidence", async () => {
    const fixture = await startVerificationFixture();
    try {
      const redirect = await run({ url: `${fixture.origin}/redirect`, steps: [{ kind: "assertText", text: "Ready" }] });
      assert.equal(redirect.status, "passed", redirect.reason);
      assert.equal(redirect.steps[0]!.observation!.url, `${fixture.origin}/case/redirected`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300);
      const cancelled = await run({ url: `${fixture.origin}/slow`, steps: [{ kind: "assertText", text: "Ready" }] }, { signal: controller.signal });
      clearTimeout(timer);
      assert.equal(cancelled.status, "cancelled");
      const timed = await run({ url: `${fixture.origin}/slow`, timeoutMs: 1000, stepTimeoutMs: 2000, steps: [{ kind: "assertText", text: "Ready" }] });
      assert.equal(timed.status, "timed_out", timed.reason);
      assert.ok(timed.durationMs < 4000);
    } finally { await fixture.close(); }
  });
});
