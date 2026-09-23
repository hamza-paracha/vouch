import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { localTarget, sessionNameSchema } from "./schema.ts";

const cookie = z.object({ name: z.string().min(1), value: z.string(), domain: z.string(), path: z.string().startsWith("/"),
  expires: z.number().finite(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) });
const storage = z.object({ cookies: z.array(cookie).max(200), origins: z.array(z.object({
  origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })).max(200),
})).max(30) });
const profile = z.object({ version: z.literal(1), origin: z.string(), storageState: storage });
export type SessionState = z.infer<typeof storage>;

async function readBounded(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Session must be a regular JSON file under 1 MB");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
function directoryPath(directory?: string) {
  if (!directory || !isAbsolute(directory)) throw new Error("Set VOUCH_SESSION_DIR to an absolute directory before using named sessions");
  return directory;
}
function scopeState(state: SessionState, origin: string): SessionState {
  const target = localTarget(origin);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  return {
    cookies: state.cookies.filter((c) => c.domain.replace(/^\./, "").replace(/^\[|\]$/g, "") === hostname && (!c.secure || target.protocol === "https:")),
    origins: state.origins.filter((o) => o.origin === target.origin),
  };
}

/** Operator-only import. MCP callers may select a profile name, never supply a filesystem path. */
export async function importSession(name: string, source: string, origin: string, directory?: string) {
  sessionNameSchema.parse(name);
  const target = localTarget(origin);
  const root = directoryPath(directory);
  const state = scopeState(storage.parse(await readBounded(source)), target.origin);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(join(root, `${name}.json`), "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, origin: target.origin, storageState: state }) + "\n"); }
  finally { await file.close(); }
  return { name, origin: target.origin, cookies: state.cookies.length, storageOrigins: state.origins.length };
}
export async function loadSession(name: string | undefined, origin: string, directory?: string) {
  if (!name) return { state: undefined, secrets: [] as string[] };
  sessionNameSchema.parse(name);
  let saved: z.infer<typeof profile>;
  try { saved = profile.parse(await readBounded(join(directoryPath(directory), `${name}.json`))); }
  catch { throw new Error("Cannot load named session; check VOUCH_SESSION_DIR and import it first"); }
  if (saved.origin !== origin) throw new Error("Session is bound to a different origin (including protocol and port)");
  const state = scopeState(saved.storageState, origin);
  const secrets = [...state.cookies.map((c) => c.value), ...state.origins.flatMap((o) => o.localStorage.map((s) => s.value))].filter(Boolean);
  return { state, secrets };
}
