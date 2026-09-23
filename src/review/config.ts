import { TypeSafeClient } from "@typesafe-ai/sdk";
import { isAbsolute } from "node:path";
import { ModelBudget } from "../verify/routing.ts";
import { jevReviewAdapter } from "./judge.ts";
import { thresholdsSchema } from "./schema.ts";
import type { ReviewOptions } from "./review.ts";

export function reviewOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewOptions {
  const calls = Number(env.JEV_GUARD_MAX_CALLS ?? 0);
  const ledger = env.JEV_GUARD_BUDGET_LEDGER;
  if (calls > 0 && (!ledger || !isAbsolute(ledger))) throw new Error("Enabled code review requires an absolute JEV_GUARD_BUDGET_LEDGER");
  if (calls > 0 && !env.TYPESAFE_API_KEY) throw new Error("Jev code review is enabled but TYPESAFE_API_KEY is missing");
  const budget = new ModelBudget(calls, Number(env.JEV_GUARD_MAX_ESTIMATED_USD ?? 0), Number(env.JEV_GUARD_ESTIMATE_PER_CALL_USD ?? 0), ledger);
  return { projectRoot: env.JEV_GUARD_PROJECT_ROOT ?? env.VOUCH_PROJECT_ROOT, budget,
    adapter: calls > 0 ? jevReviewAdapter(env.JEV_GUARD_MODEL ?? "jev-1.13.0", new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, baseURL: env.TYPESAFE_BASE_URL, defaultModel: env.JEV_GUARD_MODEL ?? "jev-1.13.0", retry: { maxRetries: 0 }, timeout: 8000, logLevel: "off" })) : undefined,
    thresholds: thresholdsSchema.parse({ high: Number(env.JEV_GUARD_THRESHOLD_HIGH ?? 0.9), medium: Number(env.JEV_GUARD_THRESHOLD_MEDIUM ?? 0.7) }),
    concurrency: Number(env.JEV_GUARD_CONCURRENCY ?? 5), maxCallsPerRun: Number(env.JEV_GUARD_MAX_CALLS_PER_RUN ?? 12),
    ...(env.JEV_GUARD_INPUT_PRICE_PER_MILLION ? { inputPricePerMillion: Number(env.JEV_GUARD_INPUT_PRICE_PER_MILLION) } : {}),
    outputDir: env.VERIFY_OUTPUT_DIR };
}
