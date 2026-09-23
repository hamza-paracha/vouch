import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { redact } from "../verify/redact.ts";

export interface CommandResult { command: string[]; exitCode: number | null; outcome: "passed" | "failed" | "timed_out" | "cancelled" | "output_limit" | "error"; durationMs: number; stdout: string; stderr: string }

/** No shell, no inherited provider credentials, bounded output and whole-process-group cancellation.
 * This is process hygiene, not an OS security sandbox. Only run trusted repositories. */
export async function runCommand(command: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  const start = Date.now();
  const home = join(cwd, ".vouch-home"), temp = join(cwd, ".vouch-tmp");
  await mkdir(home, { recursive: true }); await mkdir(temp, { recursive: true });
  if (signal.aborted) return { command, exitCode: null, outcome: "cancelled", durationMs: 0, stdout: "", stderr: "" };
  return new Promise((resolve) => {
    let stdout = "", stderr = "", bytes = 0;
    let stop: CommandResult["outcome"] | undefined;
    const child = spawn(command[0] === "node" ? process.execPath : command[0]!, command.slice(1), {
      cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
        CI: "1", LANG: "C.UTF-8", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-child.pid, "SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const abort = () => { stop = "cancelled"; kill(); };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { stop = "timed_out"; kill(); }, timeoutMs);
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, 128_000 - bytes); bytes += chunk.length;
      const value = chunk.subarray(0, remaining).toString();
      if (kind === "stdout") stdout += value; else stderr += value;
      if (bytes > 128_000) { stop = "output_limit"; kill(); }
    };
    child.stdout.on("data", (c: Buffer) => append("stdout", c)); child.stderr.on("data", (c: Buffer) => append("stderr", c));
    child.on("error", (error) => { stop = "error"; stderr += error.message; });
    child.on("close", (code) => {
      // Also remove detached descendants which outlived an otherwise successful command.
      kill(); clearTimeout(timer); signal.removeEventListener("abort", abort);
      resolve(redact({ command, exitCode: code, outcome: stop ?? (code === 0 ? "passed" : "failed"), durationMs: Date.now() - start, stdout, stderr }));
    });
    if (signal.aborted) abort();
  });
}
