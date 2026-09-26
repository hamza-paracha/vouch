import type { ChangePlan, Mutation } from "./schema.ts";
import type { CommandResult } from "./process.ts";

export interface MutationResult {
  mutation: Mutation; outcome: "detected" | "survived" | "invalid" | "inconclusive";
  runs: CommandResult[]; patch: string;
}
export interface ChangeReport {
  schemaVersion: 1; runId: string; status: "evidence_collected" | "gaps_found" | "baseline_failed" | "inconclusive" | "cancelled" | "error";
  reason: string; startedAt: string; durationMs: number; plan: ChangePlan;
  setup?: CommandResult; validation?: CommandResult; baseline: CommandResult[]; finalBaseline?: CommandResult;
  mutations: MutationResult[]; summary: { candidates: number; scheduled: number; tested: number; detected: number; survived: number; invalid: number; inconclusive: number; untested: number };
  artifacts: { report: string; markdown: string; plan: string }; limitations: string[];
}
const escape = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'");
export function markdownReport(report: ChangeReport) {
  const { summary: s } = report;
  return `# proof-jev change verification\n\n**${report.status}** — ${report.reason}\n\n` +
    `Snapshot: \`${report.plan.snapshotHash}\`  \nBase: \`${report.plan.baseCommit}\`\n\n` +
    `Detected: **${s.detected}** · Survived: **${s.survived}** · Inconclusive: **${s.inconclusive}** · Invalid: **${s.invalid}** · Untested candidates: **${s.untested}**\n\n` +
    `## Changed behavior and test reachability\n\n${report.plan.changedSymbols.map((s) => `- ${escape(s.file)}:${s.startLine} — ${escape(s.name)}`).join("\n") || "No changed callable symbols identified."}\n\n` +
    `Static affected tests: ${report.plan.affectedTests.map(escape).join(", ") || "none found"}. This is not measured coverage.\n\n` +
    `## Mutation evidence\n\n| Location | Change | Outcome | Suggested regression test |\n| --- | --- | --- | --- |\n` +
    report.mutations.map((m) => `| ${escape(m.mutation.file)}:${m.mutation.line} | ${escape(m.mutation.before)} → ${escape(m.mutation.after)} | ${m.outcome} | ${escape(m.mutation.suggestedTest)} |`).join("\n") +
    `\n\n## Gaps and limits\n\n${[...report.plan.gaps, ...report.limitations].map((s) => `- ${escape(s)}`).join("\n")}\n\nFull command output and exact mutant patches are in report.json and the patches directory. Surviving mutations identify a question for the agent to investigate, not proof of a production defect.\n`;
}
