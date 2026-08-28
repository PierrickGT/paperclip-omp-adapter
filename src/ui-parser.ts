/**
 * Turns omp's `--mode json` event stream into Paperclip run-viewer entries.
 *
 * This file is fetched over HTTP and evaluated in the browser, so it must carry
 * **no imports**, no top-level side effects, and no DOM or Node APIs. Its types
 * are declared here rather than shared, for that reason alone. A build-output
 * test enforces it, because a stray import is invisible to unit tests and fatal
 * at runtime.
 *
 * The parser is stateful because omp streams selectively: assistant messages
 * arrive as `text_delta` and `thinking_delta` updates, while user and toolResult
 * messages arrive whole with no deltas at all. Emitting from both the deltas and
 * the closing message would show every answer twice, so the closing message is
 * only used when nothing streamed.
 */

export type TranscriptEntry =
  | { readonly kind: "assistant"; readonly ts: string; readonly text: string; readonly delta?: boolean }
  | { readonly kind: "thinking"; readonly ts: string; readonly text: string; readonly delta?: boolean }
  | { readonly kind: "user"; readonly ts: string; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly ts: string;
      readonly name: string;
      readonly input: unknown;
      readonly toolUseId?: string;
    }
  | {
      readonly kind: "tool_result";
      readonly ts: string;
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly kind: "system"; readonly ts: string; readonly text: string }
  | { readonly kind: "stderr"; readonly ts: string; readonly text: string }
  | { readonly kind: "stdout"; readonly ts: string; readonly text: string };

export type StdoutParser = {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Joins the `text` blocks of a message's content, ignoring thinking and tool calls. */
const textBlocksOf = (message: JsonRecord): string => {
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block["type"] === "text")
    .map((block) => asString(block["text"]))
    .join("");
};

/** Renders a tool result's content blocks as the plain text the viewer shows. */
const resultTextOf = (result: unknown): string => {
  if (!isRecord(result)) return "";
  const content = result["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => asString(block["text"]))
    .join("\n");
};

export const createStdoutParser = (): StdoutParser => {
  let streamedThisMessage = false;

  const parseEvent = (event: JsonRecord, ts: string): TranscriptEntry[] => {
    switch (event["type"]) {
      case "session":
        return [{ kind: "system", ts, text: `Session ${asString(event["id"])} in ${asString(event["cwd"])}` }];

      case "message_start": {
        const message = isRecord(event["message"]) ? event["message"] : {};
        if (message["role"] === "assistant") {
          streamedThisMessage = false;
          return [];
        }
        // Tool results arrive again as tool_execution_end, with the call id and
        // error flag the viewer needs, so they are skipped here.
        if (message["role"] !== "user") return [];
        const text = textBlocksOf(message);
        return text === "" ? [] : [{ kind: "user", ts, text }];
      }

      case "message_update": {
        const update = isRecord(event["assistantMessageEvent"]) ? event["assistantMessageEvent"] : {};
        const delta = asString(update["delta"]);
        if (delta === "") return [];
        if (update["type"] === "text_delta") {
          streamedThisMessage = true;
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
        if (update["type"] === "thinking_delta") {
          streamedThisMessage = true;
          return [{ kind: "thinking", ts, text: delta, delta: true }];
        }
        return [];
      }

      case "message_end": {
        const message = isRecord(event["message"]) ? event["message"] : {};
        if (message["role"] !== "assistant" || streamedThisMessage) return [];
        const text = textBlocksOf(message);
        return text === "" ? [] : [{ kind: "assistant", ts, text }];
      }

      case "tool_execution_start":
        return [
          {
            kind: "tool_call",
            ts,
            name: asString(event["toolName"]),
            input: event["args"],
            toolUseId: asString(event["toolCallId"]),
          },
        ];

      case "tool_execution_end":
        return [
          {
            kind: "tool_result",
            ts,
            toolUseId: asString(event["toolCallId"]),
            content: resultTextOf(event["result"]),
            isError: event["isError"] === true,
          },
        ];

      case "notice": {
        const text = asString(event["message"]);
        return [{ kind: event["level"] === "error" ? "stderr" : "system", ts, text }];
      }

      default:
        return [];
    }
  };

  return {
    parseLine: (line: string, ts: string): TranscriptEntry[] => {
      const trimmed = line.trim();
      if (trimmed === "") return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return [{ kind: "stdout", ts, text: trimmed }];
      }

      if (!isRecord(parsed)) return [{ kind: "stdout", ts, text: trimmed }];
      return parseEvent(parsed, ts);
    },

    reset: (): void => {
      streamedThisMessage = false;
    },
  };
};
