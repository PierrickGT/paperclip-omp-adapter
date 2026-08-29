/**
 * Stops one agent from running twice at the same time.
 *
 * Paperclip once scheduled five heartbeat runs for a single agent, five seconds
 * apart, all on one issue. Each spawned omp against the same `--session-dir`.
 * That is wrong twice over: concurrent omp processes sharing a session store
 * corrupt the resume this adapter depends on, and each extra run multiplies
 * whatever the agent is doing. Five test-runner worker pools ran at once and
 * took the host to 186 MB of free memory.
 *
 * Why the scheduler lets that happen is the server's problem. Refusing to be
 * the thing that multiplies is the adapter's.
 *
 * The lock keys on the agent rather than the run, because the session directory
 * it protects is per-agent.
 *
 * It fails open. A lock that cannot be taken — an unwritable directory, a
 * filesystem without the primitives — must not stop an agent from working. The
 * failure mode this guards against is expensive but rare; refusing every run
 * because the lock is broken would be worse.
 */

export type RunLockDeps = {
  /** Returns false when the lock is already held. Must be atomic. */
  readonly acquire: (key: string) => Promise<boolean>;
  readonly release: (key: string) => Promise<void>;
};

/** Thrown when an agent already has a run in flight. */
export class ConcurrentRunError extends Error {
  constructor(agentId: string) {
    super(
      `Agent ${agentId} already has an omp run in flight. ` +
        `Refusing to start a second one: concurrent runs share a session directory and corrupt resume.`,
    );
    this.name = "ConcurrentRunError";
  }
}

export const withRunLock = async <T>(
  agentId: string,
  deps: RunLockDeps,
  work: () => Promise<T>,
): Promise<T> => {
  let acquired: boolean;
  try {
    acquired = await deps.acquire(agentId);
  } catch {
    // Fail open: a broken lock is not a reason to refuse the work.
    return work();
  }

  if (!acquired) throw new ConcurrentRunError(agentId);

  try {
    return await work();
  } finally {
    try {
      await deps.release(agentId);
    } catch {
      // A stale lock is recoverable; see the release-on-restart note in runtime.
    }
  }
};
