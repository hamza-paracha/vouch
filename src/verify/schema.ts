import { z } from "zod";

const text = z.string().min(1).max(300);
export const targetSchema = z.object({
  role: z.enum(["button", "link", "textbox", "checkbox", "combobox", "tab"]),
  name: text,
}).strict();
const path = z.string().min(1).max(1000).refine((s) => s.startsWith("/") && !s.startsWith("//") && !s.includes("\\"), "Use an absolute local path");
export const stepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), path }).strict(),
  z.object({ kind: z.literal("click"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("fill"), target: targetSchema, value: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal("choose"), intent: text, candidates: z.array(targetSchema).min(1).max(8).optional() }).strict(),
  z.object({ kind: z.literal("assertText"), text }).strict(),
  z.object({
    kind: z.literal("assertJson"), path,
    field: z.array(z.string().min(1).max(100)).max(10),
    equals: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
  }).strict(),
]);

export const verifyInputSchema = z.object({
  url: z.string().url().max(1000),
  steps: z.array(stepSchema).min(1).max(30),
  policy: z.enum(["rules", "adaptive"]).default("rules"),
  allowedWritePaths: z.array(path.refine((s) => !/[?#%*]/.test(s) && new URL(s, "http://local").pathname === s, "Use an exact canonical pathname")).max(10).default([]),
  confirmDisposable: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(45_000).default(30_000),
  stepTimeoutMs: z.number().int().min(100).max(10_000).default(3000),
}).strict().superRefine((input, ctx) => {
  if (!input.steps.some((s) => s.kind === "assertText" || s.kind === "assertJson")) {
    ctx.addIssue({ code: "custom", message: "Include at least one explicit assertion", path: ["steps"] });
  }
  const last = input.steps.at(-1);
  if (last && last.kind !== "assertText" && last.kind !== "assertJson") {
    ctx.addIssue({ code: "custom", message: "End the workflow with an assertion of its outcome", path: ["steps"] });
  }
  if (input.allowedWritePaths.length && !input.confirmDisposable) {
    ctx.addIssue({ code: "custom", message: "Writes require confirmDisposable: true", path: ["confirmDisposable"] });
  }
});

export type VerifyInput = z.infer<typeof verifyInputSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Target = z.infer<typeof targetSchema>;

/** Literal loopback only: no DNS lookup, credentials, remote host or inherited port scope. */
export function localTarget(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password) {
    throw new Error("Use http://127.0.0.1:<port> or http://[::1]:<port> for a disposable local app");
  }
  return url;
}

export function sameOrigin(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}
