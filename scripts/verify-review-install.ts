import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { changeFixture } from "../test/helpers/change-fixture.ts";

const dir = await mkdtemp(join(tmpdir(), "vouch-review-install-"));
const fixture = await changeFixture(); const client = new Client({ name: "standalone-review-install", version: "1" });
try {
  const source = resolve("out/review-package");
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: source, encoding: "utf8" }))[0];
  assert.ok(!packed.files.some((f: { path: string }) => /(?:^|\/)(?:\.env|auth|out|node_modules)(?:\/|$)/.test(f.path)));
  const consumer = join(dir, "consumer"); await mkdir(consumer);
  execFileSync("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", join(dir, packed.filename)], { stdio: "pipe" });
  const pkg = join(consumer, "node_modules/proof-jev-guard"); const binary = join(pkg, "bin/guard.mjs");
  for (const command of ["proof-jev-guard", "vouch-jev-guard", "vouch-guard"]) {
    assert.match(execFileSync(join(consumer, "node_modules/.bin", command), ["--help"], { cwd: consumer, encoding: "utf8" }), /Usage: proof-jev-guard /);
  }
  await assert.rejects(access(join(consumer, "node_modules/playwright"))); await assert.rejects(access(join(consumer, "node_modules/typescript-ast")));
  const dependencies = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), ["@modelcontextprotocol/sdk", "@typesafe-ai/sdk", "tsx", "zod"]);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_GUARD_PROJECT_ROOT: fixture.root, VERIFY_OUTPUT_DIR: join(dir, "reports") };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [binary, "--stdio"], cwd: consumer, env, stderr: "pipe" }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["review_change", "assess_pr", "check_file"]);
  const result = await client.callTool({ name: "check_file", arguments: { file: "src/pricing.mjs" } });
  const report = result.structuredContent as { status: string; cost: { totalCalls: number } };
  assert.equal(report.status, "error"); assert.equal(report.cost.totalCalls, 0);
  assert.match(execFileSync(process.execPath, [binary, "--help"], { cwd: consumer, env, encoding: "utf8" }), /Code review only/);
  console.log(JSON.stringify({ package: packed.filename, installedOutsideCheckout: true, noBrowserDependency: true, threeTools: true, disabledByDefault: true, modelCalls: 0 }, null, 2));
} finally { await client.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); }
