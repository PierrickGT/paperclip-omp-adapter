/**
 * Runs one omp invocation for one Paperclip heartbeat.
 *
 * Process I/O arrives through `deps`, so the orchestration is testable without
 * spawning anything. `createServerAdapter` binds the real implementations.
 *
 * Two behaviours are load-bearing and easy to lose:
 *
 *  - `stdin` is never passed to the runner. `runChildProcess` pipes stdin only
 *    when given a value, and omp waits for EOF on a piped stdin — a run started
 *    with one never begins, and dies at the timeout with no output.
 *  - A resumed run that fails because omp dropped the session is retried once
 *    from scratch, and reports `clearSession` so Paperclip discards the stale id.
 *    The retry never retries itself.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { buildPaperclipEnv, redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";

import { buildOmpArgs } from "./args.js";
import { isOmpUnknownSessionError, parseOmpRun, type OmpRunResult } from "./parse.js";
import { buildOmpPrompt } from "./prompt.js";
import { canResumeSession, sessionCodec, type OmpSession } from "./session.js";
import type { PreparedSkills } from "./skills.js";

const DEFAULT_COMMAND = "omp";
const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_GRACE_SEC = 15;

export type ProcessOutcome = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunProcess = (
  runId: string,
  command: string,
  args: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutSec: number;
    readonly graceSec: number;
    readonly onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) => Promise<ProcessOutcome>;

export type ExecuteDeps = {
  readonly runProcess: RunProcess;
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly prepareSkills: (
    config: Record<string, unknown>,
    onWarn: (message: string) => Promise<void>,
  ) => Promise<PreparedSkills>;
};

export type ExecutionContext = {
  readonly runId: string;
  readonly agent: { readonly id: string; readonly companyId: string; readonly name: string };
  readonly runtime?: { readonly sessionParams?: unknown; readonly sessionId?: string | null } | undefined;
  readonly config: Record<string, unknown>;
  readonly context: Record<string, unknown>;
  readonly onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  readonly onMeta?: ((meta: Record<string, unknown>) => Promise<void>) | undefined;
  readonly authToken?: string | undefined;
};

export type ExecutionResult = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly errorMessage?: string | null;
  readonly usage?: OmpRunResult["usage"];
  readonly costUsd?: number | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly summary?: string | null;
  readonly sessionParams?: OmpSession | null;
  readonly sessionDisplayId?: string | null;
  readonly clearSession?: boolean;
  readonly resultJson?: Record<string, unknown> | null;
};

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asPositiveNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Wake context Paperclip injects so the agent knows why it is awake. */
const WAKE_ENV_KEYS: readonly (readonly [string, readonly string[]])[] = [
  ["PAPERCLIP_TASK_ID", ["taskId", "issueId"]],
  ["PAPERCLIP_WAKE_REASON", ["wakeReason"]],
  ["PAPERCLIP_WAKE_COMMENT_ID", ["wakeCommentId", "commentId"]],
  ["PAPERCLIP_APPROVAL_ID", ["approvalId"]],
  ["PAPERCLIP_APPROVAL_STATUS", ["approvalStatus"]],
];

const buildEnv = (ctx: ExecutionContext): Record<string, string> => {
  const env: Record<string, string> = { ...buildPaperclipEnv(ctx.agent), PAPERCLIP_RUN_ID: ctx.runId };

  for (const [key, sources] of WAKE_ENV_KEYS) {
    for (const source of sources) {
      const value = asTrimmed(ctx.context[source]);
      if (value !== null) {
        env[key] = value;
        break;
      }
    }
  }

  // Operator-supplied credentials go through the environment. They must never
  // reach the prompt, where the model would see them.
  for (const [key, value] of Object.entries(asRecord(ctx.config["env"]))) {
    const configured = asTrimmed(value);
    if (configured !== null) env[key] = configured;
  }

  const authToken = asTrimmed(ctx.authToken);
  if (authToken !== null) env["PAPERCLIP_API_KEY"] = authToken;

  return env;
};

const resolveCwd = (ctx: ExecutionContext): string =>
  asTrimmed(asRecord(ctx.context["paperclipWorkspace"])["cwd"]) ??
  asTrimmed(ctx.config["cwd"]) ??
  process.cwd();

const resolveSessionDir = (ctx: ExecutionContext): string =>
  asTrimmed(ctx.config["sessionDir"]) ?? join(homedir(), ".omp", "paperclip", ctx.agent.id);

const failureMessage = (outcome: ProcessOutcome): string | null => {
  if (outcome.timedOut) return "The omp run exceeded its time limit and was stopped.";
  if (outcome.exitCode === 0) return null;
  return asTrimmed(outcome.stderr) ?? `The omp run exited with code ${outcome.exitCode}.`;
};

const toResult = (
  outcome: ProcessOutcome,
  parsed: OmpRunResult,
  cwd: string,
  clearSession: boolean,
): ExecutionResult => {
  const session = parsed.sessionId === null ? null : { sessionId: parsed.sessionId, cwd };
  const errorMessage = failureMessage(outcome);

  // Keep the raw streams when there was nothing to parse, so a failure that the
  // parser could not describe is still diagnosable from the run record.
  const unparsed = parsed.summary.length === 0 && parsed.sessionId === null;

  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    errorMessage,
    summary: parsed.summary,
    usage: parsed.usage,
    costUsd: parsed.costUsd,
    provider: parsed.provider,
    model: parsed.model,
    sessionParams: sessionCodec.serialize(session),
    sessionDisplayId: sessionCodec.getDisplayId(session),
    resultJson: unparsed ? { stdout: outcome.stdout, stderr: outcome.stderr } : null,
    ...(clearSession ? { clearSession: true } : {}),
  };
};

export const execute = async (ctx: ExecutionContext, deps: ExecuteDeps): Promise<ExecutionResult> => {
  const command = asTrimmed(ctx.config["command"]) ?? DEFAULT_COMMAND;
  const cwd = resolveCwd(ctx);
  const sessionDir = resolveSessionDir(ctx);
  const env = buildEnv(ctx);

  await deps.ensureDirectory(cwd);

  // Staged once for the whole call: a session retry reuses the same skills
  // rather than rebuilding them.
  const skills = await deps.prepareSkills(ctx.config, async (message) => {
    await ctx.onLog("stderr", `[paperclip] ${message}\n`);
  });

  const stored = sessionCodec.deserialize(ctx.runtime?.sessionParams ?? ctx.runtime?.sessionId ?? null);
  const resumable = canResumeSession(stored, cwd) ? stored : null;

  const attempt = async (session: OmpSession | null): Promise<ProcessOutcome> => {
    const args = buildOmpArgs({
      prompt: buildOmpPrompt({
        agent: ctx.agent,
        runId: ctx.runId,
        context: ctx.context,
        promptTemplate: asTrimmed(ctx.config["promptTemplate"]) ?? undefined,
        // Passed through for correctness of intent. For every context shape
        // observed so far selectPaperclipTaskMarkdown ignores it, so no test can
        // distinguish the two values today.
        resumedSession: session !== null,
      }),
      cwd,
      sessionDir,
      model: asTrimmed(ctx.config["model"]) ?? undefined,
      thinking: asTrimmed(ctx.config["thinking"]) ?? undefined,
      resumeSessionId: session?.sessionId,
      instructionsFilePath: asTrimmed(ctx.config["instructionsFilePath"]) ?? undefined,
      configOverlays: skills.configOverlays,
    });

    await ctx.onMeta?.({
      command,
      args,
      cwd,
      sessionDir,
      env: redactEnvForLogs(env),
      resumedSession: session !== null,
    });

    // No `stdin` key: omp waits for EOF on a piped stdin and never starts.
    return deps.runProcess(ctx.runId, command, args, {
      cwd,
      env,
      timeoutSec: asPositiveNumber(ctx.config["timeoutSec"], DEFAULT_TIMEOUT_SEC),
      graceSec: asPositiveNumber(ctx.config["graceSec"], DEFAULT_GRACE_SEC),
      onLog: ctx.onLog,
    });
  };

  try {
    const first = await attempt(resumable);

    const sessionWentMissing =
      resumable !== null && !first.timedOut && first.exitCode !== 0 && isOmpUnknownSessionError(first.stderr);

    if (!sessionWentMissing) return toResult(first, parseOmpRun(first.stdout), cwd, false);

    const retry = await attempt(null);
    return toResult(retry, parseOmpRun(retry.stdout), cwd, true);
  } finally {
    await skills.cleanup();
  }
};
