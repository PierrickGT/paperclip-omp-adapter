import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createServerAdapter } from "../src/server/index.js";
import type { ExecutionContext, ExecutionResult } from "../src/server/execute.js";

/**
 * The only test that runs omp for real.
 *
 * Everything else replaces the process runner with a fake, which proves the
 * orchestration but not the assumptions underneath it: that these flags exist,
 * that this is the event stream omp emits, that a session resumes. Those are
 * exactly the assumptions PR #2810 got wrong, so they are worth checking against
 * the binary at least once.
 *
 * Skipped unless OMP_ADAPTER_LIVE=1, because it needs omp installed, costs money
 * and takes minutes. Run it with `pnpm test:live`.
 */

const live = process.env["OMP_ADAPTER_LIVE"] === "1";
const describeLive = live ? describe : describe.skip;

const RUN_TIMEOUT_MS = 300_000;

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })));
});

const aWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "omp-adapter-live-"));
  workspaces.push(dir);
  return dir;
};

const aContext = (cwd: string, task: string, overrides?: Partial<ExecutionContext>): ExecutionContext => ({
  runId: `live-${Date.now()}`,
  agent: { id: "live-agent", companyId: "live-company", name: "Live Agent" },
  config: {
    cwd,
    sessionDir: join(cwd, ".sessions"),
    timeoutSec: 240,
    graceSec: 5,
    extraArgs: ["--no-lsp"],
    // Paperclip's default prompt describes a control plane that is not running
    // here, so the task is given plainly instead.
    promptTemplate: task,
  },
  context: {},
  onLog: async () => {},
  ...overrides,
});

const run = (ctx: ExecutionContext): Promise<ExecutionResult> => createServerAdapter().execute(ctx);

describeLive("running omp for real", () => {
  it(
    "answers, and reports what the run cost",
    async () => {
      const cwd = await aWorkspace();

      const result = await run(aContext(cwd, "Reply with exactly: LIVEOK"));

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("LIVEOK");
      expect(result.errorMessage ?? null).toBeNull();
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.provider).toBeTruthy();
      expect(result.model).toBeTruthy();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "remembers the previous heartbeat when it resumes",
    async () => {
      const cwd = await aWorkspace();

      const first = await run(aContext(cwd, "Remember the word MARMALADE. Reply with exactly: STORED"));
      expect(first.sessionParams).not.toBeNull();

      const second = await run(
        aContext(cwd, "What word did I ask you to remember? Reply with the word alone.", {
          runtime: { sessionParams: first.sessionParams },
        }),
      );

      expect(second.summary).toContain("MARMALADE");
      expect(second.clearSession ?? false).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "starts over when the session it was given is gone",
    async () => {
      const cwd = await aWorkspace();

      const result = await run(
        aContext(cwd, "Reply with exactly: RECOVERED", {
          runtime: {
            sessionParams: { sessionId: "00000000-0000-7000-0000-000000000000", cwd },
          },
        }),
      );

      expect(result.clearSession).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("RECOVERED");
      expect(result.sessionParams).not.toBeNull();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "leaves nothing of its own in the agent's directory",
    async () => {
      const cwd = await aWorkspace();
      await writeFile(join(cwd, "only-file.txt"), "untouched\n", "utf8");

      await run(aContext(cwd, "Reply with exactly: DONE"));

      const { readdir } = await import("node:fs/promises");
      const left = (await readdir(cwd)).filter((name) => name !== ".sessions");

      expect(left).toEqual(["only-file.txt"]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "finds omp on this host and reports its version",
    async () => {
      const result = await createServerAdapter().testEnvironment({
        companyId: "live-company",
        adapterType: "omp",
        config: {},
      });

      expect(result.status).toBe("pass");
      expect(JSON.stringify(result.checks)).toMatch(/\d+\.\d+\.\d+/);
    },
    RUN_TIMEOUT_MS,
  );
});
