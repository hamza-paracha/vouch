import { assertJson, assertDOM } from "./assertions.ts";
import { loadSession } from "./sessions.ts";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { freeOracle, SignalCollector } from "../signals.ts";
import { Settler } from "../settle.ts";
import { createOriginProxy } from "./network.ts";
import { discoverTargets, secretControl } from "./discovery.ts";
import { redact, redactBrowserEvidence } from "./redact.ts";
import { VERSION, runtimeFingerprint } from "./version.ts";
import { localTarget, sameOrigin, verifyInputSchema, type Target, type Step, type VerifyInput } from "./schema.ts";
import { ModelBudget, selectControl, VerificationStop, type CallRecord, type DecisionAdapter } from "./routing.ts";

type Status = "passed" | "failed" | "abstained" | "budget_exhausted" | "cancelled" | "timed_out" | "error";
export interface StepRecord {
  index: number;
  action: Step;
  status: "passed" | "failed" | "stopped";
  route: "rules" | "jev" | "stronger";
  reason?: string;
  selectedTarget?: Target;
  durationMs: number;
  observation?: { url: string; aria: string };
}
export interface VerificationReport {
  schemaVersion: 1;
  runId: string;
  status: Status;
  reason: string;
  startedAt: string;
  durationMs: number;
  manifest: { toolVersion: string; policyVersion: string; nodeVersion: string; runtimeFingerprint: string };
  input: VerifyInput;
  steps: StepRecord[];
  findings: { step: number; category: string; message: string }[];
  blockedRequests: { method: string; url: string; reason: string }[];
  calls: CallRecord[];
  limits: { maxCallsPerRun: number; processMaxCalls: number; processMaxEstimatedUsd: number; estimatePerCallUsd: number; scope: "ledger" | "process" };
  cost: { attemptedCalls: number; estimatedReservedUsd: number; providerReportedCostUsd: number | null; inputTokens: number | null; outputTokens: number | null; processCallsUsed: number };
  artifacts: { report: string; trace: string; replay: string };
}
export interface VerifyOptions {
  outputDir?: string;
  adapter?: DecisionAdapter;
  strongerAdapter?: DecisionAdapter;
  budget?: ModelBudget;
  signal?: AbortSignal;
  sessionDir?: string;
  tlsCA?: string;
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1200);
}
function pathUrl(path: string, origin: string): string {
  const url = new URL(path, origin).href;
  if (!sameOrigin(url, origin)) throw new VerificationStop("abstained", "Step tried to leave the target origin");
  return url;
}

async function locate(page: Page, target: Target, timeout: number) {
  if (secretControl.test(target.name)) throw new VerificationStop("abstained", "Credential controls are outside the verification workflow");
  const locator = page.getByRole(target.role, { name: target.name, exact: true });
  await locator.first().waitFor({ state: "visible", timeout });
  if (await locator.count() !== 1) throw new VerificationStop("abstained", "Control label is not unique; narrow the workflow");
  if (await locator.getAttribute("type") === "password") throw new VerificationStop("abstained", "Password inputs are unsupported");
  return locator;
}

/** An isolated browser per run; application state still belongs to the target fixture/server. */
export async function verifyWorkflow(raw: unknown, options: VerifyOptions = {}): Promise<VerificationReport> {
  const input = verifyInputSchema.parse(raw);
  const target = localTarget(input.url);
  // Validate all URLs before any browser work or writes occur.
  for (const step of input.steps) if ("path" in step) pathUrl(step.path, target.origin);
  const session = await loadSession(input.session, target.origin, options.sessionDir);
  const budget = options.budget ?? new ModelBudget();
  const started = Date.now();
  const runId = `verify-${randomUUID()}`;
  const directory = resolve(options.outputDir ?? "out/verification", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report: VerificationReport = {
    schemaVersion: 1, runId, status: "error", reason: "Run did not complete", startedAt: new Date(started).toISOString(), durationMs: 0,
    manifest: { toolVersion: VERSION, policyVersion: "exact-then-jev-v2", nodeVersion: process.version, runtimeFingerprint: runtimeFingerprint() },
    input, steps: [], findings: [], blockedRequests: [], calls: [],
    limits: { maxCallsPerRun: 3, processMaxCalls: budget.maxCalls, processMaxEstimatedUsd: budget.maxEstimatedUsd, estimatePerCallUsd: budget.estimatePerCallUsd, scope: budget.ledgerPath ? "ledger" : "process" },
    cost: { attemptedCalls: 0, estimatedReservedUsd: 0, providerReportedCostUsd: 0, inputTokens: 0, outputTokens: 0, processCallsUsed: budget.usedCalls },
    artifacts: { report: join(directory, "report.json"), trace: join(directory, "trace.jsonl"), replay: join(directory, "workflow.json") },
  };
  const controller = new AbortController();
  let timedOut = false;
  let browser: Browser | undefined;
  let proxy: Awaited<ReturnType<typeof createOriginProxy>> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let active: StepRecord | undefined;
  let activeStarted = started;
  const collector = new SignalCollector({ ignoreConsolePatterns: [], ignoreRequestPatterns: [] });
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, input.timeoutMs - (Date.now() - started)));
  // Closing the dedicated browser interrupts Playwright waits immediately.
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener("abort", closeOnAbort, { once: true });
  const drain = (step: number) => {
    for (const finding of freeOracle(collector.drain(), false).slice(0, 30)) {
      report.findings.push({ step, category: finding.category, message: finding.message });
    }
  };
  const checkFence = () => {
    if (report.blockedRequests.length) throw new VerificationStop("abstained", "A request was blocked by the origin/write fence; the workflow could not be fully verified");
  };
  const timeout = () => Math.max(1, Math.min(input.stepTimeoutMs, input.timeoutMs - (Date.now() - started)));
  try {
    controller.signal.throwIfAborted();
    const blocked = (method: string, url: string, reason: string) => {
      if (report.blockedRequests.length < 50) report.blockedRequests.push({ method, url, reason });
    };
    proxy = await createOriginProxy({ origin: target.origin, allowedWritePaths: input.allowedWritePaths, allowInsecureTLS: input.allowInsecureTLS, tlsCA: options.tlsCA,
      onBlocked: ({ method, url, reason }) => blocked(method, url, reason) });
    browser = await chromium.launch({ timeout: input.timeoutMs, proxy: { server: proxy.server, bypass: proxy.bypass } });
    controller.signal.throwIfAborted();
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: proxy.browserTLS, storageState: session.state });
    context.setDefaultTimeout(input.stepTimeoutMs);
    await Settler.install(context);
    await context.routeWebSocket(/.*/, async (ws) => {
      blocked("WEBSOCKET", ws.url(), "websockets-unsupported");
      await ws.close();
    });
    page = await context.newPage();
    collector.attach(page);
    const settler = new Settler(page, proxy);
    const settle = async () => {
      const result = await settler.wait(page!, { quietMs: 100, timeoutMs: timeout() });
      if (!result.settled) throw new VerificationStop("abstained", "Page did not settle within the step deadline");
    };
    context.on("page", (popup) => {
      if (popup !== page) { blocked("POPUP", popup.url(), "popups-unsupported"); void popup.close().catch(() => {}); }
    });
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeout() });
    await settle();
    drain(-1);
    checkFence();
    if (report.findings.length) throw new VerificationStop("failed", "Deterministic browser checks failed on the entry page");
    for (const [index, step] of input.steps.entries()) {
      controller.signal.throwIfAborted();
      checkFence();
      activeStarted = Date.now();
      active = { index, action: step, route: "rules", status: "stopped", durationMs: 0 };
      report.steps.push(active);
      await settler.markAction();
      switch (step.kind) {
        case "goto":
          await page.goto(pathUrl(step.path, target.origin), { waitUntil: "domcontentloaded", timeout: timeout() });
          break;
        case "click":
          await (await locate(page, step.target, timeout())).click({ timeout: timeout() });
          break;
        case "fill":
          await (await locate(page, step.target, timeout())).fill(step.value, { timeout: timeout() });
          break;
        case "choose": {
          const candidates: Target[] = [];
          const discovered = step.candidates ? undefined : await discoverTargets(page);
          const available = step.candidates ?? discovered!.controls.filter((c) => ["button", "link", "tab"].includes(c.role));
          const exact = available.filter((c) => c.name.toLowerCase() === step.intent.toLowerCase());
          if (!step.candidates && (discovered!.truncated || available.length > 8) && exact.length !== 1) {
            throw new VerificationStop("abstained", "Too many controls for automatic selection; inspect_page and supply at most 8 candidates");
          }
          for (const candidate of !step.candidates && exact.length === 1 ? exact : available) {
            if (secretControl.test(candidate.name)) continue;
            const locator = page.getByRole(candidate.role, { name: candidate.name, exact: true });
            if (await locator.count() === 1 && await locator.isVisible() && await locator.isEnabled()) candidates.push(candidate);
          }
          if (!candidates.length) throw new VerificationStop("abstained", "No unique visible allowed candidates were available");
          const selected = await selectControl({
            intent: redact(step.intent, session.secrets), candidates: redactBrowserEvidence(candidates, session.secrets), policy: input.policy, adapter: options.adapter, strongerAdapter: options.strongerAdapter,
            budget, calls: report.calls, step: index, signal: controller.signal,
          });
          active.route = selected.route;
          active.reason = selected.reason;
          active.selectedTarget = candidates[selected.index]!;
          await (await locate(page, active.selectedTarget, timeout())).click({ timeout: timeout() });
          break;
        }
        case "assertText":
          await page.getByText(step.text, { exact: true }).waitFor({ state: "visible", timeout: timeout() });
          break;
        case "assertUrl":
          await page.waitForURL(pathUrl(step.path, target.origin), { timeout: timeout() });
          break;
        case "assertSelector":
        case "assertAttribute":
          await assertDOM(page, step, timeout(), controller.signal);
          break;
        case "assertJson":
          await assertJson(context, step, pathUrl(step.path, target.origin), timeout(), controller.signal, { allowInsecureTLS: input.allowInsecureTLS, tlsCA: options.tlsCA });
          break;
      }
      await settle();
      controller.signal.throwIfAborted();
      drain(index);
      checkFence();
      if (!sameOrigin(page.url(), target.origin)) throw new VerificationStop("abstained", "Page left the target origin");
      if (report.findings.length) throw new VerificationStop("failed", "Deterministic browser checks found errors");
      active.observation = { url: page.url(), aria: (await page.locator("body").ariaSnapshot({ timeout: timeout() })).slice(0, 8000) };
      active.status = "passed";
      active.durationMs = Date.now() - activeStarted;
    }
    controller.signal.throwIfAborted();
    drain(input.steps.length - 1);
    checkFence();
    if (Date.now() - started >= input.timeoutMs) throw new VerificationStop("error", "Run deadline exceeded");
    if (report.findings.length) throw new VerificationStop("failed", "Deterministic browser checks found errors");
    report.status = "passed";
    report.reason = "All supplied assertions and deterministic browser checks passed";
  } catch (error) {
    drain(active?.index ?? -1);
    const expired = timedOut || Date.now() - started >= input.timeoutMs;
    report.status = expired ? "timed_out" : controller.signal.aborted ? "cancelled"
      : report.blockedRequests.length ? "abstained"
      : error instanceof VerificationStop ? error.status
      : error instanceof Error && error.name === "TimeoutError" ? "failed" : "error";
    report.reason = expired ? "Run deadline exceeded" : controller.signal.aborted ? "Run cancelled" : errorMessage(error);
    if (active) {
      const lastCall = report.calls.findLast((call) => call.step === active!.index);
      if (lastCall) active.route = lastCall.tier;
      active.status = report.status === "failed" ? "failed" : "stopped";
      active.reason = report.reason;
      active.durationMs = Date.now() - activeStarted;
      if (page && !controller.signal.aborted && !page.isClosed()) {
        active.observation = { url: page.url(), aria: (await page.locator("body").ariaSnapshot({ timeout: 300 }).catch(() => "")).slice(0, 8000) };
      }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", closeOnAbort);
    await browser?.close().catch(() => {});
    await proxy?.close();
  }
  report.durationMs = Date.now() - started;
  const unknownUsage = report.calls.some((c) => !c.decision);
  report.cost = {
    attemptedCalls: report.calls.length,
    estimatedReservedUsd: report.calls.reduce((sum, c) => sum + c.estimatedReservedUsd, 0),
    providerReportedCostUsd: report.calls.some((c) => c.providerReportedCostUsd === null) ? null : report.calls.reduce((sum, c) => sum + c.providerReportedCostUsd!, 0),
    inputTokens: unknownUsage ? null : report.calls.reduce((sum, c) => sum + (c.decision?.inputTokens ?? 0), 0),
    outputTokens: unknownUsage ? null : report.calls.reduce((sum, c) => sum + (c.decision?.outputTokens ?? 0), 0),
    processCallsUsed: budget.usedCalls,
  };
  const safe = redactBrowserEvidence(report, session.secrets);
  const replay = { ...safe.input, policy: "rules", steps: safe.steps.map((s) => s.selectedTarget ? { kind: "click", target: s.selectedTarget } : s.action) };
  // Include steps after an early failure; freeze completed model decisions for a free replay.
  replay.steps.push(...safe.input.steps.slice(safe.steps.length));
  await Promise.all([
    writeFile(safe.artifacts.report, JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 }),
    writeFile(safe.artifacts.trace, safe.steps.map((s) => JSON.stringify(s)).join("\n") + "\n", { mode: 0o600 }),
    writeFile(safe.artifacts.replay, JSON.stringify(replay, null, 2) + "\n", { mode: 0o600 }),
  ]);
  return safe;
}
