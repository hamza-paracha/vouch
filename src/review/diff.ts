import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const excluded = /(?:^|\/)(?:\.git|node_modules|out|auth|runner-data|coverage|dist|build|\.next|\.venv|\.ssh|\.aws)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|.*\.(?:pem|key|p12|pfx)|HANDOFF\.md)$/i;
export function reviewPath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").some(p => p === ".." || p === ".") && !excluded.test(path);
}
export interface LineRange { start: number; end: number }
export interface DiffHunk {
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  added: LineRange[]; deleted: LineRange[];
}
export interface DiffChunk {
  file: string; previousFile?: string; status: "modified" | "added" | "deleted" | "renamed";
  language: string; additions: string; deletions: string; context: string; functions: string[]; linesChanged: number;
  diff: string; truncated: boolean; hash: string; hunks: DiffHunk[];
}
export interface DiffSummary {
  base: string; snapshotHash: string; totalFiles: number; totalLinesChanged: number; chunks: DiffChunk[];
  skipped: { file: string; reason: string }[]; truncated: boolean;
}
const extensions: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust", java: "java", rb: "ruby", cs: "csharp", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", sh: "shell", sql: "sql", css: "css", html: "html" };
export function parseChunk(file: string, status: DiffChunk["status"], patch: string, previousFile?: string): DiffChunk {
  const additions: string[] = [], deletions: string[] = [], context: string[] = [], functions: string[] = [];
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined, oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  const finish = () => { if (oldRemaining || newRemaining) throw new Error("Malformed unified diff: hunk line counts do not match"); };
  const addRange = (ranges: LineRange[], line: number) => {
    const last = ranges.at(-1);
    if (last && last.end + 1 === line) last.end = line;
    else ranges.push({ start: line, end: line });
  };
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ([^\r]*))?\r?$/);
    if (header) {
      finish();
      hunk = { oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]), newLines: Number(header[4] ?? 1), added: [], deleted: [] };
      if (header[5]) functions.push(header[5]);
      hunks.push(hunk); oldLine = hunk.oldStart; newLine = hunk.newStart; oldRemaining = hunk.oldLines; newRemaining = hunk.newLines;
      continue;
    }
    if (line.startsWith("diff --git ")) { finish(); hunk = undefined; continue; }
    if (!hunk || (!oldRemaining && !newRemaining)) continue;
    if (line.startsWith("+")) { additions.push(line.slice(1)); addRange(hunk.added, newLine++); newRemaining--; }
    else if (line.startsWith("-")) { deletions.push(line.slice(1)); addRange(hunk.deleted, oldLine++); oldRemaining--; }
    else if (line.startsWith(" ")) { context.push(line.slice(1)); oldLine++; newLine++; oldRemaining--; newRemaining--; }
    if (oldRemaining < 0 || newRemaining < 0) throw new Error("Malformed unified diff: invalid hunk length");
  }
  finish();
  // Prioritize changed lines in the request representation; all clipping is explicit.
  const truncated = Buffer.byteLength(patch) > 10_000;
  return { file, ...(previousFile ? { previousFile } : {}), status, language: extensions[file.split(".").at(-1)!.toLowerCase()] ?? "text",
    hunks, additions: additions.join("\n"), deletions: deletions.join("\n"), context: context.join("\n"), functions: [...new Set(functions)].slice(0, 30),
    linesChanged: additions.length + deletions.length, diff: Buffer.from(patch).subarray(0, 10_000).toString("utf8"), truncated,
    hash: createHash("sha256").update(file).update("\0").update(patch).digest("hex") };
}

export async function getDiff(projectRoot: string, base: string, signal?: AbortSignal, focus?: string[]): Promise<DiffSummary> {
  if (focus?.some(file => !reviewPath(file))) throw new Error("Focus paths must be exact, eligible repository-relative files");
  const root = await realpath(resolve(projectRoot));
  const git = async (...args: string[]) => (await exec("git", ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "diff.suppressBlankEmpty=false", "-C", root, ...args],
    { encoding: "utf8", maxBuffer: 2_000_000, timeout: 10_000, signal })).stdout;
  if (await realpath((await git("rev-parse", "--show-toplevel")).trim()) !== root) throw new Error("Configure the Git repository root");
  const commit = (await git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`)).trim();
  const entries = (await git("diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--name-status", "-z", commit, "--")).split("\0");
  const changes: { file: string; previousFile?: string; status: DiffChunk["status"]; untracked?: boolean }[] = [];
  for (let i = 0; i < entries.length - 1;) {
    const tag = entries[i++]!, first = entries[i++]!;
    if (tag.startsWith("R")) changes.push({ file: entries[i++]!, previousFile: first, status: "renamed" });
    else changes.push({ file: first, status: tag === "A" ? "added" : tag === "D" ? "deleted" : "modified" });
  }
  for (const file of (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean))
    changes.push({ file, status: "added", untracked: true });
  const selected = changes.filter(c => !focus?.length || focus.includes(c.file) || !!c.previousFile && focus.includes(c.previousFile)).sort((a,b) => a.file.localeCompare(b.file));
  const result: DiffSummary = { base: commit, snapshotHash: "", totalFiles: selected.length, totalLinesChanged: 0, chunks: [], skipped: [], truncated: false };
  for (const change of selected) {
    signal?.throwIfAborted();
    const skip = (reason: string) => { result.skipped.push({ file: change.file, reason }); };
    if (!reviewPath(change.file) || change.previousFile && !reviewPath(change.previousFile)) { skip("Excluded path"); continue; }
    if (result.chunks.length >= 50) { skip("50-file review limit"); continue; }
    let current = Buffer.alloc(0);
    if (change.status !== "deleted") {
      const path = join(root, change.file); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) { skip("Non-regular or external file"); continue; }
      const actual = await realpath(path); const rel = relative(root, actual);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) { skip("Non-regular or external file"); continue; }
      if (info.size > 100_000) { skip("File exceeds 100 KB"); continue; }
      current = await readFile(path);
      if (current.length > 100_000 || current.includes(0)) { skip("Oversized or binary file"); continue; }
    }
    if (change.status !== "added") {
      const original = `${commit}:${change.previousFile ?? change.file}`;
      const size = Number((await git("cat-file", "-s", original)).trim());
      if (!Number.isFinite(size) || size > 100_000) { skip("Base file exceeds 100 KB"); continue; }
    }
    const lines = current.length ? current.toString().split("\n") : [];
    if (current.at(-1) === 10) lines.pop(); // A final newline terminates a line; it is not an additional empty line.
    const patch = change.untracked ? `--- /dev/null\n+++ ${JSON.stringify(`b/${change.file}`)}\n${lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => "+" + line).join("\n")}\n${current.at(-1) === 10 ? "" : "\\ No newline at end of file\n"}` : ""}`
      : await git("diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--unified=5", commit, "--", ...(change.previousFile ? [change.previousFile] : []), change.file);
    if (/^Binary files /m.test(patch) || patch.includes("GIT binary patch") || patch.includes("\0")) { skip("Binary diff"); continue; }
    const chunk = parseChunk(change.file, change.status, patch, change.previousFile);
    result.chunks.push(chunk); result.totalLinesChanged += chunk.linesChanged;
  }
  result.truncated = result.skipped.length > 0 || result.chunks.some(c => c.truncated);
  result.snapshotHash = createHash("sha256").update(JSON.stringify({ base: commit, hashes: result.chunks.map(c => c.hash), skipped: result.skipped })).digest("hex");
  return result;
}
