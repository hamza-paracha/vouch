import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startVerificationFixture } from "./helpers/verification-fixture.ts";

it("real stdio MCP handshake, schema validation, workflow, and single-run concurrency", async () => {
  const output = await mkdtemp(join(tmpdir(), "verify-mcp-"));
  const fixture = await startVerificationFixture();
  const client = new Client({ name: "verification-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("bin/vouch.mjs"), "--stdio"],
    // Explicitly disable any inherited provider config. Tests never need a key.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VERIFY_OUTPUT_DIR: output, VERIFY_JEV_MAX_CALLS: "0" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name), ["inspect_page", "verify_workflow", "analyze_change", "verify_change"]);
    const inspected = await client.callTool({ name: "inspect_page", arguments: { url: fixture.origin } });
    assert.equal(inspected.isError, false);
    assert.ok(JSON.stringify(inspected.structuredContent).includes("Save changes"));
    const bad = await client.callTool({ name: "verify_workflow", arguments: { url: fixture.origin, steps: [] } });
    assert.equal(bad.isError, true);
    const result = await client.callTool({ name: "verify_workflow", arguments: fixture.workflow() });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal((result.structuredContent as Record<string, unknown>)?.status, "passed");
    const abort = new AbortController();
    const slow = client.callTool({ name: "verify_workflow", arguments: { url: `${fixture.origin}/slow`, steps: [{ kind: "assertText", text: "Ready" }] } }, undefined, { signal: abort.signal });
    // Wait for the next run's directory: the server has acquired its concurrency slot.
    for (let i = 0; i < 50 && (await readdir(output)).length < 2; i++) await delay(20);
    const busy = await client.callTool({ name: "verify_workflow", arguments: fixture.workflow() });
    assert.equal(busy.isError, true);
    assert.match(JSON.stringify(busy), /already running/);
    abort.abort();
    await assert.rejects(slow);
    let statuses: string[] = [];
    for (let i = 0; i < 100; i++) {
      statuses = await Promise.all((await readdir(output)).map(async (dir) => {
        try { return JSON.parse(await readFile(join(output, dir, "report.json"), "utf8")).status as string; } catch { return "pending"; }
      }));
      if (statuses.includes("cancelled")) break;
      await delay(20);
    }
    assert.ok(statuses.includes("cancelled"), JSON.stringify(statuses));
    assert.equal(stderr, "", "stdio logs must not pollute the protocol or expose secrets");
  } finally { await client.close(); await fixture.close(); await rm(output, { recursive: true, force: true }); }
});
