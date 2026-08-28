import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  isDirectory,
  readCommandVersion,
  resolveCommandPath,
  stagingDeps,
} from "../src/server/runtime.js";

/**
 * These exercise the real filesystem and real child processes, because they are
 * the bindings every other test replaces with a fake. `node` stands in for
 * `omp`: it is guaranteed present and its `--version` output is stable.
 */

const scratchDirs: string[] = [];

const aScratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "omp-adapter-test-"));
  scratchDirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("finding a command on the host", () => {
  it("finds a command that is on PATH", async () => {
    const found = await resolveCommandPath("node", process.env);

    expect(found).not.toBeNull();
    expect(found).toContain("node");
  });

  it("reports nothing for a command that is not installed", async () => {
    expect(await resolveCommandPath("definitely-not-a-real-command-xyz", process.env)).toBeNull();
  });

  it("accepts a command given as an absolute path", async () => {
    const nodePath = execFileSync("which", ["node"], { encoding: "utf8" }).trim();

    expect(await resolveCommandPath(nodePath, process.env)).toBe(nodePath);
  });

  it("reports nothing for an absolute path that is not there", async () => {
    expect(await resolveCommandPath("/nowhere/omp", process.env)).toBeNull();
  });

  it("reports nothing when the host has no PATH at all", async () => {
    expect(await resolveCommandPath("node", {})).toBeNull();
  });

  it("does not mistake a directory for a command", async () => {
    const dir = await aScratchDir();
    await mkdir(join(dir, "node"));

    expect(await resolveCommandPath("node", { PATH: dir })).toBeNull();
  });
});

describe("reading a command's version", () => {
  it("reads the version a command reports, and nothing else it prints", async () => {
    // Exact, not a loose match: `--help` output also contains version-shaped
    // text, so a loose assertion would not notice the wrong flag being used.
    expect(await readCommandVersion("node")).toBe(process.version);
  });

  it("reports nothing when the command cannot be run", async () => {
    expect(await readCommandVersion("definitely-not-a-real-command-xyz")).toBeNull();
  });

  it("reports nothing when the command says nothing", async () => {
    const script = join(await aScratchDir(), "silent");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(await readCommandVersion(script)).toBeNull();
  });
});

describe("looking at a path on disk", () => {
  it("recognises a directory", async () => {
    expect(await isDirectory(await aScratchDir())).toBe(true);
  });

  it("does not mistake a file for a directory", async () => {
    const file = join(await aScratchDir(), "note.txt");
    await writeFile(file, "hello", "utf8");

    expect(await isDirectory(file)).toBe(false);
  });

  it("reports nothing there when nothing is there", async () => {
    expect(await isDirectory("/nowhere/at/all")).toBe(false);
  });
});

describe("staging files for a run", () => {
  it("makes a temporary directory nobody else is using", async () => {
    const first = await stagingDeps.makeTempDir();
    const second = await stagingDeps.makeTempDir();
    scratchDirs.push(first, second);

    expect(first).not.toBe(second);
    expect(await isDirectory(first)).toBe(true);
  });

  it("makes a directory, including its parents", async () => {
    const nested = join(await aScratchDir(), "skills", "deeper");

    await stagingDeps.makeDirectory(nested);

    expect(await isDirectory(nested)).toBe(true);
  });

  it("writes a file where it is told", async () => {
    const path = join(await aScratchDir(), "overlay.yml");

    await stagingDeps.writeFile(path, "skills:\n");

    expect(await isDirectory(path)).toBe(false);
  });

  it("links a skill so the runtime can read it through the link", async () => {
    const source = join(await aScratchDir(), "a-skill");
    const staged = await aScratchDir();
    await stagingDeps.makeDirectory(source);
    await stagingDeps.writeFile(join(source, "SKILL.md"), "# a skill\n");

    await stagingDeps.linkSkill(source, join(staged, "a-skill"));

    expect(await isDirectory(join(staged, "a-skill"))).toBe(true);
  });

  it("removes a staged directory and everything under it", async () => {
    const staged = await aScratchDir();
    await stagingDeps.makeDirectory(join(staged, "skills"));

    await stagingDeps.removeDir(staged);

    expect(await isDirectory(staged)).toBe(false);
  });

  it("does not complain about removing something already gone", async () => {
    await expect(stagingDeps.removeDir("/nowhere/at/all")).resolves.toBeUndefined();
  });
});
