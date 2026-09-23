import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interceptionCertificate } from "../src/verify/tls.ts";
import { verifyWorkflow } from "../src/verify/runtime.ts";
import { inspectLocalPage } from "../src/verify/inspect.ts";
import { importSession } from "../src/verify/sessions.ts";
import { ModelBudget } from "../src/verify/routing.ts";
import { verifyInputSchema } from "../src/verify/schema.ts";

async function app(handler: RequestListener, secure = false) {
  const cert = secure ? await interceptionCertificate() : undefined;
  const wrapped: RequestListener = (req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); handler(req, res); };
  const server = cert ? httpsServer(cert, wrapped) : createServer(wrapped);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  return { url: `${secure ? "https" : "http"}://127.0.0.1:${address.port}`, cert: cert?.cert,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } };
}

it("HTTPS validates upstream certificates, supports an explicit CA, and preserves multi-page writes and cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-tls-")); let saved = false;
  const server = await app((req, res) => {
    if (req.url === "/save" && req.method === "POST") { saved = true; res.writeHead(303, { location: "/done", "set-cookie": "saved=yes; Secure; HttpOnly; Path=/" }); res.end(); return; }
    if (req.url === "/done") { res.end('<h1 id="done" class="success">Saved</h1><a href="/details">Details</a>'); return; }
    if (req.url === "/details") { res.end('<h1 id="details" data-state="persisted">Details</h1>'); return; }
    if (req.url === "/state") { res.end(JSON.stringify({ saved, cookie: req.headers.cookie })); return; }
    res.end('<form action="/save" method="post"><button>Save</button></form>');
  }, true);
  try {
    const input = { url: server.url, confirmDisposable: true, allowedWritePaths: ["/save"], steps: [
      { kind: "click", target: { role: "button", name: "Save" } }, { kind: "assertUrl", path: "/done" },
      { kind: "assertSelector", selector: "#done", text: "Saved" }, { kind: "assertAttribute", selector: "#done", attribute: "class", equals: "success" },
      { kind: "click", target: { role: "link", name: "Details" } }, { kind: "assertUrl", path: "/details" },
      { kind: "assertAttribute", selector: "#details", attribute: "data-state", equals: "persisted" },
      { kind: "assertJson", path: "/state", field: ["cookie"], equals: "saved=yes" },
    ] };
    const rejected = await verifyWorkflow(input, { outputDir: dir });
    assert.equal(rejected.status, "abstained"); assert.equal(saved, false);
    const passed = await verifyWorkflow(input, { outputDir: dir, tlsCA: server.cert });
    assert.equal(passed.status, "passed", passed.reason); assert.equal(saved, true);
    assert.equal((await verifyWorkflow({ ...input, allowInsecureTLS: true }, { outputDir: dir })).status, "passed");
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("HTTPS CONNECT still enforces POST redirect destinations and off-origin restrictions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-tls-fence-")); let hits = 0;
  const outside = await app((_req, res) => { hits++; res.end("Outside"); }, true);
  const server = await app((req, res) => {
    if (req.url === "/allowed") { res.writeHead(307, { location: "/forbidden" }); res.end(); return; }
    if (req.url === "/forbidden") { hits++; res.end("Bad"); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: outside.url }); res.end(); return; }
    res.end('<form method="post" action="/allowed"><button>Save</button></form>');
  }, true);
  try {
    const report = await verifyWorkflow({ url: server.url, allowInsecureTLS: true, confirmDisposable: true, allowedWritePaths: ["/allowed"], steps: [
      { kind: "click", target: { role: "button", name: "Save" } }, { kind: "assertText", text: "Bad" },
    ] }, { outputDir: dir });
    assert.equal(report.status, "abstained"); assert.ok(report.blockedRequests.some((b) => b.reason === "write-blocked")); assert.equal(hits, 0);
    const redirect = await verifyWorkflow({ url: server.url + "/redirect", allowInsecureTLS: true, steps: [{ kind: "assertText", text: "Outside" }] }, { outputDir: dir });
    assert.equal(redirect.status, "abstained"); assert.equal(hits, 0);
  } finally { await server.close(); await outside.close(); await rm(dir, { recursive: true, force: true }); }
});

it("named session import scopes cookies/storage and redacts values from browser evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-session-")); const secret = "synthetic-session-credential"; const storageSecret = "synthetic-storage-credential";
  const server = await app((req, res) => {
    if (req.url === "/state") { res.end(JSON.stringify({ authenticated: req.headers.cookie === `session=${secret}` })); return; }
    if (req.headers.cookie !== `session=${secret}`) { res.end("Log in"); return; }
    res.end(`<p id="secret">${secret}</p><p id="ready">Waiting</p><script>if(localStorage.getItem('token') === '${storageSecret}')document.querySelector('#ready').textContent='Authenticated';</script>`);
  });
  try {
    const file = join(dir, "raw.json");
    await writeFile(file, JSON.stringify({ cookies: [{ name: "session", value: secret, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
      { name: "external", value: "external-secret", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [{ origin: server.url, localStorage: [{ name: "token", value: storageSecret }, { name: "enabled", value: "1" }, { name: "small", value: "e" }] }, { origin: "https://example.com", localStorage: [] }] }));
    const imported = await importSession("tester", file, server.url, dir); assert.equal(imported.cookies, 1); assert.equal(imported.storageOrigins, 1);
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "tester.json"))).mode & 0o777, 0o600);
    const report = await verifyWorkflow({ url: server.url, session: "tester", steps: [{ kind: "assertSelector", selector: "#ready", text: "Authenticated" },
      { kind: "assertJson", path: "/state", field: ["authenticated"], equals: true }] }, { outputDir: join(dir, "reports"), sessionDir: dir });
    assert.equal(report.status, "passed", report.reason); assert.equal(report.steps[0]!.action.kind, "assertSelector"); assert.ok(!JSON.stringify(report).includes(secret)); assert.ok(!(await readFile(report.artifacts.report, "utf8")).includes(secret));
    const inspection = await inspectLocalPage({ url: server.url, session: "tester" }, undefined, { sessionDir: dir }); assert.equal(inspection.status, "inspected"); assert.ok(!JSON.stringify(inspection).includes(secret));
    await assert.rejects(verifyWorkflow({ url: "http://127.0.0.1:1", session: "tester", steps: [{ kind: "assertText", text: "No" }] }, { sessionDir: dir }), /different origin/);
    assert.equal(verifyInputSchema.safeParse({ url: server.url, session: "../raw", steps: [{ kind: "assertText", text: "No" }] }).success, false);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("unread fetch bodies settle from completed transport; incomplete streaming still abstains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-settle-regression-")); let saved = false;
  const server = await app(async (req, res) => {
    if (req.url === "/save") { for await (const _chunk of req) { /* consume upload */ } saved = true; res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); return; }
    if (req.url === "/stream") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"pending":'); return; }
    if (req.url === "/state") { res.end(JSON.stringify({ saved })); return; }
    res.end(`<button id="save">Save</button><button id="stream">Stream</button><p id="status">Ready</p><script>
      for(const id of ['save','stream'])document.querySelector('#'+id).onclick=async()=>{const r=await fetch('/'+id,{method:'POST',body:'data'});if(r.ok)document.querySelector('#status').textContent='Saved';};</script>`);
  });
  try {
    const input = { url: server.url, confirmDisposable: true, allowedWritePaths: ["/save", "/stream"], stepTimeoutMs: 800,
      steps: [{ kind: "click", target: { role: "button", name: "Save" } }, { kind: "assertJson", path: "/state", field: ["saved"], equals: true }] };
    const good = await verifyWorkflow(input, { outputDir: dir }); assert.equal(good.status, "passed", good.reason);
    input.steps[0]!.target!.name = "Stream";
    const bad = await verifyWorkflow(input, { outputDir: dir }); assert.equal(bad.status, "abstained");
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("DOM assertions fail wrong attributes and ambiguous selectors abstain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-dom-"));
  const server = await app((_req, res) => res.end('<div id="status" data-state="ready">Ready</div><span>One</span><span>Two</span>'));
  try {
    const run = (step: unknown) => verifyWorkflow({ url: server.url, stepTimeoutMs: 250, steps: [step] }, { outputDir: dir });
    assert.equal((await run({ kind: "assertAttribute", selector: "#status", attribute: "data-state", equals: "wrong" })).status, "failed");
    assert.equal((await run({ kind: "assertSelector", selector: "span" })).status, "abstained");
    assert.equal((await run({ kind: "assertSelector", selector: "#missing", state: "detached" })).status, "passed");
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("URL assertions compare literal URLs rather than accepting wildcard matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-url-exact-"));
  const server = await app((_req, res) => res.end('<h1>Order</h1>'));
  try {
    const result = await verifyWorkflow({ url: server.url + '/orders/123', stepTimeoutMs: 300,
      steps: [{ kind: 'assertUrl', path: '/orders/*' }] }, { outputDir: dir });
    assert.equal(result.status, 'failed', 'A literal asterisk must not match an arbitrary order');
    const literal = await verifyWorkflow({ url: server.url + '/orders/*',
      steps: [{ kind: 'assertUrl', path: '/orders/*' }] }, { outputDir: dir });
    assert.equal(literal.status, 'passed', literal.reason);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("session redaction cannot create a false exact action match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vouch-session-routing-"));
  const server = await app((_req, res) => res.end('<button onclick="document.querySelector(\'p\').textContent=\'Clicked\'">Save B</button><p>Ready</p>'));
  try {
    const state = join(dir, 'state.json');
    await writeFile(state, JSON.stringify({ cookies: [], origins: [{ origin: server.url, localStorage: [{ name: 'first', value: 'A' }, { name: 'second', value: 'B' }] }] }));
    await importSession('short-values', state, server.url, dir);
    const result = await verifyWorkflow({ url: server.url, session: 'short-values',
      steps: [{ kind: 'choose', intent: 'Save A', candidates: [{ role: 'button', name: 'Save B' }] }, { kind: 'assertText', text: 'Clicked' }] },
      { outputDir: dir, sessionDir: dir });
    assert.equal(result.status, 'abstained', 'Scrubbing A and B must not turn Save B into an exact match for Save A');
    assert.equal(result.cost.attemptedCalls, 0);
    const exact = await verifyWorkflow({ url: server.url, session: 'short-values',
      steps: [{ kind: 'choose', intent: 'Save B' }, { kind: 'assertText', text: 'Clicked' }] }, { outputDir: dir, sessionDir: dir });
    assert.equal(exact.status, 'passed', exact.reason);
    const seen: string[] = [];
    const adapter = (probability: number) => ({ decide: async (intent: string, candidates: unknown) => {
      seen.push(JSON.stringify({ intent, candidates }));
      return { model: 'synthetic', selected: 0, selectedProbability: probability, reportedConfidence: probability, inputTokens: 0, outputTokens: 0 };
    } });
    const adaptive = await verifyWorkflow({ url: server.url, session: 'short-values', policy: 'adaptive',
      steps: [{ kind: 'choose', intent: 'Persist A', candidates: [{ role: 'button', name: 'Save B' }] }, { kind: 'assertText', text: 'Clicked' }] },
      { outputDir: dir, sessionDir: dir, budget: new ModelBudget(2, 1, 0.01), adapter: adapter(0.2), strongerAdapter: adapter(1) });
    assert.equal(adaptive.status, 'passed', adaptive.reason); assert.equal(seen.length, 2);
    assert.ok(seen.every(value => !value.includes('Persist A') && !value.includes('Save B') && value.includes('[REDACTED]')));
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
