/**
 * Builds the omp command line for one unattended Paperclip run.
 *
 * Every flag here was verified against `omp/17.3.8`. Three of them are places
 * PR #2810 guessed wrong:
 *
 *  - The task is the trailing positional argument. #2810 sent it through
 *    `--append-system-prompt`, so the agent got the task as system text with no
 *    user turn at all.
 *  - `--provider` exists but is documented as legacy. `--model` already accepts
 *    the `provider/model` form, so the pair is never split.
 *  - The instructions file is passed as a bare path. `@path` is the syntax for
 *    the positional MESSAGES argument, not for `--append-system-prompt`; a probe
 *    with `@path` silently failed to apply the file, while the bare path worked.
 *
 * `--auto-approve` is not optional. Without it omp blocks on the first tool
 * approval prompt and the run hangs until it times out.
 */

export type OmpInvocation = {
  /** The task, sent as omp's trailing positional argument. */
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  /** Absolute path to a markdown file appended to omp's system prompt. */
  readonly instructionsFilePath?: string | undefined;
  /** Directories omp should treat as workspace, used to expose Paperclip skills. */
  readonly skillsDirs?: readonly string[] | undefined;
  readonly extraArgs?: readonly string[] | undefined;
};

const given = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

const flag = (name: string, value: string | undefined): readonly string[] => {
  const present = given(value);
  return present === null ? [] : [name, present];
};

export const buildOmpArgs = (invocation: OmpInvocation): readonly string[] => [
  "-p",
  "--mode",
  "json",
  "--auto-approve",
  "--cwd",
  invocation.cwd,
  "--session-dir",
  invocation.sessionDir,
  ...flag("--resume", invocation.resumeSessionId),
  ...flag("--model", invocation.model),
  ...flag("--thinking", invocation.thinking),
  ...flag("--append-system-prompt", invocation.instructionsFilePath),
  ...(invocation.skillsDirs ?? []).flatMap((dir) => flag("--add-dir", dir)),
  ...(invocation.extraArgs ?? []),
  invocation.prompt,
];
