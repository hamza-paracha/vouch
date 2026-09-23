import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page } from "playwright";
import type { Step } from "./schema.ts";
import { VerificationStop } from "./routing.ts";

function readJson(url: string, cookie: string, signal: AbortSignal, tls: { allowInsecureTLS?: boolean; tlsCA?: string }) {
  return new Promise<unknown>((resolve, reject) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, {
      method: "GET", headers: { cookie, "cache-control": "no-cache" }, signal, agent: false,
      rejectUnauthorized: !tls.allowInsecureTLS, ...(tls.tlsCA ? { ca: tls.tlsCA } : {}),
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new VerificationStop("failed", `State check returned HTTP ${res.statusCode} (redirects are not followed)`)); res.destroy(); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) { reject(new VerificationStop("error", "State check response exceeded 1 MB")); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

export async function assertJson(context: BrowserContext, step: Extract<Step, { kind: "assertJson" }>, url: string,
  timeout: number, signal: AbortSignal, tls: { allowInsecureTLS?: boolean; tlsCA?: string }) {
  const deadline = Date.now() + timeout;
  let actual: unknown;
  do {
    signal.throwIfAborted();
    const cookie = (await context.cookies(url)).map((c) => `${c.name}=${c.value}`).join("; ");
    actual = await readJson(url, cookie, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]), tls);
    for (const key of step.field) actual = actual !== null && typeof actual === "object" && Object.hasOwn(actual, key) ? (actual as Record<string, unknown>)[key] : undefined;
    if (Object.is(actual, step.equals)) return;
    if (Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
  } while (Date.now() < deadline);
  throw new VerificationStop("failed", `Persisted-state assertion failed at ${step.field.join(".") || "<root>"}: expected ${JSON.stringify(step.equals)}, received ${JSON.stringify(actual)?.slice(0, 300) ?? "missing"}`);
}

export async function assertDOM(page: Page, step: Extract<Step, { kind: "assertSelector" | "assertAttribute" }>, timeout: number, signal: AbortSignal) {
  const locator = page.locator(`css=${step.selector}`);
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const count = await locator.count();
    if (count > 1) throw new VerificationStop("abstained", "Assertion selector is not unique");
    if (step.kind === "assertSelector") {
      const visible = count === 1 && await locator.isVisible();
      const matches = step.state === "detached" ? count === 0 : step.state === "hidden" ? !visible : step.state === "attached" ? count === 1 : visible;
      if (matches && (step.text === undefined || (await locator.textContent({ timeout: Math.max(1, deadline - Date.now()) }))?.trim() === step.text)) return;
    } else if (count === 1 && await locator.getAttribute(step.attribute, { timeout: Math.max(1, deadline - Date.now()) }) === step.equals) return;
    if (Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
  } while (Date.now() < deadline);
  throw new VerificationStop("failed", `${step.kind} failed for ${step.selector}`);
}
