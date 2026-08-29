/**
 * The adapter's entry point — the `.` export Paperclip's plugin loader resolves.
 *
 * Everything below is wiring. The decisions live in the modules this imports,
 * each of which takes its filesystem and process work as an injected dependency;
 * `createServerAdapter` is where those dependencies meet their real
 * implementations.
 */

import {
  ensureAbsoluteDirectory,
  readPaperclipRuntimeSkillEntries,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getConfigSchema } from "./config-schema.js";
import { execute as runOmp, type ExecuteDeps, type ExecutionContext, type ExecutionResult } from "./execute.js";
import { reapRunSurvivors } from "./reap.js";
import { withRunLock } from "./run-lock.js";
import {
  isDirectory,
  isProcessAlive,
  listRunProcesses,
  readCommandVersion,
  resolveCommandPath,
  runLockDeps,
  signalProcess,
  stagingDeps,
} from "./runtime.js";
import { sessionCodec } from "./session.js";
import { prepareSkills, type SkillEntry } from "./skills.js";
import { testEnvironment as checkEnvironment, type EnvironmentTestResult } from "./test-environment.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const type = "omp";

export const label = "omp";

/** omp resolves models itself, including by fuzzy match, so the form takes free text. */
export const models: readonly { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# omp agent configuration

Adapter: omp

Runs [omp](https://omp.sh) as the agent runtime, as a child process on the
Paperclip host.

## Use when

- The agent should work in a real checkout with omp's tools: editing, shell, LSP-aware navigation.
- The work spans several heartbeats and the agent must remember what it already read and decided.
- You want omp's model routing, including subscription plans rather than API keys.

## Don't use when

- The task is a single shell command with no conversation — the \`process\` adapter is simpler.
- The agent must be reached by webhook rather than run locally — use a gateway adapter.
- omp is not installed on the Paperclip host. Run "Test environment" to check.

## Settings

- \`command\` (string): the omp executable. Defaults to \`omp\`, resolved on the server's PATH.
- \`cwd\` (string): absolute working directory. Ignored when Paperclip assigns an execution workspace. Created if missing.
- \`model\` (string): passed to omp whole, so \`anthropic/claude-opus-5\` and \`opus\` both work. Run \`omp models\` to list them.
- \`thinking\` (string): one of off, minimal, low, medium, high, xhigh, max, auto.
- \`sessionDir\` (string): where omp keeps this agent's sessions. Defaults to a per-agent directory, which keeps resume working when the workspace moves.
- \`instructionsFilePath\` (string): absolute path to a markdown file appended to omp's system prompt.
- \`promptTemplate\` (string): replaces Paperclip's default agent prompt. Supports {{agent.id}}, {{agent.name}}, {{company.id}}, {{runId}}.
- \`timeoutSec\` (number): stops the run after this long. Defaults to 900.
- \`graceSec\` (number): seconds between SIGTERM and SIGKILL. Defaults to 15.
- \`extraArgs\` (string[]): passed to omp verbatim, after every other flag.
- \`env\` (object): environment variables for the run. Credentials belong here.

## Credentials

Set provider keys such as \`ANTHROPIC_API_KEY\` in \`env\`. They reach the agent
through the process environment and never through the prompt.

Subscription plans have no API key to paste. For those, run \`omp auth-broker serve\`
and set \`OMP_AUTH_BROKER_URL\` and its bearer token in \`env\` instead.

## Notes

- Sessions resume automatically between heartbeats. A session recorded in a different
  working directory is not resumed, so one project's context cannot leak into another.
- If omp has dropped the session, the run retries once from scratch rather than failing.
- Never give omp a piped stdin. It waits for EOF and the run never starts. This adapter
  does not, but anything else invoking omp must take the same care.
`;

const toSkillEntries = async (config: Record<string, unknown>): Promise<readonly SkillEntry[]> => {
  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  return entries.filter((entry) => entry.sourceStatus !== "missing");
};

const executeDeps: ExecuteDeps = {
  runProcess: (runId, command, args, opts) =>
    runChildProcess(runId, command, [...args], { ...opts, env: { ...opts.env } }),

  ensureDirectory: (path) => ensureAbsoluteDirectory(path, { createIfMissing: true }),

  prepareSkills: (config, onWarn) =>
    prepareSkills(config, { ...stagingDeps, listSkills: () => toSkillEntries(config) }, onWarn),

  withRunLock: (agentId, work) => withRunLock(agentId, runLockDeps, work),

  reapSurvivors: (runId) =>
    reapRunSurvivors(runId, {
      listProcesses: listRunProcesses,
      signal: signalProcess,
      isAlive: isProcessAlive,
      selfPid: process.pid,
    }),
};

export const createServerAdapter = () => ({
  type,
  label,
  models,
  agentConfigurationDoc,
  sessionCodec,
  getConfigSchema,
  supportsLocalAgentJwt: true,

  // Undeclared, the host falls back to an allow-list of built-in adapter types,
  // stops regenerating the agent's AGENTS.md and resolves the instructions path
  // key to null — leaving `instructionsFilePath` empty for every managed agent.
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath" as const,

  execute: (ctx: ExecutionContext): Promise<ExecutionResult> => runOmp(ctx, executeDeps),

  testEnvironment: (ctx: {
    readonly companyId?: string;
    readonly adapterType?: string;
    readonly config: Record<string, unknown>;
  }): Promise<EnvironmentTestResult> =>
    checkEnvironment(ctx.config, {
      findCommand: (command) => resolveCommandPath(command, process.env),
      readVersion: readCommandVersion,
      isDirectory,
      now: () => new Date(),
    }),
});

export default createServerAdapter;
