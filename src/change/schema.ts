import { z } from "zod";

export const changeInputSchema = z.object({ base: z.string().min(1).max(200).default("HEAD") }).strict();
export const changeExecutionSchema = changeInputSchema.extend({ confirmCodeExecution: z.literal(true) }).strict();
const command = z.array(z.string().min(1).max(2000)).min(1).max(50);
export const projectConfigSchema = z.object({
  testCommand: command,
  setupCommand: command.optional(),
  validationCommand: command.optional(),
  maxMutants: z.number().int().min(1).max(25).default(12),
  commandTimeoutMs: z.number().int().min(500).max(60_000).default(15_000),
  totalTimeoutMs: z.number().int().min(5000).max(600_000).default(180_000),
}).strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export interface ChangedFile { path: string; status: "modified" | "added" | "deleted"; ranges: { start: number; end: number }[] }
export interface Mutation {
  id: string; file: string; line: number; column: number; start: number; end: number;
  before: string; after: string; kind: string; symbol: string; suggestedTest: string;
}
export interface ChangePlan {
  schemaVersion: 1; baseCommit: string; snapshotHash: string; changedFiles: ChangedFile[];
  changedSymbols: { file: string; name: string; startLine: number; endLine: number }[];
  affectedFiles: string[]; affectedTests: string[]; unresolvedImports: string[];
  mutations: Mutation[]; candidateCount: number; gaps: string[]; limitations: string[];
}
