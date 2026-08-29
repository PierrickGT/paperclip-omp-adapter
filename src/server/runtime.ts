/**
 * The real filesystem and child-process work every other module takes as an
 * injected dependency.
 *
 * Keeping it here means the decision-making modules stay pure and their tests
 * spawn nothing, while this file — the part that actually touches the host — is
 * exercised against real directories and a real binary.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { ProcessEntry } from "./reap.js";
import type { SkillsDeps } from "./skills.js";

const execFileAsync = promisify(execFile);

/** How long a version probe may take before it is treated as unreadable. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const TEMP_DIR_PREFIX = "paperclip-omp-skills-";

/** Stamped into every run by Paperclip, and inherited by every descendant. */
const PAPERCLIP_RUN_ID_KEY = "PAPERCLIP_RUN_ID";

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves a command to an absolute path, or null when the host does not have it.
 *
 * A command containing a separator is taken as a path and checked directly;
 * anything else is looked up across PATH.
 */
export const resolveCommandPath = async (
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> => {
  if (command.includes("/") || isAbsolute(command)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  // Empty PATH entries are dropped rather than treated as the current directory,
  // which is what POSIX would otherwise mean. No test can distinguish this
  // without putting an executable in the test process's own directory, so it is
  // hardening rather than tested behaviour.
  for (const dir of (env.PATH ?? "").split(delimiter).filter((part) => part.length > 0)) {
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
};

/** Reads what a command reports for `--version`, or null when it cannot be run. */
export const readCommandVersion = async (command: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const reported = stdout.trim();
    return reported.length > 0 ? reported : null;
  } catch {
    return null;
  }
};

export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Filesystem work `prepareSkills` needs, minus listing, which depends on the adapter's own location. */
export const stagingDeps: Omit<SkillsDeps, "listSkills"> = {
  makeTempDir: () => mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX)),

  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },

  // Symlinked rather than copied: the skill is read, never written, and a link
  // keeps staging cheap however large the skill directory is.
  linkSkill: async (source, target) => {
    await symlink(source, target, "dir");
  },

  writeFile: async (path, contents) => {
    await writeFile(path, contents, "utf8");
  },

  removeDir: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * Reads the process table through procfs, tagging each entry with the
 * `PAPERCLIP_RUN_ID` it inherited. Linux-only by construction; on any other
 * platform it reports nothing, which disables the reaper rather than breaking it.
 */
export const listRunProcesses = async (): Promise<readonly ProcessEntry[]> => {
  if (process.platform !== "linux") return [];

  const entries = await readdir("/proc");
  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number);

  const processes = await Promise.all(pids.map(readProcessEntry));
  return processes.filter((entry): entry is ProcessEntry => entry !== null);
};

const readProcessEntry = async (pid: number): Promise<ProcessEntry | null> => {
  try {
    const [environ, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/environ`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    ]);

    return {
      pid,
      command: cmdline.split("\0").filter(Boolean).join(" ").slice(0, 200),
      runId: runIdFromEnviron(environ),
    };
  } catch {
    // The process exited mid-read, or belongs to another user. Neither is ours.
    return null;
  }
};

const runIdFromEnviron = (environ: string): string | null => {
  for (const pair of environ.split("\0")) {
    if (pair.startsWith(`${PAPERCLIP_RUN_ID_KEY}=`)) {
      const value = pair.slice(PAPERCLIP_RUN_ID_KEY.length + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
};

export const signalProcess = async (pid: number, signal: NodeJS.Signals): Promise<void> => {
  process.kill(pid, signal);
};

export const isProcessAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
