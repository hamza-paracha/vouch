import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface LedgerState { version: 1; calls: number; reservedUsd: number }
export function readLedger(path: string): LedgerState {
  if (!existsSync(path)) return { version: 1, calls: 0, reservedUsd: 0 };
  const state = JSON.parse(readFileSync(path, "utf8")) as LedgerState;
  if (state.version !== 1 || !Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isFinite(state.reservedUsd) || state.reservedUsd < 0) {
    throw new Error("Invalid spending ledger; refusing to reset or spend");
  }
  return state;
}

/** Reserve before dispatch. Exclusive lock + fsync + atomic rename survive process restarts.
 * A stale lock is intentionally not removed automatically: uncertain attempts stay charged. */
export function updateLedger(path: string, reserve: (state: LedgerState) => LedgerState): LedgerState {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let descriptor: number;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch { throw new Error("Spending ledger is locked; no model call dispatched. Check for another process or an interrupted reservation."); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const state = reserve(readLedger(path));
    const file = openSync(temporary, "wx", 0o600);
    try { writeFileSync(file, JSON.stringify(state) + "\n"); fsyncSync(file); }
    finally { closeSync(file); }
    renameSync(temporary, path);
    return state;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
