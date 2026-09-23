import { constants } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { snapshotRepository } from "./repository.ts";
import { analyzeSnapshot } from "./analyze.ts";
import { changeExecutionSchema, projectConfigSchema, type Mutation } from "./schema.ts";
import { runCommand } from "./process.ts";
import { markdownReport, type ChangeReport } from "./report.ts";
import { redact } from "../verify/redact.ts";

export interface ChangeOptions { projectRoot?: string; allowExecution?: boolean; outputDir?: string; signal?: AbortSignal }

export function mutationPatch(m: Mutation, source: string) {
  const updated = source.slice(0, m.start) + m.after + source.slice(m.end);
  const lines = (text: string) => text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const before = lines(source), after = lines(updated);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  const start = Math.max(0, prefix - 3), tail = Math.max(0, suffix - 3);
  const out = [`--- ${JSON.stringify("a/" + m.file)}`, `+++ ${JSON.stringify("b/" + m.file)}`,
    `@@ -${start + 1},${before.length - start - tail} +${start + 1},${after.length - start - tail} @@`];
  const emit = (mark: string, value: string, noNewline: boolean) => {
    out.push(mark + value); if (noNewline) out.push("\\ No newline at end of file");
  };
  for (let i = start; i < prefix; i++) emit(" ", before[i]!, false);
  for (let i = prefix; i < before.length - suffix; i++) emit("-", before[i]!, i === before.length - 1 && !source.endsWith("\n"));
  for (let i = prefix; i < after.length - suffix; i++) emit("+", after[i]!, i === after.length - 1 && !updated.endsWith("\n"));
  for (let i = before.length - suffix; i < before.length - tail; i++) emit(" ", before[i]!, i === before.length - 1 && !source.endsWith("\n"));
  return out.join("\n") + "\n";
}

export async function verifyChange(raw: unknown, options: ChangeOptions): Promise<ChangeReport> {
  const input = changeExecutionSchema.parse(raw);
  if (!options.projectRoot || !options.allowExecution) throw new Error("Change execution is disabled. Configure VOUCH_PROJECT_ROOT and VOUCH_ALLOW_EXECUTION=1 for this trusted repository.");
  const snapshot = await snapshotRepository(options.projectRoot, input.base, options.signal);
  const configData = snapshot.files.get("vouch.config.json");
  if (!configData) throw new Error("Add vouch.config.json with an explicit testCommand before running change verification");
  const config = projectConfigSchema.parse(JSON.parse(configData.toString()));
  const plan = analyzeSnapshot(snapshot);
  const started = Date.now(); const runId = `change-${randomUUID()}`;
  const directory = resolve(options.outputDir ?? "out/verification", runId); await mkdir(join(directory, "patches"), { recursive: true, mode: 0o700 });
  const deadline = AbortSignal.timeout(config.totalTimeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const report: ChangeReport = { schemaVersion: 1, runId, status: "inconclusive", reason: "Verification did not complete", startedAt: new Date(started).toISOString(), durationMs: 0,
    plan, baseline: [], mutations: [], summary: { candidates: plan.candidateCount, scheduled: 0, tested: 0, detected: 0, survived: 0, invalid: 0, inconclusive: 0, untested: plan.candidateCount },
    artifacts: { report: join(directory, "report.json"), markdown: join(directory, "report.md"), plan: join(directory, "plan.json") },
    limitations: [...plan.limitations, "Commands execute trusted repository code in disposable copies, not an OS security sandbox.", "Two baseline runs and repeated failing mutants reduce, but cannot eliminate, nondeterminism.", "Only configured commands ran; no claim of whole-program correctness or runtime coverage is made."] };
  const workspace = await mkdtemp(join(tmpdir(), "vouch-change-")); const template = join(workspace, "template");
  const command = (args: string[]) => args.flatMap((arg) => {
    if (arg !== "$VOUCH_TEST_FILES") return [arg];
    if (!plan.affectedTests.length) throw new Error("No affected tests for $VOUCH_TEST_FILES; configure a full test command instead");
    return plan.affectedTests;
  });
  const run = async (args: string[], cwd: string) => runCommand(command(args), cwd, Math.min(config.commandTimeoutMs, Math.max(1, config.totalTimeoutMs - (Date.now() - started))), signal);
  const fresh = async (name: string) => { signal.throwIfAborted(); const path = join(workspace, name); await cp(template, path, { recursive: true, mode: constants.COPYFILE_FICLONE }); signal.throwIfAborted(); return path; };
  try {
    await mkdir(template, { recursive: true });
    for (const [name, data] of snapshot.files) { signal.throwIfAborted(); const path = join(template, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data, { mode: snapshot.modes.get(name) ?? 0o644 }); }
    if (config.setupCommand) {
      report.setup = await run(config.setupCommand, template);
      if (report.setup.outcome !== "passed") { report.reason = "Setup did not pass; no mutations executed"; return await finish(); }
      for (const [name, data] of snapshot.files) if (!(await readFile(join(template, name))).equals(data)) throw new Error("Setup changed a captured source file; use a setup command that only prepares dependencies");
    }
    if (config.validationCommand) {
      const path = await fresh("validation"); report.validation = await run(config.validationCommand, path); await rm(path, { recursive: true, force: true });
      if (report.validation.outcome !== "passed") { report.status = "baseline_failed"; report.reason = "Unmodified snapshot failed validation"; return await finish(); }
    }
    for (let n = 0; n < 2; n++) {
      const path = await fresh(`baseline-${n}`); const result = await run(config.testCommand, path); report.baseline.push(result); await rm(path, { recursive: true, force: true });
      if (result.outcome !== "passed") { report.status = result.outcome === "failed" && n === 0 ? "baseline_failed" : "inconclusive"; report.reason = n ? "Baseline is unstable or incomplete" : "Unmodified snapshot did not pass the configured tests"; return await finish(); }
    }
    // Spread a bounded sample across files, rather than letting the first large file consume it.
    const groups = new Map<string, Mutation[]>();
    for (const m of plan.mutations) { const group = groups.get(m.file) ?? []; group.push(m); groups.set(m.file, group); }
    const selected: Mutation[] = [];
    while (selected.length < config.maxMutants) { let added = false; for (const group of groups.values()) { const m = group.shift(); if (m && selected.length < config.maxMutants) { selected.push(m); added = true; } } if (!added) break; }
    report.summary.scheduled = selected.length;
    for (const m of selected) {
      signal.throwIfAborted();
      const source = snapshot.files.get(m.file)!.toString();
      const patch = join(directory, "patches", `${m.id}.diff`); await writeFile(patch, mutationPatch(m, source), { mode: 0o600 });
      const result: ChangeReport["mutations"][number] = { mutation: m, outcome: "inconclusive", runs: [], patch }; report.mutations.push(result);
      for (let attempt = 0; attempt < 2; attempt++) {
        const path = await fresh(`${m.id}-${attempt}`);
        try {
          await writeFile(join(path, m.file), source.slice(0, m.start) + m.after + source.slice(m.end));
          if (config.validationCommand) {
            const validation = await run(config.validationCommand, path);
            if (validation.outcome !== "passed") { result.runs.push(validation); result.outcome = validation.outcome === "failed" ? "invalid" : "inconclusive"; break; }
          }
          const test = await run(config.testCommand, path); result.runs.push(test);
          if (test.outcome === "passed") { result.outcome = attempt === 0 ? "survived" : "inconclusive"; break; }
          if (test.outcome !== "failed") break;
          if (attempt === 1) result.outcome = "detected";
        } finally { await rm(path, { recursive: true, force: true }); }
      }
    }
    if (selected.length) {
      const path = await fresh("final-baseline"); report.finalBaseline = await run(config.testCommand, path); await rm(path, { recursive: true, force: true });
      if (report.finalBaseline.outcome !== "passed") { report.status = "inconclusive"; report.reason = "Final baseline did not pass; mutation conclusions require investigation"; return await finish(); }
    }
    if (report.mutations.some((m) => m.outcome === "survived")) { report.status = "gaps_found"; report.reason = "Tests passed with deliberate behavioral changes; investigate surviving mutations"; }
    else if (!report.mutations.length || report.mutations.some((m) => m.outcome !== "detected")) { report.status = "inconclusive"; report.reason = "No complete mutation evidence for this change"; }
    else { report.status = "evidence_collected"; report.reason = "Configured tests detected every sampled mutation; review unsampled changes and limitations"; }
  } catch (error) {
    report.status = options.signal?.aborted ? "cancelled" : signal.aborted ? "inconclusive" : "error";
    report.reason = signal.aborted ? "Change verification cancelled or total time limit exhausted" : error instanceof Error ? error.message : "Change verification failed";
  } finally { await rm(workspace, { recursive: true, force: true }); }
  return finish();

  async function finish() {
    // Early returns still pass through the workspace cleanup above.
    if (options.signal?.aborted) report.status = "cancelled";
    else if (deadline.aborted) report.status = "inconclusive";
    const outcomes = report.mutations.map((m) => m.outcome);
    Object.assign(report.summary, { tested: outcomes.length, detected: outcomes.filter((o) => o === "detected").length,
      survived: outcomes.filter((o) => o === "survived").length, invalid: outcomes.filter((o) => o === "invalid").length,
      inconclusive: outcomes.filter((o) => o === "inconclusive").length, untested: Math.max(0, plan.candidateCount - outcomes.length) });
    report.durationMs = Date.now() - started;
    const safe = redact(report);
    await Promise.all([writeFile(safe.artifacts.report, JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 }),
      writeFile(safe.artifacts.plan, JSON.stringify(safe.plan, null, 2) + "\n", { mode: 0o600 }),
      writeFile(safe.artifacts.markdown, markdownReport(safe), { mode: 0o600 })]);
    return safe;
  }
}
