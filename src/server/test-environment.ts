/**
 * Preflight diagnostics behind the board UI's "Test environment" button.
 *
 * Severity policy is product-critical: warnings must never block saving an agent.
 * Only a genuinely unusable setup is an error. A missing working directory is a
 * warning rather than an error because the run creates it; an unreadable version
 * is a warning because omp still runs.
 *
 * All I/O arrives through `probe`, so this stays a pure decision and unit tests
 * spawn nothing. `createServerAdapter` binds the real implementation.
 */

import { isAbsolute } from "node:path";

/** The omp major version this adapter's behaviour was verified against. */
const TESTED_MAJOR_VERSION = 17;

const DEFAULT_COMMAND = "omp";

const INSTALL_HINT = "Install omp (see https://omp.sh) and make sure it is on the PATH of the Paperclip server process.";

export type OmpEnvironmentProbe = {
  /** Resolves a command to an absolute path, or null when it is not on PATH. */
  readonly findCommand: (command: string) => Promise<string | null>;
  /** Returns omp's raw `--version` output, or null when it cannot be read. */
  readonly readVersion: (command: string) => Promise<string | null>;
  readonly isDirectory: (path: string) => Promise<boolean>;
  readonly now: () => Date;
};

export type EnvironmentCheckLevel = "info" | "warn" | "error";

export type EnvironmentCheck = {
  readonly code: string;
  readonly level: EnvironmentCheckLevel;
  readonly message: string;
  readonly detail?: string | null;
  readonly hint?: string | null;
};

export type EnvironmentTestResult = {
  readonly adapterType: string;
  readonly status: "pass" | "warn" | "fail";
  readonly checks: readonly EnvironmentCheck[];
  readonly testedAt: string;
};

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const majorVersionOf = (rawVersion: string): number | null => {
  const match = /(\d+)\.\d+\.\d+/.exec(rawVersion);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
};

const verdictFrom = (checks: readonly EnvironmentCheck[]): EnvironmentTestResult["status"] => {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
};

const versionCheck = (rawVersion: string | null): EnvironmentCheck => {
  if (rawVersion === null) {
    return {
      code: "omp_version",
      level: "warn",
      message: "Could not read the omp version.",
      hint: `This adapter was verified against omp ${TESTED_MAJOR_VERSION}.x.`,
    };
  }

  const major = majorVersionOf(rawVersion);
  if (major === null) {
    return {
      code: "omp_version",
      level: "warn",
      message: `Could not recognise the omp version from "${rawVersion}".`,
      hint: `This adapter was verified against omp ${TESTED_MAJOR_VERSION}.x.`,
    };
  }

  if (major !== TESTED_MAJOR_VERSION) {
    return {
      code: "omp_version",
      level: "warn",
      message: `omp ${rawVersion} has not been tested with this adapter.`,
      hint: `This adapter was verified against omp ${TESTED_MAJOR_VERSION}.x. Flags may differ.`,
    };
  }

  return { code: "omp_version", level: "info", message: `Detected omp ${rawVersion}.` };
};

const workingDirectoryCheck = async (
  configuredCwd: string,
  probe: OmpEnvironmentProbe,
): Promise<EnvironmentCheck> => {
  if (!isAbsolute(configuredCwd)) {
    return {
      code: "omp_cwd",
      level: "error",
      message: `The working directory "${configuredCwd}" is not an absolute path.`,
      hint: "Configure an absolute path; a relative one depends on where the server happened to start.",
    };
  }

  if (!(await probe.isDirectory(configuredCwd))) {
    return {
      code: "omp_cwd",
      level: "warn",
      message: `The working directory "${configuredCwd}" does not exist yet.`,
      hint: "It will be created when the agent first runs.",
    };
  }

  return { code: "omp_cwd", level: "info", message: `Working directory "${configuredCwd}" is present.` };
};

export const testEnvironment = async (
  config: Record<string, unknown>,
  probe: OmpEnvironmentProbe,
): Promise<EnvironmentTestResult> => {
  const command = asTrimmed(config["command"]) ?? DEFAULT_COMMAND;
  const configuredCwd = asTrimmed(config["cwd"]);
  const testedAt = probe.now().toISOString();

  const resolvedPath = await probe.findCommand(command);

  // A version probe on a command that is not there would only add noise to a
  // failure the operator already has to fix.
  const commandChecks: readonly EnvironmentCheck[] =
    resolvedPath === null
      ? [
          {
            code: "omp_command",
            level: "error",
            message: `The command "${command}" was not found on PATH.`,
            hint: INSTALL_HINT,
          },
        ]
      : [
          { code: "omp_command", level: "info", message: `Found "${command}" at ${resolvedPath}.` },
          versionCheck(await probe.readVersion(command)),
        ];

  const cwdChecks: readonly EnvironmentCheck[] =
    configuredCwd === null ? [] : [await workingDirectoryCheck(configuredCwd, probe)];

  const checks = [...commandChecks, ...cwdChecks];

  return { adapterType: "omp", status: verdictFrom(checks), checks, testedAt };
};
