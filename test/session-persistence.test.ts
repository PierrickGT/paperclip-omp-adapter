import { describe, expect, it } from "vitest";

import { sessionCodec } from "../src/server/session.js";

const A_SESSION_ID = "01a030e2-a211-7000-9964-0903ee42ed0f";

describe("carrying a session from one heartbeat to the next", () => {
  it("restores what it stored", () => {
    const stored = sessionCodec.serialize({ sessionId: A_SESSION_ID, cwd: "/workspace/project" });

    expect(sessionCodec.deserialize(stored)).toEqual({
      sessionId: A_SESSION_ID,
      cwd: "/workspace/project",
    });
  });

  it("restores a session that was never tied to a directory", () => {
    const stored = sessionCodec.serialize({ sessionId: A_SESSION_ID });

    expect(sessionCodec.deserialize(stored)).toEqual({ sessionId: A_SESSION_ID, cwd: null });
  });

  it("keeps the working directory, because resuming depends on it", () => {
    const stored = sessionCodec.serialize({ sessionId: A_SESSION_ID, cwd: "/workspace/project" });

    expect(stored).toMatchObject({ cwd: "/workspace/project" });
  });

  it("discards fields it does not recognise rather than storing them", () => {
    const stored = sessionCodec.serialize({ sessionId: A_SESSION_ID, apiKey: "sk-secret" });

    expect(stored).not.toHaveProperty("apiKey");
  });
});

describe("refusing to resume something that is not a session", () => {
  it.each([
    ["nothing stored", null],
    ["a missing value", undefined],
    ["a bare string", A_SESSION_ID],
    ["a number", 42],
    ["a list", [A_SESSION_ID]],
    ["an object with no session id", { cwd: "/workspace/project" }],
    ["a blank session id", { sessionId: "" }],
    ["a whitespace-only session id", { sessionId: "   " }],
    ["a session id that is not text", { sessionId: 42 }],
  ])("reports no session for %s", (_case, raw) => {
    expect(sessionCodec.deserialize(raw)).toBeNull();
  });

  it("stores nothing when the run produced no session", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("stores nothing when the run reported a blank session", () => {
    expect(sessionCodec.serialize({ sessionId: "  " })).toBeNull();
  });
});

describe("naming a session for a human", () => {
  it("shortens the identifier to something readable", () => {
    expect(sessionCodec.getDisplayId({ sessionId: A_SESSION_ID })).toBe("01a030e2");
  });

  it("leaves an already short identifier alone", () => {
    expect(sessionCodec.getDisplayId({ sessionId: "01a03" })).toBe("01a03");
  });

  it("has no name for a run without a session", () => {
    expect(sessionCodec.getDisplayId(null)).toBeNull();
  });

  it("has no name for something that is not a session", () => {
    expect(sessionCodec.getDisplayId({ cwd: "/workspace/project" })).toBeNull();
  });
});

describe("tolerating a stored session written by a different version", () => {
  it("ignores extra fields a later version may have added", () => {
    const fromTheFuture = { sessionId: A_SESSION_ID, cwd: "/workspace/project", profile: "work" };

    expect(sessionCodec.deserialize(fromTheFuture)).toEqual({
      sessionId: A_SESSION_ID,
      cwd: "/workspace/project",
    });
  });

  it("treats a directory that is not text as no directory", () => {
    expect(sessionCodec.deserialize({ sessionId: A_SESSION_ID, cwd: 42 })).toEqual({
      sessionId: A_SESSION_ID,
      cwd: null,
    });
  });

  it("trims surrounding whitespace from stored values", () => {
    expect(sessionCodec.deserialize({ sessionId: `  ${A_SESSION_ID}  `, cwd: " /workspace " })).toEqual({
      sessionId: A_SESSION_ID,
      cwd: "/workspace",
    });
  });
});
