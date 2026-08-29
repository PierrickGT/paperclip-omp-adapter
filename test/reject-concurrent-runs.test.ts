import { describe, expect, it } from "vitest";

import { withRunLock, type RunLockDeps, ConcurrentRunError } from "../src/server/run-lock.js";

/**
 * Paperclip once scheduled five heartbeat runs for one agent, five seconds
 * apart, all on the same issue. Every one of them spawned omp against the same
 * `--session-dir`.
 *
 * That is wrong twice over. Concurrent omp processes sharing a session store
 * corrupt the resume the adapter depends on, and each extra run multiplies
 * whatever the agent is doing — which is how five test-runner worker pools
 * ended up alive at once.
 *
 * The scheduler is the server's to fix. The adapter can still refuse to be the
 * thing that multiplies.
 */

const aLock = () => {
  const held = new Set<string>();
  const deps: RunLockDeps = {
    acquire: async (key) => {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release: async (key) => {
      held.delete(key);
    },
  };
  return { deps, held };
};

describe("refusing to run an agent twice at once", () => {
  it("runs the work while holding the lock", async () => {
    const { deps } = aLock();

    const result = await withRunLock("agent-1", deps, async () => "done");

    expect(result).toBe("done");
  });

  it("releases the lock so the next run can proceed", async () => {
    const { deps, held } = aLock();

    await withRunLock("agent-1", deps, async () => "first");
    const second = await withRunLock("agent-1", deps, async () => "second");

    expect(second).toBe("second");
    expect(held.size).toBe(0);
  });

  it("releases the lock even when the work throws", async () => {
    const { deps, held } = aLock();

    await expect(
      withRunLock("agent-1", deps, async () => {
        throw new Error("omp exploded");
      }),
    ).rejects.toThrow("omp exploded");

    expect(held.size).toBe(0);
  });

  it("refuses a second run for the same agent while the first holds the lock", async () => {
    const { deps } = aLock();
    let inner: unknown = null;

    await withRunLock("agent-1", deps, async () => {
      inner = await withRunLock("agent-1", deps, async () => "should not run").catch((err) => err);
      return "outer";
    });

    expect(inner).toBeInstanceOf(ConcurrentRunError);
  });

  it("names the agent in the refusal, so the log says which one stacked", async () => {
    const { deps } = aLock();

    await withRunLock("agent-7", deps, async () => {
      const err = await withRunLock("agent-7", deps, async () => "x").catch((e) => e);
      expect(String(err.message)).toContain("agent-7");
      return "outer";
    });
  });

  it("lets a different agent run concurrently", async () => {
    const { deps } = aLock();

    await withRunLock("agent-1", deps, async () => {
      const other = await withRunLock("agent-2", deps, async () => "other");
      expect(other).toBe("other");
      return "outer";
    });
  });

  it("runs the work anyway when the lock itself cannot be taken", async () => {
    // A broken lock must not stop an agent working. Failing open keeps the
    // adapter useful on a host where the lock directory is unwritable.
    const deps: RunLockDeps = {
      acquire: async () => {
        throw new Error("read-only filesystem");
      },
      release: async () => {},
    };

    await expect(withRunLock("agent-1", deps, async () => "done")).resolves.toBe("done");
  });
});

describe("the real lock on this host", () => {
  it("blocks a second acquire and frees on release", async () => {
    const { runLockDeps } = await import("../src/server/runtime.js");
    const agent = `test-agent-${process.pid}-a`;

    expect(await runLockDeps.acquire(agent)).toBe(true);
    expect(await runLockDeps.acquire(agent)).toBe(false);

    await runLockDeps.release(agent);
    expect(await runLockDeps.acquire(agent)).toBe(true);

    await runLockDeps.release(agent);
  });

  it("steals a lock whose holder no longer exists", async () => {
    // Paperclip killed mid-run leaves the lock behind. Without stealing it,
    // that agent would never run again.
    const { runLockDeps } = await import("../src/server/runtime.js");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const agent = `test-agent-${process.pid}-b`;
    const dir = join(tmpdir(), "paperclip-omp-locks");
    await mkdir(dir, { recursive: true });
    // A pid that cannot be running: 2^22 is above every Linux pid_max default.
    await writeFile(join(dir, `${agent}.lock`), "4194304");

    expect(await runLockDeps.acquire(agent)).toBe(true);

    await runLockDeps.release(agent);
  });
});
