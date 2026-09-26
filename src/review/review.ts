import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getDiff, type DiffHunk } from "./diff.ts";
import { fileRequest, prRequest, type ReviewRequest } from "./questions.ts";
import { decodeJudgment, type Judgment, type ReviewAdapter } from "./judge.ts";
import { reviewChangeSchema, assessPrSchema, checkFileSchema, thresholdsSchema, type ReviewAction, type Thresholds } from "./schema.ts";
import { ModelBudget, VerificationStop } from "../verify/routing.ts";
import { redact } from "../verify/redact.ts";

export interface ReviewOptions {
  projectRoot?: string; adapter?: ReviewAdapter; budget?: ModelBudget; signal?: AbortSignal; outputDir?: string;
  concurrency?: number; maxCallsPerRun?: number; thresholds?: Thresholds; inputPricePerMillion?: number;
}
export interface FileJudgment {
  file: string; status: "reviewed" | "error" | "budget_exhausted" | "cancelled"; judgment?: Judgment;
  truncated: boolean; durationMs: number; error?: string;
  evidence?: { scope: "file"; diffHash: string; previousFile?: string; hunks: DiffHunk[] };
}
export interface GuardReport {
  schemaVersion: 1; runId: string; action: ReviewAction; status: "clean" | "needs_attention" | "high_risk" | "error" | "budget_exhausted" | "cancelled";
  summary: string; base: string; snapshotHash: string; durationMs: number; files: FileJudgment[]; pr?: FileJudgment;
  totals: { filesChanged: number; filesReviewed: number; highConfidenceFlags: number; mediumConfidenceWarnings: number; lowConfidenceUncertain: number };
  incomplete: boolean; skipped: { file: string; reason: string }[]; limitations: string[];
  cost: { totalCalls: number; totalInputTokens: number | null; totalOutputTokens: number | null; totalEstimatedUsd: number | null; reservedEstimatedUsd: number; inputPricePerMillion: number | null; providerReportedCostUsd: null };
  artifacts: { report: string; markdown: string };
}
function markdown(report: GuardReport): string {
  const files = [...report.files, ...(report.pr ? [report.pr] : [])];
  const safe = (s: string) => s.replace(/[\r\n|`]/g, " ");
  const locations = (f: FileJudgment) => {
    if (!f.evidence) return "—";
    const ranges = f.evidence.hunks.flatMap(h => [...h.added.map(r => `+${r.start}${r.end === r.start ? "" : `–${r.end}`}`), ...h.deleted.map(r => `−${r.start}${r.end === r.start ? "" : `–${r.end}`} (base)`)]);
    return ranges.slice(0, 6).join(", ") + (ranges.length > 6 ? `; ${ranges.length - 6} more in JSON` : ranges.length ? "" : "metadata only");
  };
  return `# proof-jev structured code review\n\n**${report.status}** — ${report.summary}\n\nBase: ${report.base}\n\n` +
    `| File / scope | Changed lines | Result | Flags | Warnings | Uncertain |\n| --- | --- | --- | --- | --- | --- |\n` +
    files.map(f => `| ${safe(f.file)} | ${locations(f)} | ${f.status}${f.truncated ? " (partial context)" : ""} | ${f.judgment?.flags.join(", ") ?? ""} | ${f.judgment?.warnings.join(", ") ?? ""} | ${f.judgment?.uncertain.join(", ") ?? ""} |`).join("\n") +
    `\n\n${report.limitations.map(s => "- " + s).join("\n")}\n\nFull probabilities and usage are in report.json. This review does not execute tests or authorize a merge.\n`;
}
export async function reviewCode(action: ReviewAction, raw: unknown, options: ReviewOptions): Promise<GuardReport> {
  const input = action === "review_change" ? reviewChangeSchema.parse(raw) : action === "assess_pr" ? assessPrSchema.parse(raw) : checkFileSchema.parse(raw);
  if (!options.projectRoot) throw new Error("Set JEV_GUARD_PROJECT_ROOT or VOUCH_PROJECT_ROOT to a trusted Git repository");
  const thresholds = thresholdsSchema.parse(options.thresholds ?? { high: 0.9, medium: 0.7 });
  const concurrency = options.concurrency ?? 5, maxCalls = options.maxCallsPerRun ?? 12;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 20) throw new Error("Review concurrency must be 1–10 and per-run calls 1–20");
  const price = options.inputPricePerMillion ?? (options.adapter?.model === "jev-1.13.0" ? 0.042 : null);
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error("Invalid configured input-token price");
  const started = Date.now(); const deadline = AbortSignal.timeout(45_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const diff = await getDiff(options.projectRoot, input.base, signal, "file" in input ? [input.file] : "focus" in input ? input.focus : undefined);
  const runId = `review-${randomUUID()}`, directory = resolve(options.outputDir ?? "out/verification", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report: GuardReport = { schemaVersion: 1, runId, action, status: "error", summary: "Review did not complete", base: diff.base, snapshotHash: diff.snapshotHash, durationMs: 0,
    files: [], totals: { filesChanged: diff.totalFiles, filesReviewed: 0, highConfidenceFlags: 0, mediumConfidenceWarnings: 0, lowConfidenceUncertain: 0 },
    incomplete: diff.truncated, skipped: diff.skipped,
    limitations: ["Model judgments are advisory; no code, tests or browser workflows were executed.", "Confidence bands are not calibrated on this repository and do not authorize automatic merging.", "Changed-line evidence comes from Git. Model judgments cover a whole file and are not diagnoses of individual lines.", "Missing callers, tests or truncated context can hide defects. Secret scrubbing is not a comprehensive scanner.", "Latency is measured per run, not guaranteed; token cost is an estimate, not a provider invoice."],
    cost: { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedUsd: 0, reservedEstimatedUsd: 0, inputPricePerMillion: price, providerReportedCostUsd: null },
    artifacts: { report: join(directory, "report.json"), markdown: join(directory, "report.md") } };
  const budget = options.budget ?? new ModelBudget();
  let unknownUsage = false;
  const judge = async (file: string, request: ReviewRequest): Promise<FileJudgment> => {
    const start = Date.now();
    const item: FileJudgment = { file, status: "error", durationMs: 0, truncated: request.truncated };
    try {
      signal.throwIfAborted();
      if (!options.adapter) throw new Error("Jev review is disabled; explicitly configure the provider and a persistent call budget");
      if (report.cost.totalCalls >= maxCalls) throw new VerificationStop("budget_exhausted", "Per-review model call limit reached");
      const reservation = budget.reserve(); report.cost.totalCalls++; report.cost.reservedEstimatedUsd += reservation;
      try {
        const raw = await options.adapter.judge(request, signal);
        item.judgment = decodeJudgment(raw, request.questions, thresholds);
        if (options.inputPricePerMillion === undefined && item.judgment.model !== "jev-1.13.0") report.cost.inputPricePerMillion = null;
        report.cost.totalInputTokens! += item.judgment.usage.inputTokens; report.cost.totalOutputTokens! += item.judgment.usage.outputTokens;
        item.status = "reviewed";
      } catch (error) { unknownUsage = true; throw error; }
    } catch (error) {
      item.status = signal.aborted ? "cancelled" : error instanceof VerificationStop && error.status === "budget_exhausted" ? "budget_exhausted" : "error";
      // Provider/validation errors can embed source or secrets; don't surface raw response bodies.
      item.error = item.status === "cancelled" ? "Review cancelled or deadline reached" : item.status === "budget_exhausted" ? "Model call budget exhausted" : "Review failed or provider response was invalid; no retry was made";
    }
    item.durationMs = Date.now() - start; return item;
  };
  const jobs = diff.chunks.map(chunk => ({ file: chunk.file, request: fileRequest(chunk), evidence: { scope: "file" as const, diffHash: chunk.hash, ...(chunk.previousFile ? { previousFile: chunk.previousFile } : {}), hunks: chunk.hunks } }));
  let next = 0; const results: FileJudgment[] = new Array(jobs.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) { const index = next++; const job = jobs[index]!; results[index] = { ...await judge(job.file, job.request), evidence: job.evidence }; }
  }));
  report.files = results;
  if (action === "assess_pr" && diff.chunks.length) report.pr = await judge("<pull request>", prRequest(diff, "title" in input ? input.title : undefined, "description" in input ? input.description : undefined));
  const all = [...results, ...(report.pr ? [report.pr] : [])];
  report.incomplete ||= all.some(f => f.status !== "reviewed" || f.truncated);
  report.totals.filesReviewed = results.filter(f => f.status === "reviewed").length;
  for (const file of all) if (file.judgment) {
    report.totals.highConfidenceFlags += file.judgment.flags.length; report.totals.mediumConfidenceWarnings += file.judgment.warnings.length; report.totals.lowConfidenceUncertain += file.judgment.uncertain.length;
  }
  report.status = signal.aborted ? "cancelled" : all.some(f => f.status === "error") ? "error" : all.some(f => f.status === "budget_exhausted") ? "budget_exhausted"
    : all.some(f => f.judgment?.highRisk) ? "high_risk" : report.incomplete || report.totals.highConfidenceFlags || report.totals.mediumConfidenceWarnings || report.totals.lowConfidenceUncertain ? "needs_attention" : "clean";
  report.summary = diff.totalFiles === 0 ? "No changed files in the selected scope; no model review was performed"
    : `${report.totals.filesReviewed}/${diff.totalFiles} changed files reviewed; ${report.totals.highConfidenceFlags} flags, ${report.totals.mediumConfidenceWarnings} warnings, ${report.totals.lowConfidenceUncertain} uncertain judgments${report.incomplete ? "; incomplete evidence" : ""}`;
  if (unknownUsage) { report.cost.totalInputTokens = null; report.cost.totalOutputTokens = null; report.cost.totalEstimatedUsd = null; }
  else report.cost.totalEstimatedUsd = report.cost.totalCalls === 0 ? 0 : report.cost.inputPricePerMillion === null ? null : report.cost.totalInputTokens! * report.cost.inputPricePerMillion / 1_000_000;
  report.durationMs = Date.now() - started;
  const safe = redact(report);
  await Promise.all([writeFile(report.artifacts.report, JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 }), writeFile(report.artifacts.markdown, markdown(safe), { mode: 0o600 })]);
  return safe;
}
