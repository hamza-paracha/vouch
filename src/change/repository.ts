import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ChangedFile } from "./schema.ts";

const exec = promisify(execFile);
export const codeFile = /\.(?:[cm]?[jt]sx?)$/i;
export const testFile = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/i;
// Never stage credentials, browser evidence, dependencies or Vouch's generated reports.
const excluded = /(?:^|\/)(?:\.git|node_modules|out|auth|runner-data|coverage|dist|build|\.next|\.venv|\.ssh|\.aws)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|.*\.(?:pem|key|p12|pfx)|HANDOFF\.md)$/i;
export function allowedSnapshotPath(path: string) {
  return !isAbsolute(path) && !path.split(/[\\/]/).includes("..") && !excluded.test(path);
}
export interface RepositorySnapshot { root: string; baseCommit: string; hash: string; files: Map<string, Buffer>; modes: Map<string, number>; changes: ChangedFile[]; warnings: string[] }

export async function snapshotRepository(projectRoot: string, base: string, signal?: AbortSignal): Promise<RepositorySnapshot> {
  const requested = await realpath(resolve(projectRoot));
  const git = async (...args: string[]) => (await exec("git", ["-c", "core.fsmonitor=false", "-C", requested, ...args],
    { encoding: "utf8", maxBuffer: 4_000_000, timeout: 10_000, signal })).stdout;
  const root = (await git("rev-parse", "--show-toplevel")).trim();
  if (await realpath(root) !== requested) throw new Error("Configure the repository root, not a nested directory");
  const baseCommit = (await git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`)).trim();
  const tracked = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const names = [...new Set(tracked)].sort();
  if (names.length > 10_000) throw new Error("Repository exceeds the 10,000-file snapshot limit");
  const files = new Map<string, Buffer>(); const modes = new Map<string, number>(); const warnings: string[] = []; let bytes = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    if (!allowedSnapshotPath(name)) continue;
    const path = join(root, name);
    let info; try { info = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (!info.isFile() || info.isSymbolicLink()) { warnings.push(`Skipped non-regular file: ${name}`); continue; }
    const actual = await realpath(path);
    if (relative(root, actual).startsWith(`..${sep}`) || isAbsolute(relative(root, actual))) throw new Error("Snapshot path escapes the repository");
    if (info.size > 2_000_000) { warnings.push(`Skipped file larger than 2 MB: ${name}`); continue; }
    const data = await readFile(path); bytes += data.length;
    if (bytes > 50_000_000) throw new Error("Repository snapshot exceeds 50 MB");
    files.set(name.split(sep).join("/"), data); modes.set(name.split(sep).join("/"), info.mode & 0o777);
  }
  const changedNames = new Set((await git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, "--")).split("\0").filter(Boolean));
  const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  for (const name of untracked) changedNames.add(name);
  const changes: ChangedFile[] = [];
  for (const name of [...changedNames].sort()) {
    if (!allowedSnapshotPath(name)) { warnings.push(`Excluded changed path: ${name}`); continue; }
    if (!files.has(name)) {
      // A present but excluded/oversized file is not a deletion.
      try { await lstat(join(root, name)); warnings.push(`Changed file unavailable for analysis: ${name}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") changes.push({ path: name, status: "deleted", ranges: [] }); else throw e; }
      continue;
    }
    const diff = untracked.includes(name) ? "" : await git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", baseCommit, "--", name);
    const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ start: Math.max(1, Number(m[1])), end: Math.max(1, Number(m[1])) + Math.max(1, Number(m[2] ?? 1)) - 1 }));
    if (untracked.includes(name)) ranges.push({ start: 1, end: files.get(name)!.toString().split("\n").length });
    changes.push({ path: name, status: untracked.includes(name) || diff.includes("new file mode") ? "added" : "modified", ranges });
  }
  const hash = createHash("sha256");
  for (const [name, data] of files) hash.update(name).update("\0").update(String(modes.get(name))).update("\0").update(data).update("\0");
  return { root, baseCommit, hash: hash.digest("hex"), files, modes, changes, warnings };
}
