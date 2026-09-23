import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReviewTools } from "./mcp.ts";
import { reviewOptionsFromEnv } from "./config.ts";
import { reviewCLI } from "./cli.ts";
import { readFileSync } from "node:fs";
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
try {
  const args = process.argv.slice(2);
  if (args[0] === "--stdio" && args.length === 1) {
    const server = new McpServer({ name: "vouch-review", version: VERSION });
    registerReviewTools(server, { ...reviewOptionsFromEnv(), signal: controller.signal });
    server.server.onclose = () => controller.abort();
    controller.signal.addEventListener("abort", () => { void server.close(); }, { once: true });
    await server.connect(new StdioServerTransport());
  } else if (args[0] === "--help") {
    process.stdout.write("Usage: vouch-guard --stdio | review|assess-pr|check-file --project <repo> [--base <ref>] [--file <path>]\nCode review only. No browser or project code execution. Models require explicit configuration.\n");
  } else {
    const { result, exitCode } = await reviewCLI([...(args[0] && ["review", "assess-pr", "check-file"].includes(args[0]) ? [] : ["review"]), ...args], controller.signal);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = exitCode;
  }
} catch (error) { process.stderr.write(`vouch-guard: ${error instanceof Error ? error.message : "Startup failed"}\n`); process.exitCode = 2; }
