import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { evaluateReview, evaluationCasesSchema, evaluationRequest, evaluationSuiteHash } from "../src/review/evaluation.ts";
import { ModelBudget } from "../src/verify/routing.ts";
import type { Questions } from "@typesafe-ai/sdk";

const cases = evaluationCasesSchema.parse(JSON.parse(await readFile(new URL("../evals/review/cases.json", import.meta.url), "utf8")));
function response(questions: Questions, probabilities: Record<string, number> = {}) {
  return { model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 }, answers: Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === "noul") return [key, { type: "noul", noul: probabilities[key] ?? 0.05 }];
    if (q.type === "choice") { const keys = Object.keys(q.criteria); return [key, { type: "choice", choice: keys[0], confidence: 0.99, probabilities: Object.fromEntries(keys.map((k,i) => [k, i ? 0 : 1])) }]; }
    return [key, { type: "score", score: 0, confidence: 0.99, probabilities: Object.fromEntries(q.criteria.map((_,i) => [i, i ? 0 : 1])), legend: Object.fromEntries(q.criteria.map((label,i) => [i,label])) }];
  })) };
}
it("evaluation defaults to no calls and never exposes expected labels in model state", async () => {
  const result = await evaluateReview(cases);
  assert.equal(result.mode,"dry_run"); assert.equal(result.usage.calls,0); assert.equal(result.complete,false);
  assert.equal(result.metrics.expectedLabels,8); assert.equal(result.metrics.evaluatedLabels,0);
  assert.equal(result.metrics.accuracyAtHalf,null); assert.equal(result.metrics.brierScore,null);
  for (const c of cases) {
    const text = JSON.stringify(evaluationRequest(c));
    assert.ok(!text.includes(c.id)); assert.ok(!text.includes(c.labels[0]!.reason)); assert.ok(!text.includes('"labels"'));
  }
  assert.throws(() => evaluationCasesSchema.parse([...cases,cases[0]]), /Duplicate/);
});
it("evaluation reports actual misses, false alarms, uncertainty, and Brier score", async () => {
  const subset = cases.slice(0,4), p = [0.95,0.95,0.55,0.05];
  const replay = { suiteHash: evaluationSuiteHash(subset), responses: Object.fromEntries(subset.map((c,i) => [c.id,response(evaluationRequest(c).questions,{[c.labels[0]!.question]:p[i]!})])) };
  const result = await evaluateReview(subset,{replay});
  assert.equal(result.complete,true); assert.equal(result.usage.calls,0); assert.equal(result.metrics.coverage,1);
  assert.equal(result.metrics.accuracyAtHalf,0.75); assert.equal(result.metrics.uncertain,1);
  assert.deepEqual(result.metrics.actionable,{truePositive:1,falsePositive:1,trueNegative:1,falseNegative:1,precision:0.5,recall:0.5,falsePositiveRate:0.5});
  assert.ok(Math.abs(result.metrics.brierScore! - 0.2775) < 1e-10);
  assert.equal(result.metrics.confidenceBins[2]!.count,3); assert.equal(result.metrics.confidenceBins[2]!.accuracy,2/3);
});
it("missing and malformed recordings reduce coverage, and stale suites cannot be scored", async () => {
  const replay = { suiteHash: evaluationSuiteHash(cases), responses: {[cases[0]!.id]:response(evaluationRequest(cases[0]!).questions),[cases[1]!.id]:{invalid:true}} };
  const result = await evaluateReview(cases,{replay});
  assert.equal(result.complete,false); assert.equal(result.metrics.coverage,1/8);
  assert.equal(result.results.filter(r=>r.status==='missing').length,6); assert.equal(result.results[1]!.status,'error');
  await assert.rejects(evaluateReview(cases,{replay:{...replay,suiteHash:'stale'}}),/do not match/);
  await assert.rejects(evaluateReview(cases,{replay:{...replay,responses:{unknown:{}}}}),/unknown cases/);
});
it("live evaluation never retries failures or exceeds a shared budget; cancellation preserves reservations", async () => {
  let attempts=0;
  const budget = new ModelBudget(2,0.02,0.01);
  const result = await evaluateReview(cases,{budget,adapter:{model:'test',judge:async request=>{attempts++;if(attempts===1)throw new Error('private response');return response(request.questions);}}});
  assert.equal(attempts,2); assert.equal(budget.usedCalls,2); assert.equal(result.usage.calls,2);
  assert.equal(result.results.filter(r=>r.status==='budget_exhausted').length,6);
  assert.equal(result.usage.inputTokens,null); assert.equal(result.complete,false); assert.ok(!JSON.stringify(result).includes('private response'));
  const controller=new AbortController(), cancelledBudget=new ModelBudget(2,0.02,0.01);
  const cancelled=await evaluateReview(cases,{signal:controller.signal,budget:cancelledBudget,adapter:{model:'test',judge:async()=>{controller.abort();throw new Error('aborted');}}});
  assert.equal(cancelled.usage.calls,1);assert.equal(cancelled.results.filter(r=>r.status==='cancelled').length,8);assert.equal(cancelledBudget.usedCalls,1);
});
it("invalid oversized fixtures fail before any model calls", async () => {
  let calls=0;
  const oversized=[cases[0]!,{...cases[1]!,after:'/* comment */\n'.repeat(600)}];
  await assert.rejects(evaluateReview(oversized,{budget:new ModelBudget(2,1,0.01),adapter:{model:'test',judge:async request=>{calls++;return response(request.questions);}}}),/context bounds/);
  assert.equal(calls,0);
});
it("curated bug/control labels match executable JavaScript contracts", async () => {
  const load = (source: string) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const modules=await Promise.all(cases.map(c=>load(c.after)));
  assert.equal(modules[0]!.greet,undefined); assert.equal(modules[1]!.greet('Ada'),'Hello Ada');
  const db={insert:(value:unknown)=>value};
  assert.deepEqual(modules[2]!.order({quantity:-1},db),{quantity:-1}); assert.throws(()=>modules[3]!.order({quantity:-1},db),RangeError);
  assert.throws(()=>modules[4]!.preferences('{'),SyntaxError); assert.deepEqual(modules[5]!.preferences('{'),{});
  assert.equal(modules[6]!.identity(7).active,undefined); assert.deepEqual(modules[7]!.identity(7),{id:7,active:true});
});
it("evaluation CLI dry run works without provider credentials", () => {
  const output=execFileSync(process.execPath,['--import','tsx','scripts/evaluate-review.ts'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const result=JSON.parse(output);assert.equal(result.mode,'dry_run');assert.equal(result.usage.calls,0);assert.equal(result.metrics.expectedLabels,8);
});
