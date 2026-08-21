/**
 * Per-thread serialization for every loop entry. Bun handles HTTP requests,
 * scheduler ticks, and CLI input on one event loop, but each of those paths
 * awaits between reading a thread's derived status and appending events —
 * without a shared lock, two loop instances can interleave their events into
 * one append-only log (the seq CAS makes the loser fail loudly, but the log
 * still records a garbled conversation). Every channel that enters agentLoop
 * must go through this lock.
 */
const threadLocks = new Map<string, Promise<void>>();

export async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(threadId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  threadLocks.set(threadId, chain);
  void chain.then(() => {
    // Drop the entry once the chain we stored has fully settled — a newer
    // chain replaces it first if more work queued behind us.
    if (threadLocks.get(threadId) === chain) threadLocks.delete(threadId);
  });
  return run;
}
