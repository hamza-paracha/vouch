import { createHash } from "node:crypto";
import { z } from "zod";
import { parseChunk, reviewPath } from "./diff.ts";
import { fileRequest } from "./questions.ts";
import { decodeJudgment, type Judgment, type ReviewAdapter } from "./judge.ts";
import { thresholdsSchema, type Thresholds } from "./schema.ts";
import { ModelBudget, VerificationStop } from "../verify/routing.ts";

const questionSchema = z.enum(["breaking_change", "needs_validation", "needs_error_handling"]);
export const evaluationCasesSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(100),
  file: z.string().max(300).refine(reviewPath, "Expected an eligible relative source path"),
  before: z.string().min(1).max(10000), after: z.string().min(1).max(10000),
  labels: z.array(z.object({ question: questionSchema, expected: z.boolean(), reason: z.string().min(1).max(1000) }).strict()).min(1).max(3),
}).strict()).min(1).max(20).superRefine((cases, ctx) => {
  if (new Set(cases.map(c => c.id)).size !== cases.length) ctx.addIssue({ code: "custom", message: "Duplicate case IDs" });
  for (const c of cases) if (new Set(c.labels.map(l => l.question)).size !== c.labels.length) ctx.addIssue({ code: "custom", message: "Duplicate case labels" });
});
export type EvaluationCase = z.infer<typeof evaluationCasesSchema>[number];
export function evaluationRequest(c: EvaluationCase) {
  const before = c.before.trimEnd().split("\n"), after = c.after.trimEnd().split("\n");
  // Full-file replacement gives both versions to the same production question builder.
  // Case IDs, expected labels, and grading explanations are never sent to the model.
  return fileRequest(parseChunk(c.file, "modified", `--- a/${c.file}\n+++ b/${c.file}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map(l => "-" + l).join("\n")}\n${after.map(l => "+" + l).join("\n")}\n`));
}
export function evaluationSuiteHash(cases: EvaluationCase[]) {
  return createHash("sha256").update(JSON.stringify(cases.map(c => ({ ...c, request: evaluationRequest(c) })))).digest("hex");
}
export interface Observation {
  caseId: string; question: string; expected: boolean; probabilityYes: number; correct: boolean;
  decision: "yes" | "no" | "uncertain"; reason: string;
}
export function evaluationMetrics(observations: Observation[], expectedLabels: number) {
  let truePositive = 0, falsePositive = 0, trueNegative = 0, falseNegative = 0;
  for (const o of observations) {
    if (o.decision === "yes") { if (o.expected) truePositive++; else falsePositive++; }
    else { if (o.expected) falseNegative++; else trueNegative++; }
  }
  const ratio = (a: number, b: number) => b ? a / b : null;
  return {
    expectedLabels, evaluatedLabels: observations.length, coverage: ratio(observations.length, expectedLabels),
    accuracyAtHalf: ratio(observations.filter(o => o.correct).length, observations.length),
    actionable: { truePositive, falsePositive, trueNegative, falseNegative,
      precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, truePositive + falseNegative),
      falsePositiveRate: ratio(falsePositive, falsePositive + trueNegative) },
    uncertain: observations.filter(o => o.decision === "uncertain").length,
    brierScore: observations.length ? observations.reduce((sum, o) => sum + (o.probabilityYes - Number(o.expected)) ** 2, 0) / observations.length : null,
    confidenceBins: [[0.5, 0.7], [0.7, 0.9], [0.9, 1.01]].map(([lower, upper]) => {
      const bin = observations.filter(o => { const c = Math.max(o.probabilityYes, 1 - o.probabilityYes); return c >= lower! && c < upper!; });
      return { lower: lower!, upper: Math.min(1, upper!), count: bin.length,
        averageConfidence: bin.length ? bin.reduce((s,o) => s + Math.max(o.probabilityYes, 1 - o.probabilityYes), 0) / bin.length : null,
        accuracy: ratio(bin.filter(o => o.correct).length, bin.length) };
    }),
  };
}
const replaySchema = z.object({ suiteHash: z.string(), responses: z.record(z.string(), z.unknown()) }).strict();
export async function evaluateReview(rawCases: unknown, options: {
  adapter?: ReviewAdapter; budget?: ModelBudget; replay?: unknown; signal?: AbortSignal; thresholds?: Thresholds;
} = {}) {
  const cases = evaluationCasesSchema.parse(rawCases), suiteHash = evaluationSuiteHash(cases);
  if (options.adapter && options.replay !== undefined) throw new Error("Choose live evaluation or recorded responses, not both");
  const replay = options.replay === undefined ? undefined : replaySchema.parse(options.replay);
  if (replay && replay.suiteHash !== suiteHash) throw new Error("Recorded responses do not match this fixture and question version");
  if (replay && Object.keys(replay.responses).some(id => !cases.some(c => c.id === id))) throw new Error("Recorded responses contain unknown cases");
  if (options.adapter && !options.budget) throw new Error("Live evaluation requires an explicit model budget");
  const thresholds = thresholdsSchema.parse(options.thresholds ?? { high: 0.9, medium: 0.7 });
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const requests = cases.map(c => {
    const request = evaluationRequest(c);
    if (request.truncated) throw new Error(`Evaluation fixture ${c.id} exceeds production context bounds`);
    return request;
  });
  const started = Date.now(), observations: Observation[] = [];
  const results: { id: string; status: "reviewed" | "dry_run" | "missing" | "error" | "budget_exhausted" | "cancelled"; durationMs: number; judgment?: Judgment }[] = [];
  const recordings: Record<string, unknown> = {};
  let calls = 0, reservedEstimatedUsd = 0, inputTokens = 0, outputTokens = 0, unknownUsage = false;
  for (const [index, c] of cases.entries()) {
    const start = Date.now(), request = requests[index]!;
    let status: typeof results[number]["status"] = "dry_run", judgment: Judgment | undefined;
    try {
      signal.throwIfAborted();
      let raw: unknown;
      if (replay) {
        if (!Object.hasOwn(replay.responses, c.id)) { results.push({ id: c.id, status: "missing", durationMs: 0 }); continue; }
        raw = replay.responses[c.id];
      } else if (options.adapter) {
        reservedEstimatedUsd += options.budget!.reserve(); calls++;
        try { raw = await options.adapter.judge(request, signal); judgment = decodeJudgment(raw, request.questions, thresholds); }
        catch (error) { unknownUsage = true; throw error; }
      } else { results.push({ id: c.id, status: "dry_run", durationMs: 0 }); continue; }
      judgment ??= decodeJudgment(raw, request.questions, thresholds);
      inputTokens += judgment.usage.inputTokens; outputTokens += judgment.usage.outputTokens;
      // Retain only the validated response fields, never arbitrary provider metadata or error bodies.
      const data = raw as { model: string; answers: unknown; usage: unknown };
      recordings[c.id] = { model: data.model, answers: data.answers, usage: { input_tokens: judgment.usage.inputTokens, output_tokens: judgment.usage.outputTokens } };
      for (const label of c.labels) {
        const verdict = judgment.verdicts[label.question]!, p = verdict.probabilities.yes!;
        observations.push({ caseId: c.id, question: label.question, expected: label.expected, probabilityYes: p,
          correct: (p >= 0.5) === label.expected, decision: verdict.level === "low_confidence" ? "uncertain" : p >= 0.5 ? "yes" : "no", reason: label.reason });
      }
      status = "reviewed";
    } catch (error) {
      status = signal.aborted ? "cancelled" : error instanceof VerificationStop ? "budget_exhausted" : "error";
    }
    results.push({ id: c.id, status, durationMs: Date.now() - start, ...(judgment ? { judgment } : {}) });
  }
  const mode = replay ? "replay" : options.adapter ? "live" : "dry_run";
  return { schemaVersion: 1, mode, suiteHash, durationMs: Date.now() - started, thresholds,
    complete: mode !== "dry_run" && results.every(r => r.status === "reviewed"), results, observations,
    metrics: evaluationMetrics(observations, cases.reduce((sum,c) => sum + c.labels.length, 0)),
    usage: { calls, reservedEstimatedUsd, inputTokens: unknownUsage ? null : inputTokens, outputTokens: unknownUsage ? null : outputTokens },
    replay: { suiteHash, responses: recordings },
    limitations: ["A small public synthetic suite measures these cases only; it does not establish repository-wide accuracy or calibration.",
      "Actionable positives require the configured medium confidence threshold. Uncertain positives count as missed detections, not successful reviews.",
      "Missing and failed cases reduce coverage; metrics describe observed labels only. Read coverage before comparing scores.",
      "Replay scores recorded answers without model calls. Dry runs validate fixtures and report no quality scores."] };
}
