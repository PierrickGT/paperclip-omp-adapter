import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createStdoutParser, type TranscriptEntry } from "../src/ui-parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const linesOf = (name: string): string[] =>
  readFileSync(join(fixturesDir, name), "utf8").trim().split("\n");

const TS = "2026-08-27T10:00:00.000Z";

/** Runs a whole recorded transcript through one parser, as the run viewer would. */
const replay = (name: string): TranscriptEntry[] => {
  const parser = createStdoutParser();
  return linesOf(name).flatMap((line) => parser.parseLine(line, TS));
};

const kindsOf = (entries: readonly TranscriptEntry[]): string[] => entries.map((entry) => entry.kind);

const textOf = (entries: readonly TranscriptEntry[], kind: string): string =>
  entries
    .filter((entry) => entry.kind === kind)
    .map((entry) => ("text" in entry ? entry.text : ""))
    .join("");

describe("showing a run as it happens", () => {
  it("stamps every entry with the time it was given", () => {
    const entries = replay("01-plain-answer.jsonl");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.ts === TS)).toBe(true);
  });

  it("shows the agent's answer as it streams in", () => {
    const entries = replay("01-plain-answer.jsonl");

    expect(textOf(entries, "assistant")).toBe("OK");
  });

  it("marks streamed text as partial, so the viewer can join it up", () => {
    const entries = replay("01-plain-answer.jsonl");
    const assistant = entries.filter((entry) => entry.kind === "assistant");

    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.every((entry) => "delta" in entry && entry.delta === true)).toBe(true);
  });

  it("shows the answer once, not again when the message closes", () => {
    const entries = replay("01-plain-answer.jsonl");

    expect(textOf(entries, "assistant")).toBe("OK");
  });

  it("shows the agent's reasoning apart from its answer", () => {
    const entries = replay("02-resumed-session.jsonl");

    expect(textOf(entries, "thinking")).toContain("The user");
    expect(textOf(entries, "assistant")).not.toContain("The user");
  });

  it("shows what the operator asked", () => {
    const entries = replay("01-plain-answer.jsonl");

    expect(textOf(entries, "user")).toBe("Reply with exactly: OK");
  });

  it("notes the session the run belongs to, and where it ran", () => {
    const parser = createStdoutParser();
    const session = `{"type":"session","id":"01a030e2","cwd":"/workspace/project"}`;

    expect(parser.parseLine(session, TS)).toEqual([
      { kind: "system", ts: TS, text: "Session 01a030e2 in /workspace/project" },
    ]);
  });
});

describe("showing the tools a run used", () => {
  it("shows each tool call with the arguments it was given", () => {
    const entries = replay("03-tool-use.jsonl");
    const call = entries.find((entry) => entry.kind === "tool_call");

    expect(call).toMatchObject({ kind: "tool_call", name: "read" });
    expect(JSON.stringify(call)).toContain("path");
  });

  it("shows the result of each tool call", () => {
    const entries = replay("03-tool-use.jsonl");
    const result = entries.find((entry) => entry.kind === "tool_result");

    expect(result).toMatchObject({ kind: "tool_result", isError: false });
    expect(JSON.stringify(result)).toContain("alpha.txt");
  });

  it("links a result to the call it answers", () => {
    const entries = replay("03-tool-use.jsonl");
    const call = entries.find((entry) => entry.kind === "tool_call");
    const result = entries.find((entry) => entry.kind === "tool_result");

    expect(call && "toolUseId" in call ? call.toolUseId : null).toBe(
      result && "toolUseId" in result ? result.toolUseId : undefined,
    );
  });

  it("shows a failed tool call as failed", () => {
    const parser = createStdoutParser();
    const failed = `{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"exit 1"}]},"isError":true}`;

    expect(parser.parseLine(failed, TS)).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "call_1", content: "exit 1", isError: true },
    ]);
  });

  it("does not repeat the tool result as a conversation turn", () => {
    const entries = replay("03-tool-use.jsonl");

    expect(textOf(entries, "user")).not.toContain("alpha.txt");
  });
});

describe("showing what omp reported about itself", () => {
  it("shows a warning without treating it as failure output", () => {
    const parser = createStdoutParser();
    const notice = `{"type":"notice","level":"warning","message":"Advisor unavailable","source":"advisor"}`;

    expect(kindsOf(parser.parseLine(notice, TS))).toEqual(["system"]);
  });

  it("shows an error where failures belong", () => {
    const parser = createStdoutParser();
    const notice = `{"type":"notice","level":"error","message":"Provider rejected the request"}`;

    expect(kindsOf(parser.parseLine(notice, TS))).toEqual(["stderr"]);
  });
});

describe("surviving output the viewer was not expecting", () => {
  it("shows a JSON line that is not an event rather than dropping it", () => {
    const parser = createStdoutParser();

    expect(parser.parseLine("[1, 2, 3]", TS)).toEqual([{ kind: "stdout", ts: TS, text: "[1, 2, 3]" }]);
    expect(parser.parseLine("null", TS)).toEqual([{ kind: "stdout", ts: TS, text: "null" }]);
  });

  it("says nothing for an update that carries no text", () => {
    const parser = createStdoutParser();
    const empty = `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":""}}`;

    expect(parser.parseLine(empty, TS)).toEqual([]);
  });

  it("shows an unparseable line rather than dropping it", () => {
    const parser = createStdoutParser();

    expect(parser.parseLine("omp: command not found", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "omp: command not found" },
    ]);
  });

  it("says nothing about a blank line", () => {
    const parser = createStdoutParser();

    expect(parser.parseLine("   ", TS)).toEqual([]);
  });

  it("ignores an event type it does not recognise", () => {
    const parser = createStdoutParser();

    expect(parser.parseLine(`{"type":"some_future_event"}`, TS)).toEqual([]);
  });

  it("never throws, whatever it is handed", () => {
    const parser = createStdoutParser();

    for (const line of ["{", "null", "[]", `{"type":null}`, `{"type":"message_end"}`, "{}"]) {
      expect(() => parser.parseLine(line, TS)).not.toThrow();
    }
  });
});

describe("showing an answer omp did not stream", () => {
  it("shows the answer from the closing message when nothing streamed", () => {
    const parser = createStdoutParser();
    const start = `{"type":"message_start","message":{"role":"assistant","content":[]}}`;
    const end = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"All done."}]}}`;

    parser.parseLine(start, TS);

    expect(textOf(parser.parseLine(end, TS), "assistant")).toBe("All done.");
  });

  it("shows a later unstreamed answer even after an earlier one streamed", () => {
    const parser = createStdoutParser();
    const delta = `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"streamed"}}`;
    const start = `{"type":"message_start","message":{"role":"assistant","content":[]}}`;
    const end = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"quiet answer"}]}}`;

    parser.parseLine(delta, TS);
    parser.parseLine(start, TS);

    expect(textOf(parser.parseLine(end, TS), "assistant")).toBe("quiet answer");
  });

  it("shows only text blocks, even when another block type carries text", () => {
    const parser = createStdoutParser();
    const end = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","text":"LEAKED"},{"type":"text","text":"the answer"}]}}`;

    expect(textOf(parser.parseLine(end, TS), "assistant")).toBe("the answer");
  });

  it("marks an unstreamed answer as complete rather than partial", () => {
    const parser = createStdoutParser();
    const end = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"All done."}]}}`;

    const entries = parser.parseLine(end, TS);

    expect(entries[0]).toEqual({ kind: "assistant", ts: TS, text: "All done." });
  });
});

describe("reusing a parser for another run", () => {
  it("forgets the previous run when reset", () => {
    const parser = createStdoutParser();
    const delta = `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"first"}}`;
    const end = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}`;

    parser.parseLine(delta, TS);
    parser.reset();

    expect(textOf(parser.parseLine(end, TS), "assistant")).toBe("second");
  });

  it("reads the same transcript the same way every time", () => {
    expect(replay("03-tool-use.jsonl")).toEqual(replay("03-tool-use.jsonl"));
  });
});

describe("shrugging off events that are the wrong shape", () => {
  const parsed = (line: string): TranscriptEntry[] => createStdoutParser().parseLine(line, TS);

  it("says nothing for a turn whose content is not a list of blocks", () => {
    expect(parsed(`{"type":"message_start","message":{"role":"user","content":"hello"}}`)).toEqual([]);
  });

  it("says nothing for a turn that carries no message at all", () => {
    expect(parsed(`{"type":"message_start","message":"user said hello"}`)).toEqual([]);
  });

  it("says nothing for a turn whose text is empty", () => {
    expect(parsed(`{"type":"message_start","message":{"role":"user","content":[]}}`)).toEqual([]);
  });

  it("says nothing for a closing assistant turn whose text is empty", () => {
    expect(parsed(`{"type":"message_end","message":{"role":"assistant","content":[]}}`)).toEqual([]);
  });

  it("says nothing for an update that carries no event", () => {
    expect(parsed(`{"type":"message_update","assistantMessageEvent":"text_delta"}`)).toEqual([]);
  });

  it("shows a tool result that carries no result object as empty", () => {
    const entries = parsed(`{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","isError":false}`);

    expect(entries).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "c1", content: "", isError: false },
    ]);
  });

  it("shows a tool result whose content is not a list of blocks as empty", () => {
    const line = `{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","result":{"content":"done"},"isError":false}`;

    expect(parsed(line)).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "c1", content: "", isError: false },
    ]);
  });
});
