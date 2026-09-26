import { resolve } from "node:path";
import { reviewOptionsFromEnv } from "./config.ts";
import { reviewCode } from "./review.ts";
import type { ReviewAction } from "./schema.ts";

export async function reviewCLI(args: string[], signal: AbortSignal) {
  const action = ({ review: "review_change", "assess-pr": "assess_pr", "check-file": "check_file" } as Record<string, ReviewAction>)[args[0] ?? ""];
  if (!action) throw new Error("Unknown review command");
  const options = reviewOptionsFromEnv(); options.projectRoot ??= process.cwd();
  const input: Record<string, unknown> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" && args[i+1]) { options.projectRoot = resolve(args[++i]!); continue; }
    if (["--base", "--title", "--description", "--file"].includes(arg) && args[i+1]) { input[arg.slice(2)] = args[++i]!; continue; }
    if (arg === "--focus" && args[i+1]) { input.focus = [...(input.focus as string[] ?? []), args[++i]!]; continue; }
    throw new Error("Usage: proof-jev review|assess-pr|check-file --project <repo> [--base <ref>] [--file <path>] [--focus <path>]");
  }
  const result = await reviewCode(action, input, { ...options, signal });
  return { result, exitCode: result.status === "clean" ? 0 : ["error", "budget_exhausted", "cancelled"].includes(result.status) ? 2 : 1 };
}
