import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { evaluateReview } from "../src/review/evaluation.ts";
import { reviewOptionsFromEnv } from "../src/review/config.ts";

try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run review:eval -- [--live | --responses <recording.json>] [--output <directory>]\nDefault: validate labelled synthetic fixtures; no API calls. Live mode requires the usual explicit JEV_GUARD budget and provider environment.");
  } else {
    let live = false, responses: string | undefined, output = "out/review-evaluation";
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--live") live = true;
      else if (arg === "--responses" && args[i+1]) responses = args[++i];
      else if (arg === "--output" && args[i+1]) output = args[++i]!;
      else throw new Error("Unknown or incomplete option; use --help");
    }
    if (live && responses) throw new Error("Choose --live or --responses");
    const cases = JSON.parse(await readFile(new URL("../evals/review/cases.json", import.meta.url), "utf8"));
    const config = live ? reviewOptionsFromEnv() : undefined;
    if (live && (!config?.adapter || !config.budget?.ledgerPath)) throw new Error("Live evaluation requires an enabled provider and persistent JEV_GUARD budget");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    const report = await evaluateReview(cases, { adapter: config?.adapter, budget: config?.budget, thresholds: config?.thresholds,
      signal: controller.signal, ...(responses ? { replay: JSON.parse(await readFile(resolve(responses), "utf8")) } : {}) });
    const dir = resolve(output, randomUUID()); await mkdir(dir, { recursive: true, mode: 0o700 });
    const { replay, ...summary } = report;
    await writeFile(join(dir, "report.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    if (report.mode !== "dry_run") await writeFile(join(dir, "responses.json"), JSON.stringify(replay, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ ...summary, artifacts: { report: join(dir, "report.json"), ...(report.mode !== "dry_run" ? { responses: join(dir, "responses.json") } : {}) } }, null, 2));
    process.exitCode = report.mode === "dry_run" || report.complete ? 0 : 1;
  }
} catch (error) {
  // CLI validation errors are local; provider bodies never leave the evaluation runner.
  process.stderr.write(`proof-jev evaluation: ${error instanceof Error ? error.message : "Failed"}\n`); process.exitCode = 2;
}
