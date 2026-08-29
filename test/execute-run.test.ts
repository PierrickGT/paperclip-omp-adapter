import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  execute,
  type ExecuteDeps,
  type ExecutionContext,
  type ProcessOutcome,
  type RunProcess,
} from "../src/server/execute.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

const A_SUCCESSFUL_RUN = readFixture("01-plain-answer.jsonl");
const A_TOOL_RUN = readFixture("03-tool-use.jsonl");
const STALE_SESSION_STDERR = readFixture("04-unknown-session.stderr");
const A_SESSION_ID = "01a030e2-a211-7000-9964-0903ee42ed0f";

const anOutcome = (overrides?: Partial<ProcessOutcome>): ProcessOutcome => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: A_SUCCESSFUL_RUN,
  stderr: "",
  ...overrides,
});

type RecordedRun = {
  runId: string;
  command: string;
  args: readonly string[];
  opts: Parameters<RunProcess>[3];
};

const aRunner = (outcomes: ProcessOutcome[] = [anOutcome()]) => {
  const runs: RecordedRun[] = [];
  const events: string[] = [];
  const runProcess: RunProcess = async (runId, command, args, opts) => {
    events.push("spawn");
    runs.push({ runId, command, args, opts });
    return outcomes[runs.length - 1] ?? outcomes[outcomes.length - 1] ?? anOutcome();
  };
  return { runProcess, runs, events };
};

const deps = (
  runner: ReturnType<typeof aRunner>,
  ensured: string[] = [],
  overrides?: Partial<ExecuteDeps>,
): ExecuteDeps => ({
  runProcess: runner.runProcess,
  ensureDirectory: async (path) => {
    ensured.push(path);
  },
  prepareSkills: async () => ({ configOverlays: [], cleanup: async () => {} }),
  ...overrides,
});

const aContext = (overrides?: Partial<ExecutionContext>): ExecutionContext => ({
  runId: "run-42",
  agent: { id: "agent-1", companyId: "company-9", name: "Ada" },
  config: { cwd: "/workspace/project", sessionDir: "/sessions/agent-1" },
  context: {},
  onLog: async () => {},
  ...overrides,
});

const argValue = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

describe("reporting what a completed run produced", () => {
  it("returns the agent's answer as the run summary", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.summary).toBe("OK");
  });

  it("returns token usage and cost under Paperclip's field names", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.usage).toEqual({ inputTokens: 89, outputTokens: 3, cachedInputTokens: 27008 });
    expect(result.costUsd).toBeCloseTo(0.00715988, 10);
  });

  it("returns the model omp actually used, not the one configured", async () => {
    const runner = aRunner();

    const result = await execute(aContext({ config: { model: "opus", cwd: "/workspace/project" } }), deps(runner));

    expect(result.provider).toBe("zai");
    expect(result.model).toBe("glm-5.3");
  });

  it("passes the process outcome through unchanged", async () => {
    const runner = aRunner([anOutcome({ exitCode: 0, signal: null, timedOut: false })]);

    const result = await execute(aContext(), deps(runner));

    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
  });

  it("hands back the session so the next heartbeat can resume it", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.sessionParams).toEqual({ sessionId: A_SESSION_ID, cwd: "/workspace/project" });
    expect(result.sessionDisplayId).toBe("01a030e2");
  });
});

describe("starting the process", () => {
  it("runs the configured command in the configured directory", async () => {
    const runner = aRunner();

    await execute(aContext({ config: { command: "omp-nightly", cwd: "/workspace/project" } }), deps(runner));

    expect(runner.runs[0]?.command).toBe("omp-nightly");
    expect(runner.runs[0]?.opts.cwd).toBe("/workspace/project");
  });

  it("runs plain omp when no command is configured", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(runner.runs[0]?.command).toBe("omp");
  });

  it("never hands the child any stdin, which would make omp wait for EOF", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(runner.runs[0]?.opts).not.toHaveProperty("stdin");
  });

  it("creates the working directory before starting", async () => {
    const ensured: string[] = [];
    const runner = aRunner();

    await execute(aContext(), deps(runner, ensured));

    expect(ensured).toContain("/workspace/project");
  });

  it("prefers the workspace directory Paperclip assigned over the configured one", async () => {
    const runner = aRunner();
    const context = aContext({
      config: { cwd: "/workspace/fallback", sessionDir: "/sessions/agent-1" },
      context: { paperclipWorkspace: { cwd: "/workspace/assigned" } },
    });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.opts.cwd).toBe("/workspace/assigned");
  });

  it("falls back to plain omp when the configured command is left blank", async () => {
    const runner = aRunner();

    await execute(aContext({ config: { command: "   ", cwd: "/workspace/project" } }), deps(runner));

    expect(runner.runs[0]?.command).toBe("omp");
  });

  it("runs where the server is when no directory is configured at all", async () => {
    const runner = aRunner();

    await execute(aContext({ config: {} }), deps(runner));

    expect(runner.runs[0]?.opts.cwd).toBe(process.cwd());
  });

  it("streams the run's output to Paperclip as it arrives", async () => {
    const logged: string[] = [];
    const runner = aRunner();
    const context = aContext({
      onLog: async (stream, chunk) => {
        logged.push(`${stream}:${chunk}`);
      },
    });

    await execute(context, deps(runner));
    await runner.runs[0]?.opts.onLog("stdout", "hello");

    expect(logged).toContain("stdout:hello");
  });

  it("keeps each agent's sessions where the operator asked", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(argValue(runner.runs[0]?.args ?? [], "--session-dir")).toBe("/sessions/agent-1");
  });

  it("keeps each agent's sessions apart when no store is configured", async () => {
    const runner = aRunner();

    await execute(aContext({ config: { cwd: "/workspace/project" } }), deps(runner));

    expect(argValue(runner.runs[0]?.args ?? [], "--session-dir")).toContain("agent-1");
  });

  it("ignores a time limit that would stop the run before it starts", async () => {
    const runner = aRunner();
    const context = aContext({ config: { cwd: "/workspace/project", timeoutSec: 0, graceSec: -1 } });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.opts.timeoutSec).toBe(900);
    expect(runner.runs[0]?.opts.graceSec).toBe(15);
  });

  it("passes the operator's extra arguments through to omp", async () => {
    const runner = aRunner();
    const context = aContext({
      config: { cwd: "/workspace/project", extraArgs: ["--no-lsp", "--max-time", "10m"] },
    });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.args).toContain("--no-lsp");
    expect(runner.runs[0]?.args).toContain("10m");
  });

  it("ignores extra arguments that are not a list of strings", async () => {
    const runner = aRunner();
    const context = aContext({ config: { cwd: "/workspace/project", extraArgs: "--no-lsp" } });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.args).not.toContain("--no-lsp");
  });

  it("applies the configured time limits", async () => {
    const runner = aRunner();
    const context = aContext({ config: { cwd: "/workspace/project", timeoutSec: 60, graceSec: 5 } });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.opts.timeoutSec).toBe(60);
    expect(runner.runs[0]?.opts.graceSec).toBe(5);
  });
});

describe("describing the invocation before it starts", () => {
  it("reports the invocation before spawning, not after", async () => {
    const runner = aRunner();
    const context = aContext({
      onMeta: async () => {
        runner.events.push("meta");
      },
    });

    await execute(context, deps(runner));

    expect(runner.events).toEqual(["meta", "spawn"]);
  });

  it("masks secrets in the environment it reports", async () => {
    const seen: Record<string, unknown>[] = [];
    const runner = aRunner();
    const context = aContext({
      config: { cwd: "/workspace/project", env: { ANTHROPIC_API_KEY: "sk-do-not-log" } },
      onMeta: async (meta) => {
        seen.push(meta);
      },
    });

    await execute(context, deps(runner));

    expect(JSON.stringify(seen)).not.toContain("sk-do-not-log");
    expect(JSON.stringify(seen)).toContain("REDACTED");
  });

  it("runs without complaint when nobody is listening for the invocation", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.summary).toBe("OK");
  });
});

describe("giving the agent its Paperclip identity", () => {
  it("passes the agent and company through the environment", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(runner.runs[0]?.opts.env).toMatchObject({
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-9",
      PAPERCLIP_RUN_ID: "run-42",
    });
  });

  it("passes the wake context so the agent knows why it was woken", async () => {
    const runner = aRunner();
    const context = aContext({
      context: { taskId: "issue-7", wakeReason: "assignment", wakeCommentId: "comment-3" },
    });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.opts.env).toMatchObject({
      PAPERCLIP_TASK_ID: "issue-7",
      PAPERCLIP_WAKE_REASON: "assignment",
      PAPERCLIP_WAKE_COMMENT_ID: "comment-3",
    });
  });

  it("gives the agent its API key through the environment, never the prompt", async () => {
    const runner = aRunner();

    await execute(aContext({ authToken: "jwt-token" }), deps(runner));

    expect(runner.runs[0]?.opts.env["PAPERCLIP_API_KEY"]).toBe("jwt-token");
    expect(runner.runs[0]?.args.join(" ")).not.toContain("jwt-token");
  });

  it("passes provider credentials the operator configured", async () => {
    const runner = aRunner();
    const context = aContext({
      config: { cwd: "/workspace/project", env: { ANTHROPIC_API_KEY: "sk-configured" } },
    });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.opts.env["ANTHROPIC_API_KEY"]).toBe("sk-configured");
  });

  it("omits wake context the run does not have", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(runner.runs[0]?.opts.env).not.toHaveProperty("PAPERCLIP_TASK_ID");
  });
});

describe("continuing an earlier conversation", () => {
  it("resumes the session Paperclip is holding", async () => {
    const runner = aRunner();
    const context = aContext({
      runtime: { sessionParams: { sessionId: A_SESSION_ID, cwd: "/workspace/project" } },
    });

    await execute(context, deps(runner));

    expect(argValue(runner.runs[0]?.args ?? [], "--resume")).toBe(A_SESSION_ID);
  });

  it("resumes a session Paperclip stored under the legacy identifier", async () => {
    const runner = aRunner();
    const context = aContext({ runtime: { sessionId: A_SESSION_ID } });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.args).not.toContain("--resume");
  });

  it("starts fresh when there is no session to continue", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner));

    expect(runner.runs[0]?.args).not.toContain("--resume");
  });

  it("starts fresh rather than dragging a session in from another project", async () => {
    const runner = aRunner();
    const context = aContext({
      runtime: { sessionParams: { sessionId: A_SESSION_ID, cwd: "/workspace/other" } },
    });

    await execute(context, deps(runner));

    expect(runner.runs[0]?.args).not.toContain("--resume");
  });
});

describe("recovering from a session omp has dropped", () => {
  const staleThenFresh = () =>
    aRunner([
      anOutcome({ exitCode: 1, stdout: "", stderr: STALE_SESSION_STDERR }),
      anOutcome({ stdout: A_TOOL_RUN }),
    ]);

  const resumingContext = () =>
    aContext({ runtime: { sessionParams: { sessionId: A_SESSION_ID, cwd: "/workspace/project" } } });

  it("retries once with a fresh session", async () => {
    const runner = staleThenFresh();

    await execute(resumingContext(), deps(runner));

    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]?.args).not.toContain("--resume");
  });

  it("returns the retry's result rather than the failure", async () => {
    const runner = staleThenFresh();

    const result = await execute(resumingContext(), deps(runner));

    expect(result.summary).toContain("alpha.txt");
    expect(result.exitCode).toBe(0);
  });

  it("tells Paperclip to forget the session it was holding", async () => {
    const runner = staleThenFresh();

    const result = await execute(resumingContext(), deps(runner));

    expect(result.clearSession).toBe(true);
  });

  it("gives up after one retry rather than looping", async () => {
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: "", stderr: STALE_SESSION_STDERR })]);

    const result = await execute(resumingContext(), deps(runner));

    expect(runner.runs).toHaveLength(2);
    expect(result.errorMessage).toBeTruthy();
  });

  it("does not retry a fresh run that failed for some other reason", async () => {
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: "", stderr: STALE_SESSION_STDERR })]);

    await execute(aContext(), deps(runner));

    expect(runner.runs).toHaveLength(1);
  });

  it("does not retry a resumed run that failed for some other reason", async () => {
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: "", stderr: "Error: disk full." })]);

    await execute(resumingContext(), deps(runner));

    expect(runner.runs).toHaveLength(1);
  });

  it("does not retry a run that was stopped for running too long", async () => {
    const runner = aRunner([
      anOutcome({ exitCode: null, timedOut: true, stdout: "", stderr: STALE_SESSION_STDERR }),
    ]);

    await execute(resumingContext(), deps(runner));

    expect(runner.runs).toHaveLength(1);
  });

  it("does not retry a run that succeeded despite noise on stderr", async () => {
    const runner = aRunner([anOutcome({ exitCode: 0, stderr: STALE_SESSION_STDERR })]);

    await execute(resumingContext(), deps(runner));

    expect(runner.runs).toHaveLength(1);
  });

  it("leaves a healthy session in place", async () => {
    const runner = aRunner();

    const result = await execute(resumingContext(), deps(runner));

    expect(result.clearSession ?? false).toBe(false);
  });

  it("leaves a healthy fresh run's session in place", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.clearSession ?? false).toBe(false);
  });
});

describe("reporting a run that went wrong", () => {
  it("reports a failure instead of throwing", async () => {
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: "", stderr: "Error: disk full." })]);

    const result = await execute(aContext(), deps(runner));

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("disk full");
  });

  it("reports a run that ran out of time, and says that is why", async () => {
    const runner = aRunner([anOutcome({ exitCode: null, timedOut: true, stdout: "", stderr: "" })]);

    const result = await execute(aContext(), deps(runner));

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("time limit");
  });

  it("keeps no raw output when the run was understood", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.resultJson ?? null).toBeNull();
  });

  it("keeps no raw output when the run was cut short but still identifiable", async () => {
    const truncated = A_SUCCESSFUL_RUN.split("\n").slice(0, 3).join("\n");
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: truncated, stderr: "killed" })]);

    const result = await execute(aContext(), deps(runner));

    expect(result.sessionParams).not.toBeNull();
    expect(result.resultJson ?? null).toBeNull();
  });

  it("keeps the raw output when nothing could be parsed from it", async () => {
    const runner = aRunner([anOutcome({ exitCode: 1, stdout: "garbage", stderr: "also garbage" })]);

    const result = await execute(aContext(), deps(runner));

    expect(JSON.stringify(result.resultJson)).toContain("garbage");
    expect(JSON.stringify(result.resultJson)).toContain("also garbage");
  });

  it("names the exit code when the run failed silently", async () => {
    const runner = aRunner([anOutcome({ exitCode: 3, stdout: "", stderr: "" })]);

    const result = await execute(aContext(), deps(runner));

    expect(result.errorMessage).toContain("3");
  });

  it("says nothing extra when the run succeeded", async () => {
    const runner = aRunner();

    const result = await execute(aContext(), deps(runner));

    expect(result.errorMessage ?? null).toBeNull();
  });
});

describe("giving the run access to Paperclip's skills", () => {
  const withSkills = (cleanup: () => Promise<void> = async () => {}): Partial<ExecuteDeps> => ({
    prepareSkills: async () => ({ configOverlays: ["/tmp/skills/omp-overlay.yml"], cleanup }),
  });

  it("loads the skills overlay into the run", async () => {
    const runner = aRunner();

    await execute(aContext(), deps(runner, [], withSkills()));

    expect(argValue(runner.runs[0]?.args ?? [], "--config")).toBe("/tmp/skills/omp-overlay.yml");
  });

  it("clears the staged skills away once the run is over", async () => {
    const cleaned: string[] = [];
    const runner = aRunner();

    await execute(
      aContext(),
      deps(runner, [], withSkills(async () => {
        cleaned.push("cleaned");
      })),
    );

    expect(cleaned).toEqual(["cleaned"]);
  });

  it("clears the staged skills away even when the run blows up", async () => {
    const cleaned: string[] = [];
    const runner = aRunner();
    const failing: ExecuteDeps = {
      ...deps(runner, [], withSkills(async () => {
        cleaned.push("cleaned");
      })),
      runProcess: async () => {
        throw new Error("spawn failed");
      },
    };

    await expect(execute(aContext(), failing)).rejects.toThrow("spawn failed");
    expect(cleaned).toEqual(["cleaned"]);
  });

  it("passes a skills warning through to the run log", async () => {
    const logged: string[] = [];
    const runner = aRunner();
    const context = aContext({
      onLog: async (stream, chunk) => {
        logged.push(`${stream}:${chunk}`);
      },
    });

    await execute(
      context,
      deps(runner, [], {
        prepareSkills: async (_config, onWarn) => {
          await onWarn("could not expose the paperclip skill");
          return { configOverlays: [], cleanup: async () => {} };
        },
      }),
    );

    expect(logged.join(" ")).toContain("could not expose the paperclip skill");
  });

  it("stages the skills only once across a session retry", async () => {
    let staged = 0;
    const runner = aRunner([
      anOutcome({ exitCode: 1, stdout: "", stderr: STALE_SESSION_STDERR }),
      anOutcome({ stdout: A_TOOL_RUN }),
    ]);
    const context = aContext({
      runtime: { sessionParams: { sessionId: A_SESSION_ID, cwd: "/workspace/project" } },
    });

    await execute(
      context,
      deps(runner, [], {
        prepareSkills: async () => {
          staged += 1;
          return { configOverlays: ["/tmp/skills/omp-overlay.yml"], cleanup: async () => {} };
        },
      }),
    );

    expect(staged).toBe(1);
    expect(runner.runs).toHaveLength(2);
  });
});

describe("cleaning up processes the kill did not reach", () => {
  it("reaps survivors after a run that timed out", async () => {
    // adapter-utils signals the process group, which misses anything that
    // called setsid. Those survivors are the ones that leaked 17 GB.
    const reaped: string[] = [];
    const runner = aRunner([anOutcome({ timedOut: true, exitCode: null, signal: "SIGTERM" })]);

    await execute(
      aContext(),
      deps(runner, [], {
        reapSurvivors: async (runId) => {
          reaped.push(runId);
          return [];
        },
      }),
    );

    expect(reaped).toEqual(["run-42"]);
  });

  it("reaps survivors after a run that exited normally", async () => {
    // A clean exit is no guarantee: a detached grandchild outlives it too.
    const reaped: string[] = [];
    const runner = aRunner();

    await execute(
      aContext(),
      deps(runner, [], {
        reapSurvivors: async (runId) => {
          reaped.push(runId);
          return [];
        },
      }),
    );

    expect(reaped).toEqual(["run-42"]);
  });

  it("still returns the run's result when reaping throws", async () => {
    const runner = aRunner();

    const result = await execute(
      aContext(),
      deps(runner, [], {
        reapSurvivors: async () => {
          throw new Error("procfs unavailable");
        },
      }),
    );

    expect(result.exitCode).toBe(0);
  });
})

describe("refusing to stack runs for one agent", () => {
  it("passes the agent id to the lock and runs the work inside it", async () => {
    const locked: string[] = [];
    const runner = aRunner();

    const result = await execute(
      aContext(),
      deps(runner, [], {
        withRunLock: async (agentId, work) => {
          locked.push(agentId);
          return work();
        },
      }),
    );

    expect(locked).toEqual(["agent-1"]);
    expect(result.exitCode).toBe(0);
    expect(runner.runs).toHaveLength(1);
  });

  it("does not spawn omp when the lock refuses the run", async () => {
    const runner = aRunner();

    await expect(
      execute(
        aContext(),
        deps(runner, [], {
          withRunLock: async () => {
            throw new Error("already has an omp run in flight");
          },
        }),
      ),
    ).rejects.toThrow("already has an omp run in flight");

    expect(runner.runs).toHaveLength(0);
  });
})
