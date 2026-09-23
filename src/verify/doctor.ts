import { reviewOptionsFromEnv } from "../review/config.ts";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { budgetFromEnv } from "./routing.ts";
import { VERSION, runtimeFingerprint } from "./version.ts";

export function doctor(env: NodeJS.ProcessEnv = process.env) {
  const issues: string[] = [];
  if (Number(process.versions.node.split(".")[0]) < 22) issues.push("Node 22 or newer is required");
  if (!existsSync(chromium.executablePath())) issues.push("Chromium is missing; run npx playwright install chromium in the installed package directory");
  let modelCallsAllowed = 0;
  try {
    const budget = budgetFromEnv(env);
    modelCallsAllowed = Math.max(0, budget.maxCalls - budget.usedCalls);
    if (budget.maxCalls > 0 && !env.TYPESAFE_API_KEY) issues.push("Jev is enabled but TYPESAFE_API_KEY is missing");
    if (env.VERIFY_ESCALATION_MODEL && (env.VERIFY_ENABLE_ESCALATION !== "1" || !env.OPENROUTER_API_KEY)) issues.push("Escalation configuration is incomplete");
  } catch (error) { issues.push(error instanceof Error ? error.message : "Invalid budget configuration"); }
  let reviewCallsAllowed = 0;
  try { const review = reviewOptionsFromEnv(env); reviewCallsAllowed = Math.max(0, (review.budget?.maxCalls ?? 0) - (review.budget?.usedCalls ?? 0)); }
  catch (error) { issues.push(error instanceof Error ? error.message : "Invalid review configuration"); }
  return { status: issues.length ? "not_ready" : "ready", version: VERSION, node: process.version, chromiumInstalled: existsSync(chromium.executablePath()),
    runtimeFingerprint: runtimeFingerprint(), modelCallsAllowed, reviewCallsAllowed, issues, note: "Local checks only; no model calls and no credentials returned." };
}
