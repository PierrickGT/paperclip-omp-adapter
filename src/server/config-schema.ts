/**
 * The settings the Paperclip agent form renders for an omp agent.
 *
 * External adapters describe their configuration declaratively; the React
 * `ConfigFields` component from the in-tree convention has no external
 * equivalent.
 *
 * Every key here is read by the server modules, and every key they read is
 * offered here — a test checks both directions against the source, so the form
 * cannot drift into advertising a setting the runtime ignores. That check is
 * what caught `extraArgs` being accepted by the argument builder but never read
 * from config.
 */

export type ConfigFieldType = "text" | "number" | "textarea" | "select" | "keyValue" | "stringList";

export type ConfigField = {
  readonly key: string;
  readonly label: string;
  readonly type: ConfigFieldType;
  readonly hint: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
};

export type ConfigSchema = {
  readonly fields: readonly ConfigField[];
};

/** The levels omp documents for `--thinking`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

const FIELDS: readonly ConfigField[] = [
  {
    key: "command",
    label: "omp command",
    type: "text",
    hint: "Command to run, resolved on the Paperclip server's PATH. Defaults to `omp`.",
    placeholder: "omp",
  },
  {
    key: "cwd",
    label: "Working directory",
    type: "text",
    hint: "Absolute path the agent works in. Ignored when Paperclip assigns an execution workspace. Created if missing.",
    placeholder: "/workspace/project",
  },
  {
    key: "model",
    label: "Model",
    type: "text",
    hint: "Passed to omp whole, so `anthropic/claude-opus-5` and `opus` both work. Run `omp models` to list them. Leave empty to use omp's own default.",
    placeholder: "anthropic/claude-opus-5",
  },
  {
    key: "thinking",
    label: "Thinking level",
    type: "select",
    hint: "How much reasoning omp does before answering. Leave empty to use omp's default.",
    options: THINKING_LEVELS,
  },
  {
    key: "sessionDir",
    label: "Session store",
    type: "text",
    hint: "Directory omp keeps this agent's sessions in. Defaults to a per-agent directory under ~/.omp/paperclip, which keeps resume working when the workspace moves.",
    placeholder: "/var/lib/paperclip/omp-sessions/agent-1",
  },
  {
    key: "instructionsFilePath",
    label: "Instructions file",
    type: "text",
    hint: "Absolute path to a markdown file appended to omp's system prompt. Pass the path alone — an @-prefixed path is silently ignored by omp.",
    placeholder: "/workspace/project/AGENT.md",
  },
  {
    key: "promptTemplate",
    label: "Prompt template",
    type: "textarea",
    hint: "Replaces Paperclip's default agent prompt. Supports {{agent.id}}, {{agent.name}}, {{company.id}} and {{runId}}. Leave empty to keep Paperclip's execution contract.",
  },
  {
    key: "timeoutSec",
    label: "Timeout (seconds)",
    type: "number",
    hint: "Stops the run after this long. Defaults to 900.",
  },
  {
    key: "graceSec",
    label: "Grace period (seconds)",
    type: "number",
    hint: "How long omp gets to exit after SIGTERM before it is killed. Defaults to 15.",
  },
  {
    key: "extraArgs",
    label: "Extra arguments",
    type: "stringList",
    hint: "Passed to omp verbatim, after every other flag. For example `--no-lsp`.",
  },
  {
    key: "env",
    label: "Environment variables",
    type: "keyValue",
    hint: "Provider credentials and any other variables the run needs. Secrets belong here, never in the prompt. For subscription plans rather than API keys, set OMP_AUTH_BROKER_URL and its bearer token here and run `omp auth-broker serve`.",
  },
];

export const getConfigSchema = (): ConfigSchema => ({ fields: FIELDS });
