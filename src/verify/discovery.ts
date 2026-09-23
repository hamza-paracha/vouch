import type { Page } from "playwright";
import { enumerateElements } from "../page-model.ts";
import { targetSchema, type Target } from "./schema.ts";

export const secretControl = /password|passphrase|secret|api.?key|access.?token/i;
export async function discoverTargets(page: Page): Promise<{ controls: Target[]; truncated: boolean }> {
  const controls: Target[] = [];
  const seen = new Set<string>();
  const elements = await enumerateElements(page);
  for (const element of elements) {
    const parsed = targetSchema.safeParse({ role: element.role, name: element.name });
    if (!parsed.success || element.inputType === "password" || secretControl.test(element.name)) continue;
    const key = JSON.stringify(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    const locator = page.getByRole(parsed.data.role, { name: parsed.data.name, exact: true });
    if (await locator.count() === 1 && await locator.isVisible() && await locator.isEnabled()) controls.push(parsed.data);
    if (controls.length === 33) break;
  }
  return { controls: controls.slice(0, 32), truncated: controls.length > 32 };
}
