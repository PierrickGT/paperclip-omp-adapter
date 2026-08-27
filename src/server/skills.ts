/**
 * Makes Paperclip's shared skills discoverable by omp, for one run only.
 *
 * The mechanism was established by probing omp 17.3.8 rather than inferred:
 *
 *  - `--add-dir` does **not** expose skills. A skill placed in an added
 *    directory is never discovered.
 *  - A `--config` overlay setting `skills.customDirectories` does. omp found and
 *    used a skill reachable only that way.
 *
 * The hard constraint is that nothing may be written into the agent's working
 * directory. That directory is the user's project checkout, and writing there
 * would contaminate the repo, dirty `git status`, and risk leaking into commits.
 * Everything here lives in a temporary directory that is removed after the run.
 *
 * Skills are never inlined into the prompt. omp reads each skill's name and
 * description and loads the body only when it decides to use one.
 *
 * Failing to inject skills degrades the run; it does not end it. Every failure
 * warns and carries on.
 */

import { join } from "node:path";

import { readPaperclipSkillSyncPreference, resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";

const SKILLS_SUBDIR = "skills";
const OVERLAY_FILENAME = "omp-overlay.yml";

export type SkillEntry = {
  readonly key: string;
  readonly runtimeName: string;
  readonly source: string;
};

export type SkillsDeps = {
  readonly listSkills: () => Promise<readonly SkillEntry[]>;
  readonly makeTempDir: () => Promise<string>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly linkSkill: (source: string, target: string) => Promise<void>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly removeDir: (path: string) => Promise<void>;
};

export type PreparedSkills = {
  /** Paths to pass to omp as `--config`, empty when nothing was injected. */
  readonly configOverlays: readonly string[];
  readonly cleanup: () => Promise<void>;
};

const NOTHING_INJECTED: PreparedSkills = {
  configOverlays: [],
  cleanup: async () => {},
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * An agent that has expressed no preference gets every skill. `desiredSkills`
 * returns an empty list both for "none of them" and for "not specified", so the
 * `explicit` flag is what separates the two.
 */
const selectSkills = (
  config: Record<string, unknown>,
  available: readonly SkillEntry[],
): readonly SkillEntry[] => {
  if (!readPaperclipSkillSyncPreference(config).explicit) return available;

  const desired = new Set(resolvePaperclipDesiredSkillNames(config, [...available]));
  return available.filter((entry) => desired.has(entry.key));
};

/** Quotes a path as a YAML double-quoted scalar, so odd characters cannot break the overlay. */
const overlayFor = (skillsDir: string): string =>
  ["skills:", "  customDirectories:", `    - ${JSON.stringify(skillsDir)}`, ""].join("\n");

export const prepareSkills = async (
  config: Record<string, unknown>,
  deps: SkillsDeps,
  onWarn: (message: string) => Promise<void>,
): Promise<PreparedSkills> => {
  let available: readonly SkillEntry[];
  try {
    available = await deps.listSkills();
  } catch (error) {
    await onWarn(`Could not list Paperclip skills, continuing without them: ${describe(error)}`);
    return NOTHING_INJECTED;
  }

  const selected = selectSkills(config, available);
  if (selected.length === 0) return NOTHING_INJECTED;

  let root: string;
  try {
    root = await deps.makeTempDir();
  } catch (error) {
    await onWarn(`Could not stage Paperclip skills, continuing without them: ${describe(error)}`);
    return NOTHING_INJECTED;
  }

  const cleanup = async (): Promise<void> => {
    try {
      await deps.removeDir(root);
    } catch (error) {
      await onWarn(`Could not remove the staged skills at ${root}: ${describe(error)}`);
    }
  };

  try {
    const skillsDir = join(root, SKILLS_SUBDIR);
    await deps.makeDirectory(skillsDir);

    for (const entry of selected) {
      try {
        await deps.linkSkill(entry.source, join(skillsDir, entry.runtimeName));
      } catch (error) {
        await onWarn(`Could not expose the "${entry.key}" skill to omp: ${describe(error)}`);
      }
    }

    const overlayPath = join(root, OVERLAY_FILENAME);
    await deps.writeFile(overlayPath, overlayFor(skillsDir));

    return { configOverlays: [overlayPath], cleanup };
  } catch (error) {
    await onWarn(`Could not stage Paperclip skills, continuing without them: ${describe(error)}`);
    await cleanup();
    return NOTHING_INJECTED;
  }
};
