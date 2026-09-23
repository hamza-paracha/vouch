import { reviewCLI } from "../review/cli.ts";
import { reviewOptionsFromEnv } from "../review/config.ts";
import { changeCLI } from "../change/cli.ts";
import { importSession } from "./sessions.ts";
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
  const sessionOptions = { sessionDir: process.env.VOUCH_SESSION_DIR,
    tlsCA: process.env.VOUCH_TLS_CA_FILE ? await readFile(process.env.VOUCH_TLS_CA_FILE, "utf8") : undefined };
  if (["review", "assess-pr", "check-file"].includes(args[0] ?? "")) {
    const { result, exitCode } = await reviewCLI(args, controller.signal);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = exitCode;
  } else if (["analyze", "verify-change"].includes(args[0] ?? "")) {
    const { result, exitCode } = await changeCLI(args, controller.signal);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = exitCode;
  } else if (args[0] === "--import-session" && args.length === 5 && args[3] === "--origin") {
    process.stdout.write(JSON.stringify(await importSession(args[1]!, args[2]!, args[4]!, sessionOptions.sessionDir), null, 2) + "\n");
  } else if (args[0] === "--doctor" && args.length === 1) {
    const result = doctor();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "ready" ? 0 : 2;
  } else if (args[0] === "--inspect" && args.length === 2) {
    const result = await inspectLocalPage({ url: args[1] }, controller.signal, sessionOptions);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "inspected" ? 0 : 1;
  } else if (args.length !== 1 || args[0] === "--help") {
    process.stdout.write("Usage: vouch --stdio | --doctor | --inspect <url> | <workflow.json>\n       vouch analyze|verify-change [--project <repo>] [--base <commit>] [--allow-exec]\n       vouch --import-session <name> <state.json> --origin <url>\n       vouch review|assess-pr|check-file --project <repo> [--base <ref>] [--file <path>]\nDefault: rules only, no paid calls. See docs/verification.md.\n");
    process.exitCode = args[0] === "--help" ? 0 : 2;
  } else {
    const budget = budgetFromEnv(process.env);
    const options = {
      budget, adapter: budget.maxCalls > 0 ? jevAdapter() : undefined,
      strongerAdapter: budget.maxCalls > 0 ? escalationFromEnv(process.env) : undefined,
      outputDir: process.env.VERIFY_OUTPUT_DIR, signal: controller.signal, ...sessionOptions,
      projectRoot: process.env.VOUCH_PROJECT_ROOT, allowExecution: process.env.VOUCH_ALLOW_EXECUTION === "1",
    };
    if (args[0] === "--stdio") {
      const server = createVerificationServer({ ...options, review: reviewOptionsFromEnv() });
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
