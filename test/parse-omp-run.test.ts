import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseOmpRun } from "../src/server/parse.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const readFixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

const plainAnswer = (): string => readFixture("01-plain-answer.jsonl");
const resumedSession = (): string => readFixture("02-resumed-session.jsonl");
const toolUse = (): string => readFixture("03-tool-use.jsonl");

type JsonRecord = Record<string, unknown>;

/**
 * Rewrite one event type within a recorded run.
 *
 * Fixtures are never hand-written, but some code paths cannot be reached by any
 * run this machine can produce — every recorded run reports `cacheWrite: 0`, and
 * every answer arrives as a single text block. Deriving a variant from recorded
 * data exercises those paths without inventing an event format.
 */
const withEventEdited = (stream: string, type: string, edit: (event: JsonRecord) => void): string =>
  stream
    .trim()
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as JsonRecord;
      if (event["type"] === type) edit(event);
      return JSON.stringify(event);
    })
    .join("\n");

const lastAssistantOf = (event: JsonRecord): JsonRecord => {
  const messages = event["messages"] as JsonRecord[];
  return messages.filter((message) => message["role"] === "assistant").at(-1) as JsonRecord;
};

describe("parsing a completed omp run", () => {
  it("reports the session id so the run can be resumed later", () => {
    expect(parseOmpRun(plainAnswer()).sessionId).toBe("01a030e2-a211-7000-9964-0903ee42ed0f");
  });

  it("reports the assistant's answer as the run summary", () => {
    expect(parseOmpRun(plainAnswer()).summary).toBe("OK");
  });

  it("reports the model and provider omp actually resolved, not what was configured", () => {
    const result = parseOmpRun(plainAnswer());

    expect(result.provider).toBe("zai");
    expect(result.model).toBe("glm-5.3");
  });

  it("reports token usage under Paperclip's field names", () => {
    expect(parseOmpRun(plainAnswer()).usage).toEqual({
      inputTokens: 89,
      outputTokens: 3,
      cachedInputTokens: 27008,
    });
  });

  it("reports cost as a single top-level dollar figure", () => {
    expect(parseOmpRun(plainAnswer()).costUsd).toBeCloseTo(0.00715988, 10);
  });

  it("keeps the token counts Paperclip has no field for", () => {
    expect(parseOmpRun(plainAnswer()).extraTokens).toEqual({
      cacheWriteTokens: 0,
      totalTokens: 27100,
    });
  });
});

describe("finding the run's outcome regardless of where it sits in the stream", () => {
  it("reads the answer from a run whose final line is an advisor notice", () => {
    const stream = plainAnswer();
    const lastLine = stream.trim().split("\n").at(-1) ?? "";

    expect(JSON.parse(lastLine)).toMatchObject({ type: "notice" });
    expect(parseOmpRun(stream).summary).toBe("OK");
  });

  it("reads the answer from a run whose final line is the terminal event", () => {
    const stream = toolUse();
    const lastLine = stream.trim().split("\n").at(-1) ?? "";

    expect(JSON.parse(lastLine)).toMatchObject({ type: "agent_end" });
    expect(parseOmpRun(stream).summary).toContain("alpha.txt");
  });
});

describe("summarising a run that took several assistant turns", () => {
  it("summarises from the final assistant turn only, ignoring earlier tool-call turns", () => {
    expect(parseOmpRun(toolUse()).summary).toBe(
      "The current directory contains two files:\n\n- `alpha.txt`\n- `beta.txt`",
    );
  });

  it("adds up token usage across every assistant turn in the run", () => {
    expect(parseOmpRun(toolUse()).usage).toEqual({
      inputTokens: 470,
      outputTokens: 103,
      cachedInputTokens: 54336,
    });
  });

  it("adds up cost across every assistant turn in the run", () => {
    expect(parseOmpRun(toolUse()).costUsd).toBeCloseTo(0.01523856, 10);
  });
});

describe("assembling an answer that omp split across blocks", () => {
  it("joins consecutive text blocks without inserting separators", () => {
    const split = withEventEdited(plainAnswer(), "agent_end", (event) => {
      const message = lastAssistantOf(event);
      const blocks = message["content"] as JsonRecord[];
      message["content"] = [...blocks, { type: "text", text: "!" }];
    });

    expect(parseOmpRun(split).summary).toBe("OK!");
  });

  it("adds up cache-write tokens when a run actually writes cache", () => {
    const cacheWriting = withEventEdited(plainAnswer(), "agent_end", (event) => {
      (lastAssistantOf(event)["usage"] as JsonRecord)["cacheWrite"] = 512;
    });

    expect(parseOmpRun(cacheWriting).extraTokens).toEqual({ cacheWriteTokens: 512, totalTokens: 27100 });
  });
});

describe("separating the agent's answer from its reasoning", () => {
  it("omits thinking blocks from the summary", () => {
    const result = parseOmpRun(resumedSession());

    expect(result.summary).toBe("You asked me to reply with exactly: OK");
    expect(result.summary).not.toContain("The user");
  });

  it("summarises only text blocks, even if another block type carries text", () => {
    const withTextBearingToolCall = withEventEdited(plainAnswer(), "agent_end", (event) => {
      const message = lastAssistantOf(event);
      const blocks = message["content"] as JsonRecord[];
      message["content"] = [
        ...blocks,
        { type: "toolCall", id: "call_1", name: "read", intent: "…", arguments: {}, text: "LEAKED" },
      ];
    });

    expect(parseOmpRun(withTextBearingToolCall).summary).toBe("OK");
  });
});

describe("surviving output that is not a well-formed run", () => {
  it("returns an empty result when omp produced no output at all", () => {
    expect(parseOmpRun("")).toEqual({
      sessionId: null,
      summary: "",
      usage: null,
      costUsd: null,
      provider: null,
      model: null,
      extraTokens: null,
    });
  });

  it("returns an empty result when omp produced only whitespace", () => {
    expect(parseOmpRun("\n  \n").summary).toBe("");
  });

  it("ignores unparseable lines rather than throwing", () => {
    const corrupted = `not json at all\n${plainAnswer()}`;

    expect(parseOmpRun(corrupted).summary).toBe("OK");
  });

  it("ignores a truncated line that begins like an event but does not parse", () => {
    const truncatedLine = `{"type":"message_start","message":{"role":\n${plainAnswer()}`;

    expect(parseOmpRun(truncatedLine).summary).toBe("OK");
  });

  it("ignores a well-formed JSON line that is not an event object", () => {
    const arrayLine = `[1, 2, 3]\n${plainAnswer()}`;

    expect(parseOmpRun(arrayLine).summary).toBe("OK");
  });

  it("reports no session when the run never announced one", () => {
    const withoutSession = plainAnswer()
      .trim()
      .split("\n")
      .filter((line) => !line.includes(`"type":"session"`))
      .join("\n");

    expect(parseOmpRun(withoutSession).sessionId).toBeNull();
  });

  it("returns an empty summary when the terminal event carries no messages", () => {
    const withoutMessages = withEventEdited(plainAnswer(), "agent_end", (event) => {
      delete event["messages"];
    });

    const result = parseOmpRun(withoutMessages);

    expect(result.sessionId).toBe("01a030e2-a211-7000-9964-0903ee42ed0f");
    expect(result.summary).toBe("");
  });

  it("returns an empty summary when the run ended without an assistant turn", () => {
    const userOnly = withEventEdited(plainAnswer(), "agent_end", (event) => {
      const messages = event["messages"] as JsonRecord[];
      event["messages"] = messages.filter((message) => message["role"] !== "assistant");
    });

    expect(parseOmpRun(userOnly).summary).toBe("");
  });

  it("ignores a message whose content is not a list of blocks", () => {
    const malformedContent = withEventEdited(plainAnswer(), "agent_end", (event) => {
      lastAssistantOf(event)["content"] = "OK";
    });

    expect(parseOmpRun(malformedContent).summary).toBe("");
  });

  it("ignores a text block that carries no text", () => {
    const emptyBlock = withEventEdited(plainAnswer(), "agent_end", (event) => {
      const message = lastAssistantOf(event);
      message["content"] = [...(message["content"] as JsonRecord[]), { type: "text" }];
    });

    expect(parseOmpRun(emptyBlock).summary).toBe("OK");
  });

  it("treats a malformed usage object as an unbilled turn", () => {
    const malformedUsage = withEventEdited(plainAnswer(), "agent_end", (event) => {
      lastAssistantOf(event)["usage"] = "27100 tokens";
    });

    expect(parseOmpRun(malformedUsage).usage).toBeNull();
  });

  it("treats a malformed cost object as costing nothing", () => {
    const malformedCost = withEventEdited(plainAnswer(), "agent_end", (event) => {
      (lastAssistantOf(event)["usage"] as JsonRecord)["cost"] = "free";
    });

    expect(parseOmpRun(malformedCost).costUsd).toBe(0);
  });

  it("ignores event types it does not recognise", () => {
    const withUnknownEvent = `{"type":"some_future_event","payload":1}\n${plainAnswer()}`;

    expect(parseOmpRun(withUnknownEvent).summary).toBe("OK");
  });

  it("treats a blank session id as no session rather than resuming an empty one", () => {
    const blanked = withEventEdited(plainAnswer(), "session", (event) => {
      event["id"] = "";
    });

    expect(parseOmpRun(blanked).sessionId).toBeNull();
  });

  it("reports no usage for a run that ended before any billed turn", () => {
    const unbilled = withEventEdited(plainAnswer(), "agent_end", (event) => {
      delete lastAssistantOf(event)["usage"];
    });

    const result = parseOmpRun(unbilled);

    expect(result.summary).toBe("OK");
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.extraTokens).toBeNull();
  });

  it("counts a token field omp omits as zero rather than guessing", () => {
    const partial = withEventEdited(plainAnswer(), "agent_end", (event) => {
      delete (lastAssistantOf(event)["usage"] as JsonRecord)["cacheWrite"];
    });

    expect(parseOmpRun(partial).extraTokens).toEqual({ cacheWriteTokens: 0, totalTokens: 27100 });
  });

  it("reports the session id even when the run never reached a terminal event", () => {
    const truncated = plainAnswer().split("\n").slice(0, 3).join("\n");

    const result = parseOmpRun(truncated);

    expect(result.sessionId).toBe("01a030e2-a211-7000-9964-0903ee42ed0f");
    expect(result.summary).toBe("");
    expect(result.usage).toBeNull();
  });
});
