import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ModelBudget } from "../src/verify/routing.ts";
import { verifyWorkflow } from "../src/verify/runtime.ts";
import { inspectLocalPage } from "../src/verify/inspect.ts";
import { redact } from "../src/verify/redact.ts";
import { startVerificationFixture } from "./helpers/verification-fixture.ts";

async function localApp(handler: RequestListener) {
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

it("spending reservations persist across independent budgets; locks and corruption fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "budget-"));
  const path = join(directory, "ledger.json");
  try {
    const first = new ModelBudget(2, 0.02, 0.01, path);
    const second = new ModelBudget(2, 0.02, 0.01, path);
    first.reserve(); second.reserve();
    assert.equal(second.usedCalls, 2);
    assert.throws(() => first.reserve(), /limit reached/);
    assert.throws(() => new ModelBudget(2, 0.02, 0.01, path).reserve(), /limit reached/);
    const worker = `import { ModelBudget } from './src/verify/routing.ts';
      try { new ModelBudget(2, 0.02, 0.01, process.env.VERIFY_TEST_LEDGER).reserve(); process.stdout.write('reserved'); }
      catch (error) { process.stdout.write(error.message); }`;
    const child = () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker],
      { env: { ...process.env, VERIFY_TEST_LEDGER: path }, encoding: "utf8" });
    assert.match((await child()).stdout, /limit reached/, "A new process must inherit consumed limits");
    await writeFile(`${path}.lock`, "interrupted reservation");
    assert.throws(() => new ModelBudget(3, 1, 0.01, path).reserve(), /locked/);
    assert.match((await child()).stdout, /locked/, "A different process must respect an existing lock");
    await rm(`${path}.lock`);
    await writeFile(path, "{}");
    assert.throws(() => new ModelBudget(2, 0.02, 0.01, path), /Invalid spending ledger/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("redaction preserves valid JSON with quotes and backslashes in credentials", () => {
  const previous = process.env.TYPESAFE_API_KEY;
  try {
    process.env.TYPESAFE_API_KEY = 'a"b\\secret';
    const result = redact({ message: `value ${process.env.TYPESAFE_API_KEY}`, array: [process.env.TYPESAFE_API_KEY] });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { message: "value [REDACTED]", array: ["[REDACTED]"] });
  } finally { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; }
});

it("inspection and automatic candidate discovery work without a model or guessed candidate list", async () => {
  const fixture = await startVerificationFixture();
  const directory = await mkdtemp(join(tmpdir(), "discover-"));
  try {
    const inspected = await inspectLocalPage({ url: fixture.origin });
    assert.equal(inspected.status, "inspected");
    assert.ok(inspected.controls.some((c) => c.role === "button" && c.name === "Save changes"));
    assert.equal(fixture.writes, 0);
    const input = fixture.workflow();
    delete input.steps[1]!.candidates;
    const report = await verifyWorkflow(input, { outputDir: directory });
    assert.equal(report.status, "passed", report.reason);
    assert.equal(report.cost.attemptedCalls, 0);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it("a stronger-model choice still has to pass independent browser and persistence assertions", async () => {
  const fixture = await startVerificationFixture();
  const directory = await mkdtemp(join(tmpdir(), "stronger-workflow-"));
  try {
    const input = fixture.workflow();
    input.steps[1]!.intent = "Persist profile";
    const decision = { model: "test-jev", selected: 0, selectedProbability: 0.5, reportedConfidence: 0.7, inputTokens: 100, outputTokens: 5 };
    const report = await verifyWorkflow({ ...input, policy: "adaptive" }, { outputDir: directory, budget: new ModelBudget(2, 0.02, 0.01),
      adapter: { decide: async () => decision },
      strongerAdapter: { decide: async () => ({ ...decision, model: "test-stronger", selected: 1, selectedProbability: null, reportedConfidence: null }) } });
    assert.equal(report.steps[1]!.route, "stronger");
    assert.equal(report.status, "failed", "The stronger model picked Discard; it must not bypass the Saved assertion");
    assert.equal(report.cost.attemptedCalls, 2);
    assert.equal(fixture.writes, 0);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it("browser POST redirects preserve method policy, destination and cookies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "redirect-policy-"));
  let forbiddenWrites = 0;
  const methods: string[] = [];
  const app = await localApp((req, res) => {
    if (req.url === "/form") { res.end('<form action="/allowed" method="post"><button>Save</button></form>'); return; }
    if (req.url === "/allowed") { res.writeHead(307, { location: "/forbidden" }); res.end(); return; }
    if (req.url === "/forbidden") { forbiddenWrites++; res.end("Done"); return; }
    if (req.url === "/good-form") { res.end('<form action="/accepted" method="post"><button>Save</button></form>'); return; }
    if (req.url === "/accepted") { res.writeHead(303, { location: "/done", "set-cookie": "saved=yes; Path=/" }); res.end(); return; }
    if (req.url === "/done") { methods.push(req.method!); res.end("Done"); return; }
    if (req.url === "/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ cookie: req.headers.cookie ?? "", method: methods[0] })); return; }
    res.end("Ready");
  });
  try {
    const steps = [{ kind: "click", target: { role: "button", name: "Save" } }, { kind: "assertText", text: "Done" }];
    const bad = await verifyWorkflow({ url: `${app.origin}/form`, confirmDisposable: true, allowedWritePaths: ["/allowed"], steps, stepTimeoutMs: 500 }, { outputDir: directory });
    assert.equal(bad.status, "abstained", bad.reason);
    assert.equal(forbiddenWrites, 0);
    assert.ok(bad.blockedRequests.some((r) => r.method === "POST" && r.url.endsWith("/forbidden")));
    const good = await verifyWorkflow({ url: `${app.origin}/good-form`, confirmDisposable: true, allowedWritePaths: ["/accepted"], steps: [...steps,
      { kind: "assertJson", path: "/state", field: ["cookie"], equals: "saved=yes" },
      { kind: "assertJson", path: "/state", field: ["method"], equals: "GET" }] }, { outputDir: directory });
    assert.equal(good.status, "passed", good.reason);
    assert.equal(good.steps[1]!.observation!.url, `${app.origin}/done`);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it("state-check streaming is size bounded and cancellable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "state-stream-"));
  const controller = new AbortController();
  const app = await localApp((req, res) => {
    if (req.url === "/large") { res.end('"' + "x".repeat(1_010_000) + '"'); return; }
    if (req.url === "/hanging") { res.writeHead(200); res.write('{"name":'); setTimeout(() => controller.abort(), 20); return; }
    res.end("Ready");
  });
  try {
    const input = { url: app.origin, steps: [{ kind: "assertJson", path: "/large", field: [], equals: "no" }] };
    const large = await verifyWorkflow(input, { outputDir: directory });
    assert.equal(large.status, "error"); assert.match(large.reason, /exceeded 1 MB/);
    input.steps[0]!.path = "/hanging";
    const cancelled = await verifyWorkflow(input, { outputDir: directory, signal: controller.signal });
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.durationMs < 4000);
    assert.equal(JSON.parse(await readFile(cancelled.artifacts.report, "utf8")).status, "cancelled");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
