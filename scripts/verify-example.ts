import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const label = process.argv[2] ?? "current";
if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error("Use a short lowercase label");
const directory = resolve("out/acceptance", label);
await mkdir(directory, { recursive: true });
const dataFile = join(directory, "profile.json");
await writeFile(dataFile, '{"displayName":"Original"}\n');
const source = resolve("examples/profile-app/server.mjs");
await copyFile(source, join(directory, "app-source.mjs"));
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const app = spawn(process.execPath, [source], { env: { ...env, PORT: "0", DATA_FILE: dataFile }, stdio: ["ignore", "pipe", "pipe"] });
const [chunk] = await once(app.stdout!, "data");
const { url } = JSON.parse(chunk.toString());
const client = new Client({ name: "source-repair-acceptance", version: "1.0.0" });
// Pass a cached plugin directory to test the installed artifact instead of the checkout.
const plugin = process.argv[3];
const binary = plugin ? resolve(plugin, "bin/vouch.mjs") : resolve("bin/vouch.mjs");
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--stdio"],
    env: { ...env, VERIFY_MODEL_MAX_CALLS: "0", VERIFY_OUTPUT_DIR: directory }, stderr: "pipe" }));
  const inspection = await client.callTool({ name: "inspect_page", arguments: { url } });
  if (inspection.isError) throw new Error(JSON.stringify(inspection));
  const workflow = { url, confirmDisposable: true, allowedWritePaths: ["/api/profile"], stepTimeoutMs: 1200, steps: [
    { kind: "fill", target: { role: "textbox", name: "Display name" }, value: "Ada Lovelace" },
    { kind: "choose", intent: "Save profile" },
    { kind: "assertText", text: "Profile saved" },
    { kind: "assertJson", path: "/api/profile", field: ["displayName"], equals: "Ada Lovelace" },
  ] };
  await writeFile(join(directory, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const result = await client.callTool({ name: "verify_workflow", arguments: workflow });
  const report = result.structuredContent as Record<string, unknown>;
  const evidence = { label, appSourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"),
    installedPlugin: plugin ?? null, inspection: inspection.structuredContent, report,
    independentlyReadDisk: JSON.parse(await readFile(dataFile, "utf8")) };
  await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ label, status: report.status, reason: report.reason, disk: evidence.independentlyReadDisk, evidence: join(directory, "evidence.json") }, null, 2));
  if (!result.isError) {
    assert.equal(report.status, "passed");
    assert.equal(evidence.independentlyReadDisk.displayName, "Ada Lovelace", "Successful verification must match the independent disk read");
  }
  process.exitCode = result.isError ? 1 : 0;
} finally { await client.close(); app.kill(); await once(app, "exit"); }
