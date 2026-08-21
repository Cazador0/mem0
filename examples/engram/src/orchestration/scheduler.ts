import { nowIso } from "../db/database";
import type { EngramDeps } from "../deps";
import { effectiveTail, isSleeping, type Thread } from "../agent/thread";
import { withThreadLock } from "./lock";

/**
 * Durable sleep (12-factor factor 6 + heartbeat): sleep_until writes a
 * schedules row; a minutely tick claims due rows and re-enters the loop.
 *
 * Delivery is exactly-once for the observable wake event. Two mechanisms,
 * doing different jobs:
 *
 * - **The lease** (`claimed_at`) stops two tickers from doing the same work at
 *   the same time, and — unlike the old `fired = 1`-up-front claim — a crash
 *   while holding it does NOT lose the wake: the row is still `fired = 0`, so
 *   it is reclaimed once the lease expires (or immediately, at startup).
 * - **The fired CAS** (`SET fired = 1 WHERE fired = 0`) runs in the SAME
 *   transaction that appends the wake event, so the record of the wake and the
 *   mark that it happened can never disagree. Whoever loses that CAS appends
 *   nothing.
 *
 * The residual crash window — process dies after the wake event is committed
 * but before the loop finishes — is closed at startup by recoverPendingWakes.
 */

/** How long a claim is honored before another ticker may reclaim the row. */
export const WAKE_LEASE_MS = 5 * 60_000;

export function scheduleWake(
  deps: EngramDeps,
  threadId: string,
  wakeAt: string,
  note: string,
  sleepSeq: number,
): void {
  deps.db
    .query(
      "INSERT INTO schedules (id, thread_id, wake_at, note, fired, created_at, sleep_seq) VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .run(Bun.randomUUIDv7(), threadId, wakeAt, note, nowIso(), sleepSeq);
}

export async function tickScheduler(
  deps: EngramDeps,
  runLoop: (threadId: string) => Promise<Thread>,
  now: Date = new Date(),
): Promise<number> {
  const nowIsoStr = now.toISOString();
  const leaseCutoff = new Date(now.getTime() - WAKE_LEASE_MS).toISOString();

  const due = deps.db
    .query(
      `SELECT id, thread_id, note, sleep_seq FROM schedules
       WHERE fired = 0 AND wake_at <= ?
         AND (claimed_at IS NULL OR claimed_at <= ?)`,
    )
    .all(nowIsoStr, leaseCutoff) as Array<{
    id: string;
    thread_id: string;
    note: string;
    sleep_seq: number;
  }>;

  let fired = 0;
  for (const row of due) {
    // Take the lease. The row stays fired = 0: if we die now, the wake is not
    // lost, just delayed until the lease expires.
    const leased = deps.db
      .query(
        `UPDATE schedules SET claimed_at = ?
         WHERE id = ? AND fired = 0 AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .run(nowIsoStr, row.id, leaseCutoff);
    if (leased.changes === 0) continue; // another ticker holds the lease

    fired += await withThreadLock(row.thread_id, async () => {
      // A stale wake: the thread moved on, OR the row belongs to a superseded
      // sleep (the current sleep_until is a different event than the one that
      // wrote this row). Consume the row without disturbing the thread.
      const thread = deps.store.getThread(row.thread_id);
      if (!isSleeping(thread) || effectiveTail(thread)?.seq !== row.sleep_seq) {
        deps.db.query("UPDATE schedules SET fired = 1 WHERE id = ?").run(row.id);
        return 0;
      }

      // Record the wake and mark the row fired atomically — a reader can never
      // observe one without the other, and a duplicate delivery appends nothing.
      const delivered = deps.db.transaction(() => {
        const claimed = deps.db
          .query("UPDATE schedules SET fired = 1 WHERE id = ? AND fired = 0")
          .run(row.id);
        if (claimed.changes === 0) return false;
        deps.store.appendEvent(row.thread_id, "system_note", {
          note: `Woke from scheduled sleep: ${row.note}`,
        });
        return true;
      })();
      if (!delivered) return 0;

      try {
        await runLoop(row.thread_id);
      } catch (err) {
        console.warn(`[engram] wake of thread ${row.thread_id} failed: ${(err as Error).message}`);
      }
      return 1;
    });
  }
  return fired;
}

export interface WakeRecovery {
  /** Leases released so their rows can be claimed again immediately. */
  released: number;
  /** Threads whose wake was recorded but whose loop never ran to completion. */
  incomplete: string[];
}

/**
 * Startup reconciliation. Two kinds of debris a crash can leave:
 *
 * 1. A leased-but-unfired row — the previous process died between claiming and
 *    recording. Nobody holds that lease now, so release it immediately instead
 *    of waiting out WAKE_LEASE_MS.
 * 2. A thread whose last event is a wake note but whose effective tail is still
 *    the sleep_until — the wake was committed, then the process died before the
 *    loop produced anything. Its schedules row is fired, so no tick will ever
 *    revisit it; without this it would sleep forever.
 */
export function recoverPendingWakes(deps: EngramDeps): WakeRecovery {
  const released = deps.db
    .query("UPDATE schedules SET claimed_at = NULL WHERE fired = 0 AND claimed_at IS NOT NULL")
    .run().changes;

  // Candidates are found in SQL — threads whose NEWEST event is a system_note —
  // so startup loads events for the handful of suspects, not for every thread
  // that ever slept.
  const candidates = deps.db
    .query(
      `SELECT e.thread_id AS thread_id
       FROM events e
       JOIN (SELECT thread_id, MAX(seq) AS max_seq FROM events GROUP BY thread_id) newest
         ON newest.thread_id = e.thread_id AND newest.max_seq = e.seq
       WHERE e.type = 'system_note'`,
    )
    .all() as Array<{ thread_id: string }>;

  const incomplete: string[] = [];
  for (const { thread_id } of candidates) {
    // Still reads as sleeping despite the wake note being the newest event:
    // the loop never got to append anything after it.
    if (isSleeping(deps.store.getThread(thread_id))) incomplete.push(thread_id);
  }
  return { released: Number(released), incomplete };
}

export function startScheduler(
  deps: EngramDeps,
  runLoop: (threadId: string) => Promise<Thread>,
  intervalMs = 60_000,
): () => void {
  const recovery = recoverPendingWakes(deps);
  if (recovery.released > 0) {
    console.log(`[engram] released ${recovery.released} stale wake lease(s) from a previous run`);
  }
  for (const threadId of recovery.incomplete) {
    console.log(`[engram] resuming thread ${threadId} — its wake was recorded but never completed`);
    void withThreadLock(threadId, () => runLoop(threadId)).catch(err =>
      console.warn(`[engram] resume of ${threadId} failed: ${(err as Error).message}`),
    );
  }

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
