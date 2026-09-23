import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reviewChangeSchema, assessPrSchema, checkFileSchema } from "./schema.ts";
import { reviewCode, type ReviewOptions } from "./review.ts";
import { redact } from "../verify/redact.ts";

export function registerReviewTools(server: McpServer, options: ReviewOptions) {
  let busy = false;
  const definitions = [
    { name: "review_change", title: "Review a code diff with Jev", inputSchema: reviewChangeSchema, description: "Review changed files with Jev's structured questions about risk, breaking changes, tests, validation and error handling. Requires operator-configured project, provider and persistent budget. Sends scrubbed diff context to the model, never executes project code. Returns probabilities and advisory confidence bands, not a proof of correctness or merge authorization." },
    { name: "assess_pr", title: "Assess a pull request's scope and risks", inputSchema: assessPrSchema, description: "Review a branch diff per file and assess overall scope, split recommendations, security relevance and review urgency. One model request per file plus one summary request, within operator limits. No GitHub writes, code execution or automatic merging. Incomplete and uncertain evidence is explicit." },
    { name: "check_file", title: "Review one changed file", inputSchema: checkFileSchema, description: "Run one bounded Jev review of a repository-relative file's diff. One request with all structured questions. The configured root cannot be changed by callers. Secret/build paths and external symlinks are excluded. Model calls require an operator-enabled budget." },
  ] as const;
  for (const definition of definitions) {
    server.registerTool(definition.name, { title: definition.title, description: definition.description, inputSchema: definition.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, async (input: unknown, extra: { signal: AbortSignal }) => {
      if (busy) return { isError: true, content: [{ type: "text" as const, text: "A code review is already running." }] };
      busy = true;
      try {
        const signal = options.signal ? AbortSignal.any([options.signal, extra.signal]) : extra.signal;
        const report = await reviewCode(definition.name, input, { ...options, signal });
        return { isError: report.status !== "clean", structuredContent: { ...report }, content: [{ type: "text" as const, text: JSON.stringify(report) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: redact(error instanceof Error ? error.message : "Code review failed") }] };
      } finally { busy = false; }
    });
  }
}
