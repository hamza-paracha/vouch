import { z } from "zod";
import { chromium, type Browser } from "playwright";
import { loadSession } from "./sessions.ts";
import { localTarget, sessionNameSchema } from "./schema.ts";
import { createOriginProxy, type BlockedRequest } from "./network.ts";
import { discoverTargets } from "./discovery.ts";
import { redactBrowserEvidence } from "./redact.ts";
import { Settler } from "../settle.ts";
import { freeOracle, SignalCollector } from "../signals.ts";

export const inspectInputSchema = z.object({ url: z.string().url().max(1000), session: sessionNameSchema.optional(), allowInsecureTLS: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(15_000).default(8000) }).strict();

/** Read-only discovery helps the host author concrete workflows without guessing selectors. */
export async function inspectLocalPage(raw: unknown, signal?: AbortSignal, options: { sessionDir?: string; tlsCA?: string } = {}) {
  const input = inspectInputSchema.parse(raw);
  const target = localTarget(input.url);
  const session = await loadSession(input.session, target.origin, options.sessionDir);
  const blocked: BlockedRequest[] = [];
  let browser: Browser | undefined;
  const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(input.timeoutMs)]);
  const close = () => { void browser?.close().catch(() => {}); };
  stop.addEventListener("abort", close, { once: true });
  const proxy = await createOriginProxy({ origin: target.origin, allowedWritePaths: [], allowInsecureTLS: input.allowInsecureTLS, tlsCA: options.tlsCA, onBlocked: (r) => { if (blocked.length < 50) blocked.push(r); } });
  try {
    stop.throwIfAborted();
    browser = await chromium.launch({ timeout: input.timeoutMs, proxy: { server: proxy.server, bypass: proxy.bypass } });
    stop.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: proxy.browserTLS, storageState: session.state });
    await Settler.install(context);
    await context.routeWebSocket(/.*/, async (ws) => { blocked.push({ method: "WEBSOCKET", url: ws.url(), reason: "websockets-unsupported" }); await ws.close(); });
    const page = await context.newPage();
    context.on("page", (p) => {
      if (p !== page) {
        if (blocked.length < 50) blocked.push({ method: "POPUP", url: p.url(), reason: "popups-unsupported" });
        void p.close().catch(() => {});
      }
    });
    const collector = new SignalCollector({ ignoreRequestPatterns: [], ignoreConsolePatterns: [] });
    collector.attach(page);
    const settler = new Settler(page, proxy);
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
    const settled = await settler.wait(page, { quietMs: 100, timeoutMs: Math.min(3000, input.timeoutMs) });
    const targets = await discoverTargets(page);
    const aria = (await page.locator("body").ariaSnapshot({ timeout: 1000 })).slice(0, 8000);
    stop.throwIfAborted();
    return redactBrowserEvidence({ status: blocked.length || !settled.settled ? "incomplete" : "inspected", url: page.url(), ...targets, aria,
      findings: freeOracle(collector.drain(), false).slice(0, 30), blockedRequests: blocked,
      note: "Untrusted page evidence. No workflow was verified. No model calls. Reads only; specify outcome assertions in verify_workflow." }, session.secrets);
  } finally {
    stop.removeEventListener("abort", close);
    await browser?.close().catch(() => {});
    await proxy.close();
  }
}
