import { describe, expect, it } from "vitest";

import { reapRunSurvivors, type ReapDeps } from "../src/server/reap.js";

/**
 * A run's children normally die with it: adapter-utils spawns omp detached and
 * signals the whole process group. Anything that calls setsid, or is spawned
 * detached in turn, leaves that group and survives the kill. Test-runner worker
 * pools do exactly this, and five escaped workers once held 17 GB for hours.
 *
 * Process group membership cannot see them, but the environment can:
 * PAPERCLIP_RUN_ID is stamped into the run and inherited by every descendant
 * however it was spawned.
 */

const aProcess = (pid: number, runId: string | null, command = "node") => ({
  pid,
  command,
  runId,
});

const depsFor = (
  processes: readonly { pid: number; command: string; runId: string | null }[],
  signalled: { pid: number; signal: string }[],
  self = 4242,
): ReapDeps => ({
  listProcesses: async () => processes,
  signal: async (pid, sig) => {
    signalled.push({ pid, signal: sig });
  },
  isAlive: async (pid) => processes.some((p) => p.pid === pid),
  selfPid: self,
});

describe("reaping what a finished run left behind", () => {
  it("kills a survivor carrying the run's id", async () => {
    const signalled: { pid: number; signal: string }[] = [];

    const reaped = await reapRunSurvivors("run-7", depsFor([aProcess(101, "run-7")], signalled), { graceMs: 0 });

    expect(reaped).toEqual([101]);
    expect(signalled).toContainEqual({ pid: 101, signal: "SIGTERM" });
  });

  it("leaves another run's processes alone", async () => {
    const signalled: { pid: number; signal: string }[] = [];

    const reaped = await reapRunSurvivors(
      "run-7",
      depsFor([aProcess(101, "run-8"), aProcess(102, "run-7")], signalled),
      { graceMs: 0 },
    );

    expect(reaped).toEqual([102]);
    expect(signalled.map((s) => s.pid)).not.toContain(101);
  });

  it("ignores processes with no run id at all", async () => {
    const signalled: { pid: number; signal: string }[] = [];

    const reaped = await reapRunSurvivors("run-7", depsFor([aProcess(101, null)], signalled), { graceMs: 0 });

    expect(reaped).toEqual([]);
    expect(signalled).toEqual([]);
  });

  it("never signals the adapter's own process, whatever its environment says", async () => {
    // The server stamps PAPERCLIP_RUN_ID into its own environment while a run
    // is in flight, so an unguarded sweep would terminate Paperclip itself.
    const signalled: { pid: number; signal: string }[] = [];

    const reaped = await reapRunSurvivors(
      "run-7",
      depsFor([aProcess(4242, "run-7"), aProcess(101, "run-7")], signalled, 4242),
      { graceMs: 0 },
    );

    expect(reaped).toEqual([101]);
    expect(signalled.map((s) => s.pid)).not.toContain(4242);
  });

  it("escalates to SIGKILL when a survivor ignores the first signal", async () => {
    const signalled: { pid: number; signal: string }[] = [];
    const deps: ReapDeps = {
      ...depsFor([aProcess(101, "run-7")], signalled),
      isAlive: async () => true,
    };

    await reapRunSurvivors("run-7", deps, { graceMs: 0 });

    expect(signalled).toEqual([
      { pid: 101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGKILL" },
    ]);
  });

  it("does not escalate when the survivor exits after SIGTERM", async () => {
    const signalled: { pid: number; signal: string }[] = [];
    const deps: ReapDeps = {
      ...depsFor([aProcess(101, "run-7")], signalled),
      isAlive: async () => false,
    };

    await reapRunSurvivors("run-7", deps, { graceMs: 0 });

    expect(signalled.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });

  it("reports nothing rather than throwing when the process list is unreadable", async () => {
    const deps: ReapDeps = {
      listProcesses: async () => {
        throw new Error("procfs unavailable");
      },
      signal: async () => {},
      isAlive: async () => false,
      selfPid: 1,
    };

    await expect(reapRunSurvivors("run-7", deps)).resolves.toEqual([]);
  });

  it("keeps reaping after one survivor cannot be signalled", async () => {
    const signalled: { pid: number; signal: string }[] = [];
    const deps: ReapDeps = {
      ...depsFor([aProcess(101, "run-7"), aProcess(102, "run-7")], signalled),
      signal: async (pid, sig) => {
        if (pid === 101) throw new Error("no such process");
        signalled.push({ pid, signal: sig });
      },
    };

    const reaped = await reapRunSurvivors("run-7", deps, { graceMs: 0 });

    expect(reaped).toEqual([102]);
  });
});
