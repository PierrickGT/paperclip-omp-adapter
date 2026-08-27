import { describe, expect, it } from "vitest";

import { testEnvironment, type OmpEnvironmentProbe } from "../src/server/test-environment.js";

const A_HEALTHY_PROBE = {
  findCommand: async () => "/usr/local/bin/omp",
  readVersion: async () => "omp/17.3.8",
  isDirectory: async () => true,
  now: () => new Date("2026-08-26T09:30:00.000Z"),
};

const aProbe = (overrides?: Partial<OmpEnvironmentProbe>): OmpEnvironmentProbe => ({
  ...A_HEALTHY_PROBE,
  ...overrides,
});

const codesOf = (checks: readonly { code: string }[]): string[] => checks.map((check) => check.code);

const checkNamed = (
  checks: readonly { code: string; level: string; message: string; hint?: string | null }[],
  code: string,
) => checks.find((check) => check.code === code);

describe("reporting a usable omp installation", () => {
  it("passes when omp is installed and the workspace exists", async () => {
    const result = await testEnvironment({}, aProbe());

    expect(result.status).toBe("pass");
  });

  it("identifies which adapter was tested and when", async () => {
    const result = await testEnvironment({}, aProbe());

    expect(result.adapterType).toBe("omp");
    expect(result.testedAt).toBe("2026-08-26T09:30:00.000Z");
  });

  it("reports where omp was found", async () => {
    const result = await testEnvironment({}, aProbe());

    expect(checkNamed(result.checks, "omp_command")?.level).toBe("info");
    expect(checkNamed(result.checks, "omp_command")?.message).toContain("/usr/local/bin/omp");
  });

  it("reports the version it detected", async () => {
    const result = await testEnvironment({}, aProbe());

    expect(checkNamed(result.checks, "omp_version")?.message).toContain("17.3.8");
  });

  it("looks up whichever command the agent is configured to run", async () => {
    const asked: string[] = [];
    const probe = aProbe({
      findCommand: async (command) => {
        asked.push(command);
        return "/opt/omp-nightly";
      },
    });

    await testEnvironment({ command: "omp-nightly" }, probe);

    expect(asked).toEqual(["omp-nightly"]);
  });

  it("falls back to plain omp when the configured command is left blank", async () => {
    const asked: string[] = [];
    const probe = aProbe({
      findCommand: async (command) => {
        asked.push(command);
        return "/usr/local/bin/omp";
      },
    });

    await testEnvironment({ command: "   " }, probe);

    expect(asked).toEqual(["omp"]);
  });

  it("reads the version from the line, not some other number in it", async () => {
    const probe = aProbe({ readVersion: async () => "/opt/omp2/bin/omp: omp/17.3.8" });

    const result = await testEnvironment({}, probe);

    expect(result.status).toBe("pass");
  });

  it("looks up plain omp when no command is configured", async () => {
    const asked: string[] = [];
    const probe = aProbe({
      findCommand: async (command) => {
        asked.push(command);
        return "/usr/local/bin/omp";
      },
    });

    await testEnvironment({}, probe);

    expect(asked).toEqual(["omp"]);
  });
});

describe("reporting an omp that is not installed", () => {
  it("fails when the command cannot be found", async () => {
    const result = await testEnvironment({}, aProbe({ findCommand: async () => null }));

    expect(result.status).toBe("fail");
    expect(checkNamed(result.checks, "omp_command")?.level).toBe("error");
  });

  it("tells the operator how to install it", async () => {
    const result = await testEnvironment({}, aProbe({ findCommand: async () => null }));

    expect(checkNamed(result.checks, "omp_command")?.hint).toContain("omp.sh");
  });

  it("does not go on to probe a version that cannot exist", async () => {
    const result = await testEnvironment({}, aProbe({ findCommand: async () => null }));

    expect(codesOf(result.checks)).not.toContain("omp_version");
  });
});

describe("reporting a version this adapter has not been tested against", () => {
  it("warns without blocking when the major version differs", async () => {
    const result = await testEnvironment({}, aProbe({ readVersion: async () => "omp/18.0.0" }));

    expect(result.status).toBe("warn");
    expect(checkNamed(result.checks, "omp_version")?.level).toBe("warn");
  });

  it("accepts any patch or minor release of the tested major", async () => {
    const result = await testEnvironment({}, aProbe({ readVersion: async () => "omp/17.9.99" }));

    expect(result.status).toBe("pass");
  });

  it("warns without blocking when the version cannot be read", async () => {
    const result = await testEnvironment({}, aProbe({ readVersion: async () => null }));

    expect(result.status).toBe("warn");
    expect(checkNamed(result.checks, "omp_version")?.level).toBe("warn");
  });

  it("warns without blocking when the version is unrecognisable", async () => {
    const result = await testEnvironment({}, aProbe({ readVersion: async () => "not a version" }));

    expect(result.status).toBe("warn");
  });
});

describe("reporting a questionable working directory", () => {
  it("warns rather than blocking when the configured directory is missing", async () => {
    const probe = aProbe({ isDirectory: async () => false });

    const result = await testEnvironment({ cwd: "/workspace/project" }, probe);

    expect(result.status).toBe("warn");
    expect(checkNamed(result.checks, "omp_cwd")?.level).toBe("warn");
  });

  it("blocks on a relative directory, which cannot be resolved reliably", async () => {
    const result = await testEnvironment({ cwd: "./project" }, aProbe());

    expect(result.status).toBe("fail");
    expect(checkNamed(result.checks, "omp_cwd")?.level).toBe("error");
  });

  it("says nothing about a directory the agent did not configure", async () => {
    const result = await testEnvironment({}, aProbe());

    expect(codesOf(result.checks)).not.toContain("omp_cwd");
  });

  it("says nothing about a directory left blank in the form", async () => {
    const result = await testEnvironment({ cwd: "   " }, aProbe());

    expect(codesOf(result.checks)).not.toContain("omp_cwd");
  });

  it("checks the directory the agent actually configured", async () => {
    const asked: string[] = [];
    const probe = aProbe({
      isDirectory: async (path) => {
        asked.push(path);
        return true;
      },
    });

    await testEnvironment({ cwd: "/workspace/project" }, probe);

    expect(asked).toEqual(["/workspace/project"]);
  });
});

describe("combining findings into one verdict", () => {
  it("blocks when anything is broken, even alongside warnings", async () => {
    const probe = aProbe({ findCommand: async () => null, isDirectory: async () => false });

    const result = await testEnvironment({ cwd: "/workspace/project" }, probe);

    expect(result.status).toBe("fail");
  });

  it("warns when nothing is broken but something is questionable", async () => {
    const probe = aProbe({ readVersion: async () => "omp/18.0.0", isDirectory: async () => false });

    const result = await testEnvironment({ cwd: "/workspace/project" }, probe);

    expect(result.status).toBe("warn");
  });

  it("passes only when every finding is informational", async () => {
    const result = await testEnvironment({ cwd: "/workspace/project" }, aProbe());

    expect(result.status).toBe("pass");
    expect(result.checks.every((check) => check.level === "info")).toBe(true);
  });

  it("names every finding, so the UI can report them consistently", async () => {
    const result = await testEnvironment({ cwd: "/workspace/project" }, aProbe());

    expect(codesOf(result.checks)).toEqual(["omp_command", "omp_version", "omp_cwd"]);
  });
});
