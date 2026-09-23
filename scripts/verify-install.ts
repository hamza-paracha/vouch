import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startVerificationFixture } from "../test/helpers/verification-fixture.ts";

const directory = await mkdtemp(join(tmpdir(), "browser-verify-install-"));
const fixture = await startVerificationFixture();
const client = new Client({ name: "fresh-install-test", version: "1.0.0" });
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }))[0];
  const paths = packed.files.map((f: { path: string }) => f.path) as string[];
  assert.ok(!paths.some((p) => /(^|\/)(\.env[^/]*|auth|runner-data|out|HANDOFF\.md)(\/|$)/.test(p)), "Package contains private development artifacts");
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  execFileSync("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { stdio: "pipe" });
  const binary = join(consumer, "node_modules/browser-verify/bin/browser-verify.mjs");
  const environment = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VERIFY_MODEL_MAX_CALLS: "0", VERIFY_OUTPUT_DIR: join(directory, "reports") };
  const readiness = JSON.parse(execFileSync(process.execPath, [binary, "--doctor"], { cwd: consumer, env: environment, encoding: "utf8" }));
  assert.equal(readiness.status, "ready");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--stdio"], cwd: consumer, env: environment, stderr: "pipe" }));
  assert.equal((await client.listTools()).tools.length, 2);
  const result = await client.callTool({ name: "verify_workflow", arguments: fixture.workflow() });
  assert.equal(result.isError, false, JSON.stringify(result));
  const summary = result.structuredContent as Record<string, unknown>;
  assert.equal(summary.status, "passed");
  console.log(JSON.stringify({ package: packed.filename, fileCount: paths.length, installedOutsideCheckout: true,
    doctor: readiness.status, mcp: summary.status, modelCalls: 0, packageVersion: JSON.parse(await readFile(resolve("package.json"), "utf8")).version }, null, 2));
} finally { await client.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
