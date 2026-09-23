import { resolve } from "node:path";
import { analyzeChange } from "./analyze.ts";
import { verifyChange } from "./verify.ts";

export async function changeCLI(args: string[], signal: AbortSignal) {
  const action = args[0]; let projectRoot = process.env.VOUCH_PROJECT_ROOT ?? process.cwd(), base = "HEAD", allowExecution = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-exec") { allowExecution = true; continue; }
    if ((arg === "--base" || arg === "--project") && args[i + 1] && !args[i + 1]!.startsWith("--")) {
      const value = args[++i]!; if (arg === "--base") base = value; else projectRoot = value; continue;
    }
    throw new Error("Usage: vouch analyze|verify-change [--project <repository>] [--base <commit>] [--allow-exec]");
  }
  projectRoot = resolve(projectRoot);
  if (action === "analyze") return { exitCode: 0, result: await analyzeChange({ base }, projectRoot, signal) };
  const result = await verifyChange({ base, confirmCodeExecution: true }, { projectRoot, allowExecution, signal, outputDir: process.env.VERIFY_OUTPUT_DIR });
  return { exitCode: result.status === "evidence_collected" ? 0 : 1, result };
}
