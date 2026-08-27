/**
 * Persistence for the omp session Paperclip carries between heartbeats.
 *
 * An agent may be woken dozens of times for one issue. Each wake should resume
 * the existing omp session so the agent keeps what it has already read and
 * decided, rather than paying to rediscover it.
 *
 * The stored `cwd` is not decoration: resuming is refused when the workspace has
 * moved, so a session cannot leak across projects. See `canResumeSession`.
 *
 * Both directions normalise, because the stored value is whatever an earlier
 * version of this adapter wrote and is read back as `unknown`.
 */

import { resolve } from "node:path";

/** How many leading characters of the session id identify it to a human. */
const DISPLAY_ID_LENGTH = 8;

export type OmpSession = {
  readonly sessionId: string;
  readonly cwd: string | null;
};

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readSession = (raw: unknown): OmpSession | null => {
  if (typeof raw !== "object" || raw === null) return null;

  // No array check: the stored value is JSON, and a JSON array cannot carry a
  // `sessionId` property, so the guard below already rejects every array.
  const sessionId = asTrimmed((raw as Record<string, unknown>)["sessionId"]);
  if (sessionId === null) return null;

  return { sessionId, cwd: asTrimmed((raw as Record<string, unknown>)["cwd"]) };
};

export const sessionCodec = {
  deserialize: (raw: unknown): OmpSession | null => readSession(raw),

  serialize: (params: unknown): OmpSession | null => readSession(params),

  getDisplayId: (params: unknown): string | null => {
    const session = readSession(params);
    return session === null ? null : session.sessionId.slice(0, DISPLAY_ID_LENGTH);
  },
};

/**
 * Whether a stored session may be resumed for a run in `cwd`.
 *
 * A session carries the conversation, including everything the agent read and
 * decided in the directory it started from. Resuming it somewhere else would
 * bring one project's context into another, so a recorded directory that does
 * not match is a refusal.
 *
 * A session with no recorded directory is resumable: there is nothing to
 * contradict, and refusing would discard context on no evidence.
 *
 * Comparison is textual after normalisation, so it does not follow symlinks and
 * is case-sensitive. Both make it refuse where it might have resumed, which is
 * the safe direction — the cost is a lost conversation, not a leaked one.
 */
export const canResumeSession = (session: OmpSession | null, cwd: string): boolean => {
  if (session === null) return false;
  if (session.cwd === null) return true;
  return resolve(session.cwd) === resolve(cwd);
};
