import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

export const VERSION = "0.2.0";
export function runtimeFingerprint(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(new URL("./", import.meta.url)).filter((n) => n.endsWith(".ts")).sort()) {
    hash.update(name).update(readFileSync(new URL(name, import.meta.url)));
  }
  for (const name of ["../signals.ts", "../findings.ts", "../settle.ts", "../page-model.ts", "../../package.json"]) hash.update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest("hex");
}
