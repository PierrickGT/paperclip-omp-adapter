/**
 * Parser for omp's `--mode json` event stream.
 *
 * Two properties of the stream drive the shape of this code, both established by
 * recorded fixtures rather than documentation:
 *
 *  - The terminal `agent_end` event is not necessarily the last line. Advisor
 *    `notice` events can follow it, so the event is located by type, never by
 *    position.
 *  - Usage is reported per assistant message and must be summed, while the answer
 *    comes from the last assistant message alone.
 *
 * Output is untrusted: it comes from an LLM-driven process that may have read
 * attacker-influenced content. Every field is narrowed before use.
 */

export type OmpUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

/** Token counts omp reports that have no field in Paperclip's result contract. */
export type OmpExtraTokens = {
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
};

export type OmpRunResult = {
  readonly sessionId: string | null;
  readonly summary: string;
  readonly usage: OmpUsage | null;
  readonly costUsd: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly extraTokens: OmpExtraTokens | null;
};

type JsonRecord = Record<string, unknown>;

type RunTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
};

const NO_TOTALS: RunTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

const EMPTY_RESULT: OmpRunResult = {
  sessionId: null,
  summary: "",
  usage: null,
  costUsd: null,
  provider: null,
  model: null,
  extraTokens: null,
};

/**
 * Narrows a parsed JSON value to an event object.
 *
 * Mutating any of the three checks here produces an equivalent mutant: arrays and
 * nulls that slip through are dropped by the null filter or ignored by the `find`
 * calls downstream, so behaviour is unchanged either way. The guard is kept
 * because it establishes the `JsonRecord[]` invariant the rest of this file reads
 * against — without it every consumer would have to narrow `unknown` itself.
 */
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const parseLines = (stdout: string): readonly JsonRecord[] =>
  stdout
    .split("\n")
    .map((line): JsonRecord | null => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter((event): event is JsonRecord => event !== null);

const textOf = (message: JsonRecord): string => {
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block["type"] === "text")
    .map((block) => asString(block["text"]) ?? "")
    .join("");
};

const usageOf = (message: JsonRecord): JsonRecord | null => {
  const usage = message["usage"];
  return isRecord(usage) ? usage : null;
};

export const parseOmpRun = (stdout: string): OmpRunResult => {
  const events = parseLines(stdout);
  if (events.length === 0) return EMPTY_RESULT;

  const session = events.find((event) => event["type"] === "session");
  const sessionId = session ? asString(session["id"]) : null;

  const terminal = events.find((event) => event["type"] === "agent_end");
  const messages = terminal && Array.isArray(terminal["messages"]) ? terminal["messages"].filter(isRecord) : [];

  if (messages.length === 0) return { ...EMPTY_RESULT, sessionId };

  const assistantTurns = messages.filter((message) => message["role"] === "assistant");
  const lastTurn = assistantTurns.at(-1) ?? null;

  const billedTurns = messages
    .map(usageOf)
    .filter((usage): usage is JsonRecord => usage !== null);

  const totals = billedTurns.reduce<RunTotals>((running, usage) => {
    const cost = isRecord(usage["cost"]) ? usage["cost"] : {};
    return {
      inputTokens: running.inputTokens + asNumber(usage["input"]),
      outputTokens: running.outputTokens + asNumber(usage["output"]),
      cachedInputTokens: running.cachedInputTokens + asNumber(usage["cacheRead"]),
      cacheWriteTokens: running.cacheWriteTokens + asNumber(usage["cacheWrite"]),
      totalTokens: running.totalTokens + asNumber(usage["totalTokens"]),
      costUsd: running.costUsd + asNumber(cost["total"]),
    };
  }, NO_TOTALS);

  const billed = billedTurns.length > 0;

  return {
    sessionId,
    summary: lastTurn ? textOf(lastTurn) : "",
    usage: billed
      ? {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cachedInputTokens: totals.cachedInputTokens,
        }
      : null,
    costUsd: billed ? totals.costUsd : null,
    provider: lastTurn ? asString(lastTurn["provider"]) : null,
    model: lastTurn ? asString(lastTurn["model"]) : null,
    extraTokens: billed
      ? { cacheWriteTokens: totals.cacheWriteTokens, totalTokens: totals.totalTokens }
      : null,
  };
};
