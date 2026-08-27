/**
 * Persistence for the omp session Paperclip carries between heartbeats.
 *
 * An agent may be woken dozens of times for one issue. Each wake should resume
 * the existing omp session so the agent keeps what it has already read and
 * decided, rather than paying to rediscover it.
 *
 * The stored `cwd` is not decoration: resuming is refused when the workspace has
 * moved, so a session cannot leak across projects. The guard that
 * enforces that arrives with the resume decision.
 *
 * Both directions normalise, because the stored value is whatever an earlier
 * version of this adapter wrote and is read back as `unknown`.
 */

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
