import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { Thresholds } from "./schema.ts";
import type { ReviewRequest } from "./questions.ts";

export interface ReviewAdapter { model: string; judge(request: ReviewRequest, signal: AbortSignal): Promise<unknown> }
export function jevReviewAdapter(model = process.env.JEV_GUARD_MODEL ?? "jev-1.13.0", client = new TypeSafeClient({ defaultModel: model, retry: { maxRetries: 0 }, timeout: 8000, logLevel: "off" })): ReviewAdapter {
  return { model, judge: (request, signal) => client.systemOne({ model, state: request.state, questions: request.questions }, { signal, retry: { maxRetries: 0 }, timeout: 8000 }) };
}
const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }).strict(),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities }).strict(),
  z.object({ type: z.literal("score"), score: z.number().finite(), confidence: probability, probabilities, legend: z.record(z.string(), z.unknown()) }).strict(),
]);
const response = z.object({ model: z.string().min(1).max(200), answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }) });
export interface Verdict {
  question: string; type: "noul" | "choice" | "score"; answer: string | boolean | number; confidence: number;
  confidenceSource: "selected_probability" | "provider_reported";
  level: "high_confidence" | "medium_confidence" | "low_confidence"; probabilities: Record<string, number>;
}
export interface Judgment {
  model: string; verdicts: Record<string, Verdict>; flags: string[]; warnings: string[]; uncertain: string[]; highRisk: boolean;
  usage: { inputTokens: number; outputTokens: number };
}
export function decodeJudgment(raw: unknown, questions: Questions, thresholds: Thresholds): Judgment {
  const data = response.parse(raw);
  const result: Judgment = { model: data.model, verdicts: {}, flags: [], warnings: [], uncertain: [], highRisk: false,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
  if (Object.keys(data.answers).sort().join("\0") !== Object.keys(questions).sort().join("\0")) throw new Error("Model response has missing or unexpected questions");
  for (const [key, question] of Object.entries(questions)) {
    const item = data.answers[key]!;
    if (item.type !== question.type) throw new Error("Model response type does not match its question");
    let value: Verdict["answer"], confidence: number, distribution: Record<string, number>;
    if (item.type === "noul") {
      value = item.noul >= 0.5; confidence = Math.max(item.noul, 1 - item.noul); distribution = { yes: item.noul, no: 1 - item.noul };
    } else {
      const expected = question.type === "choice" ? Object.keys(question.criteria) : question.type === "score" ? question.criteria.map((_, i) => String(i)) : [];
      distribution = item.probabilities;
      if (Object.keys(distribution).sort().join("\0") !== expected.sort().join("\0") || Math.abs(Object.values(distribution).reduce((a,b) => a+b,0) - 1) > 0.02)
        throw new Error("Invalid model probability distribution");
      confidence = item.confidence;
      if (item.type === "choice") {
        if (!expected.includes(item.choice)) throw new Error("Model selected an unknown option");
        value = item.choice;
      } else {
        const mean = Object.entries(distribution).reduce((sum, [index, p]) => sum + Number(index) * p, 0);
        if (item.score < 0 || item.score > expected.length - 1 || Math.abs(item.score - mean) > 0.05) throw new Error("Inconsistent expected score");
        value = item.score;
      }
    }
    const level = confidence >= thresholds.high ? "high_confidence" : confidence >= thresholds.medium ? "medium_confidence" : "low_confidence";
    result.verdicts[key] = { question: key, type: item.type, answer: value, confidence, confidenceSource: item.type === "noul" ? "selected_probability" : "provider_reported", level, probabilities: distribution };
    const concern = key === "ready_to_merge" ? value === false
      : key === "risk_level" || key === "review_urgency" ? typeof value === "number" && value >= 2
      : key === "pr_scope" ? value !== "single_concern" : key === "change_type" ? value === "security" : value === true;
    if (level === "low_confidence") result.uncertain.push(key);
    else if (concern) (level === "high_confidence" ? result.flags : result.warnings).push(key);
    if (concern && level === "high_confidence" && ["breaking_change", "risk_level", "review_urgency", "security_relevant", "change_type"].includes(key)) result.highRisk = true;
  }
  return result;
}
