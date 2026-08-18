import { nowIso } from "../db/database";
import type { EngramDeps } from "../deps";
import type { Thread } from "../agent/thread";

/**
 * Durable sleep (12-factor factor 6 + heartbeat): sleep_until writes a
 * schedules row; a minutely tick claims due rows with a compare-and-swap
 * (UPDATE ... WHERE fired = 0 — BMAD's expected-previous-state rule) and
 * re-enters the loop. Wakes survive restarts because the rows do.
 */
export function scheduleWake(deps: EngramDeps, threadId: string, wakeAt: string, note: string): void {
  deps.db
    .query(
      "INSERT INTO schedules (id, thread_id, wake_at, note, fired, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    )
    .run(Bun.randomUUIDv7(), threadId, wakeAt, note, nowIso());
}

export async function tickScheduler(
  deps: EngramDeps,
  runLoop: (threadId: string) => Promise<Thread>,
  now: Date = new Date(),
): Promise<number> {
  const due = deps.db
    .query("SELECT id, thread_id, note FROM schedules WHERE fired = 0 AND wake_at <= ?")
    .all(now.toISOString()) as Array<{ id: string; thread_id: string; note: string }>;

  let fired = 0;
  for (const row of due) {
    const claimed = deps.db
      .query("UPDATE schedules SET fired = 1 WHERE id = ? AND fired = 0")
      .run(row.id);
    if (claimed.changes === 0) continue; // another ticker claimed it
    fired++;
    deps.store.appendEvent(row.thread_id, "system_note", {
      note: `Woke from scheduled sleep: ${row.note}`,
    });
    try {
      await runLoop(row.thread_id);
    } catch (err) {
      console.warn(`[engram] wake of thread ${row.thread_id} failed: ${(err as Error).message}`);
    }
  }
  return fired;
}

export function startScheduler(
  deps: EngramDeps,
  runLoop: (threadId: string) => Promise<Thread>,
  intervalMs = 60_000,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // ticks never overlap
    running = true;
    try {
      await tickScheduler(deps, runLoop);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
