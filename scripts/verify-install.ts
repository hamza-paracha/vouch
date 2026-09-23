import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startVerificationFixture } from "../test/helpers/verification-fixture.ts";
import { changeFixture, strongTests } from "../test/helpers/change-fixture.ts";

const changes = await changeFixture();
const directory = await mkdtemp(join(tmpdir(), "vouch-install-"));
const fixture = await startVerificationFixture();
const client = new Client({ name: "fresh-install-test", version: "1.0.0" });
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }))[0];
  const paths = packed.files.map((f: { path: string }) => f.path) as string[];
  assert.ok(!paths.some((p) => /(^|\/)(\.env[^/]*|auth|runner-data|out|HANDOFF\.md)(\/|$)/.test(p)), "Package contains private development artifacts");
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  execFileSync("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { stdio: "pipe" });
  const binary = join(consumer, "node_modules/vouch-jev/bin/vouch.mjs");
  for (const command of ["vouch-jev", "vouch"]) {
    assert.match(execFileSync(join(consumer, "node_modules/.bin", command), ["--help"], { cwd: consumer, encoding: "utf8" }), /Usage: vouch-jev /);
  }
  for (const command of ["vouch-jev-guard", "vouch-guard"]) {
    assert.match(execFileSync(join(consumer, "node_modules/.bin", command), ["--help"], { cwd: consumer, encoding: "utf8" }), /Usage: vouch-jev-guard /);
  }
  const environment = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VERIFY_MODEL_MAX_CALLS: "0", VERIFY_OUTPUT_DIR: join(directory, "reports"), VOUCH_PROJECT_ROOT: changes.root, VOUCH_ALLOW_EXECUTION: "1" };
  const readiness = JSON.parse(execFileSync(process.execPath, [binary, "--doctor"], { cwd: consumer, env: environment, encoding: "utf8" }));
  assert.equal(readiness.status, "ready");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--stdio"], cwd: consumer, env: environment, stderr: "pipe" }));
  assert.equal((await client.listTools()).tools.length, 7);
  const result = await client.callTool({ name: "verify_workflow", arguments: fixture.workflow() });
  assert.equal(result.isError, false, JSON.stringify(result));
  const summary = result.structuredContent as Record<string, unknown>;
  assert.equal(summary.status, "passed");
  const analysis = JSON.parse(execFileSync(process.execPath, [binary, "analyze", "--project", changes.root], { cwd: consumer, env: environment, encoding: "utf8" }));
  assert.ok(analysis.affectedTests.includes("test/pricing.test.mjs"));
  const weak = await client.callTool({ name: "verify_change", arguments: { confirmCodeExecution: true } });
  assert.equal((weak.structuredContent as Record<string, unknown>).status, "gaps_found");
  await writeFile(join(changes.root, "test/pricing.test.mjs"), strongTests);
  const strengthened = JSON.parse(execFileSync(process.execPath, [binary, "verify-change", "--project", changes.root, "--allow-exec"], { cwd: consumer, env: environment, encoding: "utf8", timeout: 60_000 }));
  assert.equal(strengthened.status, "evidence_collected");
  console.log(JSON.stringify({ changeMcp: "gaps_found", changeCli: strengthened.status, package: packed.filename, fileCount: paths.length, installedOutsideCheckout: true,
    doctor: readiness.status, mcp: summary.status, modelCalls: 0, packageVersion: JSON.parse(await readFile(resolve("package.json"), "utf8")).version }, null, 2));
} finally { await client.close(); await fixture.close(); await changes.close(); await rm(directory, { recursive: true, force: true }); }
