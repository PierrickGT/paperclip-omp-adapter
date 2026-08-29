/**
 * Kills what a finished run left behind.
 *
 * adapter-utils spawns omp detached and signals the whole process group, which
 * is correct and enough for anything omp starts normally. It is not enough for
 * a process that calls `setsid` or is itself spawned detached: that process
 * leads a new group, and the group signal never reaches it. Test-runner worker
 * pools do this. Five escaped workers once held 17 GB of RAM for two and a half
 * hours after the run that started them had been killed.
 *
 * Process groups cannot see those survivors. The environment can. Paperclip
 * stamps `PAPERCLIP_RUN_ID` into every run, and a child inherits the
 * environment however it was spawned, so the run id identifies descendants that
 * process-group membership has lost.
 *
 * This is a backstop, not the primary mechanism. The group kill still does the
 * work in the ordinary case; this catches the escapees afterwards.
 */

const DEFAULT_GRACE_MS = 2_000;

export type ProcessEntry = {
  readonly pid: number;
  readonly command: string;
  readonly runId: string | null;
};

export type ReapDeps = {
  readonly listProcesses: () => Promise<readonly ProcessEntry[]>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly isAlive: (pid: number) => Promise<boolean>;
  readonly selfPid: number;
};

export type ReapOptions = {
  readonly graceMs?: number;
};

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Signals every surviving process carrying `runId`, escalating to SIGKILL for
 * any that ignore SIGTERM. Returns the pids actually signalled.
 *
 * Never throws. A reaper that fails the run it is cleaning up after would turn
 * a leak into an outage.
 */
export const reapRunSurvivors = async (
  runId: string,
  deps: ReapDeps,
  options: ReapOptions = {},
): Promise<readonly number[]> => {
  const survivors = await listSurvivors(runId, deps);
  if (survivors.length === 0) return [];

  const terminated = await signalEach(survivors, "SIGTERM", deps);
  if (terminated.length === 0) return [];

  await pause(options.graceMs ?? DEFAULT_GRACE_MS);

  const stubborn: number[] = [];
  for (const pid of terminated) {
    if (await deps.isAlive(pid)) stubborn.push(pid);
  }
  if (stubborn.length > 0) await signalEach(stubborn, "SIGKILL", deps);

  return terminated;
};

const listSurvivors = async (runId: string, deps: ReapDeps): Promise<readonly number[]> => {
  try {
    const processes = await deps.listProcesses();
    return processes
      .filter((entry) => entry.runId === runId && entry.pid !== deps.selfPid)
      .map((entry) => entry.pid);
  } catch {
    // An unreadable process table means no backstop, not a failed run.
    return [];
  }
};

const signalEach = async (
  pids: readonly number[],
  signal: NodeJS.Signals,
  deps: ReapDeps,
): Promise<readonly number[]> => {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      await deps.signal(pid, signal);
      signalled.push(pid);
    } catch {
      // Already gone, or not ours to kill. Either way the next one still matters.
    }
  }
  return signalled;
};
