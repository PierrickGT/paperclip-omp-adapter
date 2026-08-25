import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isOmpUnknownSessionError } from "../src/server/parse.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const staleSessionStderr = (): string =>
  readFileSync(join(fixturesDir, "04-unknown-session.stderr"), "utf8");

describe("recognising a session omp no longer has", () => {
  it("recognises the error a real stale resume produces", () => {
    expect(isOmpUnknownSessionError(staleSessionStderr())).toBe(true);
  });

  it("recognises the error whatever case omp reports it in", () => {
    expect(isOmpUnknownSessionError(staleSessionStderr().toUpperCase())).toBe(true);
  });

  it("still recognises the error if omp drops the session id from the wording", () => {
    expect(isOmpUnknownSessionError("Error: session not found.")).toBe(true);
  });

  it("treats an empty session store as a stale session, since ours cannot be there either", () => {
    expect(isOmpUnknownSessionError("Error: recent sessions not found.")).toBe(true);
  });
});

describe("leaving a healthy run alone", () => {
  it("reports nothing wrong when omp wrote nothing to stderr", () => {
    expect(isOmpUnknownSessionError("")).toBe(false);
  });

  it("reports nothing wrong for whitespace-only stderr", () => {
    expect(isOmpUnknownSessionError("\n \n")).toBe(false);
  });
});

describe("not mistaking other failures for a stale session", () => {
  it("ignores an unrelated failure that happens to mention sessions", () => {
    expect(isOmpUnknownSessionError("Error: Session store is corrupt.")).toBe(false);
  });

  it("ignores an unrelated failure that happens to mention something missing", () => {
    expect(isOmpUnknownSessionError("Error: config file not found.")).toBe(false);
  });

  it("does not join a session mention on one line to a failure on another", () => {
    const unrelatedPair = "Loaded session 01a03.\nError: config file not found.";

    expect(isOmpUnknownSessionError(unrelatedPair)).toBe(false);
  });

  it("ignores a failure about something other than the session going missing", () => {
    expect(isOmpUnknownSessionError("Error: recent sessions list not found.")).toBe(false);
  });

  it("ignores a failure about a different thing whose name merely contains session", () => {
    expect(isOmpUnknownSessionError("Error: subsession not found.")).toBe(false);
  });

  it("ignores a session failure that is not about the session being missing", () => {
    expect(isOmpUnknownSessionError("Error: Session could not be written to disk.")).toBe(false);
  });

  it("ignores a session failure whose verb is not about being found", () => {
    expect(isOmpUnknownSessionError("Error: Session not writable.")).toBe(false);
  });

  it("does not treat a session omp did find as missing", () => {
    expect(isOmpUnknownSessionError("Session 01a03 found, resuming.")).toBe(false);
  });

  it("does not read a failure across a line break onto a session mentioned above it", () => {
    const interleavedLogLines = "Resuming session\nnot found: ~/.omp/config.yml";

    expect(isOmpUnknownSessionError(interleavedLogLines)).toBe(false);
  });
});

describe("why the obvious detector is not enough", () => {
  it("cannot be found by the substrings PR #2810 searched for", () => {
    const recorded = staleSessionStderr().toLowerCase();

    for (const guess of ["session not found", "unknown session", "invalid session", "no such session"]) {
      expect(recorded).not.toContain(guess);
    }

    expect(isOmpUnknownSessionError(staleSessionStderr())).toBe(true);
  });
});
