import { readFile, stat } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVerificationServer } from "./mcp.ts";
import { budgetFromEnv, jevAdapter } from "./routing.ts";
import { verifyWorkflow } from "./runtime.ts";
import { escalationFromEnv } from "./escalation.ts";
import { doctor } from "./doctor.ts";
import { inspectLocalPage } from "./inspect.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const args = process.argv.slice(2);
  if (args[0] === "--doctor" && args.length === 1) {
    const result = doctor();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "ready" ? 0 : 2;
  } else if (args[0] === "--inspect" && args.length === 2) {
    const result = await inspectLocalPage({ url: args[1] }, controller.signal);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "inspected" ? 0 : 1;
  } else if (args.length !== 1 || args[0] === "--help") {
    process.stdout.write("Usage: vouch --stdio | --doctor | --inspect <url> | <workflow.json>\nDefault: rules only, no paid calls. See docs/verification.md.\n");
    process.exitCode = args[0] === "--help" ? 0 : 2;
  } else {
    const budget = budgetFromEnv(process.env);
    const options = {
      budget, adapter: budget.maxCalls > 0 ? jevAdapter() : undefined,
      strongerAdapter: budget.maxCalls > 0 ? escalationFromEnv(process.env) : undefined,
      outputDir: process.env.VERIFY_OUTPUT_DIR, signal: controller.signal,
    };
    if (args[0] === "--stdio") {
      const server = createVerificationServer(options);
      server.server.onclose = () => controller.abort();
      controller.signal.addEventListener("abort", () => { void server.close(); }, { once: true });
      await server.connect(new StdioServerTransport());
    } else {
      const file = args[0]!;
      if ((await stat(file)).size > 64_000) throw new Error("Workflow file exceeds 64 KB");
      const report = await verifyWorkflow(JSON.parse(await readFile(file, "utf8")), options);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  }
} catch (error) {
  process.stderr.write(`vouch: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 2;
}
