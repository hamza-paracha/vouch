import assert from "node:assert/strict";
import { it } from "node:test";
import { escalationFromEnv, openRouterAdapter } from "../src/verify/escalation.ts";
import { selectControl, ModelBudget, type CallRecord, type DecisionAdapter } from "../src/verify/routing.ts";

const candidates = [{ role: "button" as const, name: "Save" }, { role: "button" as const, name: "Discard" }];
const unsure: DecisionAdapter = { model: "fake-jev", decide: async () => ({ model: "fake-jev", selected: 0, selectedProbability: 0.5, reportedConfidence: 0.7, inputTokens: 100, outputTokens: 2 }) };
const response = { model: "test/stronger", choices: [{ finish_reason: "stop", message: { content: '{"selected":"a0"}' } }], usage: { prompt_tokens: 200, completion_tokens: 7, cost: 0.001 } };

it("escalates only after uncertainty, accounts both attempts, and does not fabricate probabilities", async () => {
  let requests = 0;
  const stronger = openRouterAdapter("test/stronger", "fake", (async (_url, init) => {
    requests++;
    const payload = JSON.parse(init!.body as string);
    assert.equal(payload.provider.allow_fallbacks, false);
    assert.equal(payload.provider.require_parameters, true);
    assert.equal(payload.max_tokens, 128);
    assert.equal(payload.model, "test/stronger");
    return Response.json(response);
  }) as typeof fetch);
  const calls: CallRecord[] = [];
  const args = { intent: "Persist", candidates, policy: "adaptive" as const, adapter: unsure, strongerAdapter: stronger, budget: new ModelBudget(3, 0.03, 0.01), calls, step: 0, signal: new AbortController().signal };
  assert.equal((await selectControl(args)).route, "stronger");
  assert.equal(requests, 1);
  assert.deepEqual(calls.map((c) => c.tier), ["jev", "stronger"]);
  assert.equal(calls[1]!.providerReportedCostUsd, 0.001);
  assert.equal(calls[1]!.decision!.selectedProbability, null);
  assert.equal((await selectControl({ ...args, intent: "Save" })).route, "rules");
  assert.equal(requests, 1);
  await assert.rejects(selectControl({ ...args, calls: [], budget: new ModelBudget(1, 0.01, 0.01) }), /limit reached/);
  assert.equal(requests, 1, "An exhausted budget must not reach the stronger provider");
});

it("rejects unconfigured escalation, malformed/out-of-range responses, refusals and truncated output", async () => {
  assert.equal(escalationFromEnv({}), undefined);
  assert.throws(() => escalationFromEnv({ VERIFY_ESCALATION_MODEL: "test/model" }), /explicitly/);
  for (const content of ['{"selected":"a99"}', '{"selected":"a0","shell":"anything"}', "not json"]) {
    const adapter = openRouterAdapter("test/stronger", "fake", (async () => Response.json({ ...response, choices: [{ finish_reason: "stop", message: { content } }] })) as typeof fetch);
    await assert.rejects(adapter.decide("Persist", candidates, new AbortController().signal));
  }
  const truncated = openRouterAdapter("test/stronger", "fake", (async () => Response.json({ ...response, choices: [{ finish_reason: "length", message: { content: '{"selected":"a0"}' } }] })) as typeof fetch);
  await assert.rejects(truncated.decide("Persist", candidates, new AbortController().signal));
  const oversized = openRouterAdapter("test/stronger", "fake", (async () => new Response("x".repeat(65_000))) as typeof fetch);
  await assert.rejects(oversized.decide("Persist", candidates, new AbortController().signal), /exceeded/);
  const none = openRouterAdapter("test/stronger", "fake", (async () => Response.json({ ...response, choices: [{ finish_reason: "stop", message: { content: '{"selected":"none"}' } }] })) as typeof fetch);
  await assert.rejects(selectControl({ intent: "Persist", candidates, policy: "adaptive", adapter: unsure, strongerAdapter: none,
    budget: new ModelBudget(2, 0.02, 0.01), calls: [], step: 0, signal: new AbortController().signal }), /Both decision tiers abstained/);
});

it("does not retry provider failures or turn Jev transport failures into paid fallback calls", async () => {
  let requests = 0;
  const adapter = openRouterAdapter("test/stronger", "fake", (async () => { requests++; return new Response("no", { status: 503 }); }) as typeof fetch);
  await assert.rejects(adapter.decide("Persist", candidates, new AbortController().signal), /503/);
  assert.equal(requests, 1);
  await assert.rejects(selectControl({ intent: "Persist", candidates, policy: "adaptive", adapter: { decide: async () => { throw new Error("provider down"); } }, strongerAdapter: adapter,
    budget: new ModelBudget(3, 0.03, 0.01), calls: [], step: 0, signal: new AbortController().signal }), /provider down/);
  assert.equal(requests, 1);
});
