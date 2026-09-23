import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { changeFixture, strongTests, changedPricing } from "../test/helpers/change-fixture.ts";
import { verifyChange } from "../src/change/verify.ts";

// A disposable repository with a real changed boundary and tests that initially miss it.
const fixture = await changeFixture();
const output = resolve("out/change-demo"); await mkdir(output, { recursive: true });
try {
  const options = { projectRoot: fixture.root, allowExecution: true, outputDir: output };
  const weak = await verifyChange({ base: "HEAD", confirmCodeExecution: true }, options);
  assert.equal(weak.status, "gaps_found", weak.reason);
  // Explicit fixture requirements: free shipping at 50, paid shipping at zero, reject negative totals.
  await writeFile(join(fixture.root, "test/pricing.test.mjs"), strongTests);
  const strong = await verifyChange({ base: "HEAD", confirmCodeExecution: true }, options);
  assert.equal(strong.status, "evidence_collected", strong.reason);
  assert.equal(await readFile(join(fixture.root, "src/pricing.mjs"), "utf8"), changedPricing);
  const result = { weakTests: { status: weak.status, summary: weak.summary, report: weak.artifacts.markdown },
    strengthenedTests: { status: strong.status, summary: strong.summary, report: strong.artifacts.markdown }, checkoutUnchanged: true, modelCalls: 0 };
  await writeFile(join(output, "demo.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await fixture.close(); }
