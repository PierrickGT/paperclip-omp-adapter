import { describe, expect, it } from "vitest";

import { prepareSkills, type SkillEntry, type SkillsDeps } from "../src/server/skills.js";

const AGENT_CWD = "/workspace/project";
const TEMP_ROOT = "/tmp/paperclip-skills-abc";
const STAGED_SKILLS_DIR = `${TEMP_ROOT}/skills`;

/**
 * The runtime name is deliberately different from the key. omp is told the
 * runtime name while Paperclip selects on the key, and identical values would
 * hide a mix-up between them.
 */
const aSkill = (key: string): SkillEntry => ({
  key,
  runtimeName: `${key}-runtime`,
  source: `/paperclip/skills/${key}`,
});

type Recorder = {
  deps: SkillsDeps;
  links: { source: string; target: string }[];
  written: { path: string; contents: string }[];
  removed: string[];
  made: string[];
};

const aWorkspace = (overrides?: Partial<SkillsDeps>): Recorder => {
  const links: Recorder["links"] = [];
  const written: Recorder["written"] = [];
  const removed: string[] = [];
  const made: string[] = [];

  return {
    links,
    written,
    removed,
    made,
    deps: {
      listSkills: async () => [aSkill("paperclip"), aSkill("paperclip-create-agent")],
      makeTempDir: async () => TEMP_ROOT,
      makeDirectory: async (path) => {
        made.push(path);
      },
      linkSkill: async (source, target) => {
        links.push({ source, target });
      },
      writeFile: async (path, contents) => {
        written.push({ path, contents });
      },
      removeDir: async (path) => {
        removed.push(path);
      },
      ...overrides,
    },
  };
};

const warningsInto = (collected: string[]) => async (message: string) => {
  collected.push(message);
};

const ignoreWarnings = async () => {};

describe("making Paperclip's skills reachable by omp", () => {
  it("hands omp an overlay to load", async () => {
    const workspace = aWorkspace();

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(prepared.configOverlays).toHaveLength(1);
    expect(prepared.configOverlays[0]).toContain(TEMP_ROOT);
  });

  it("points that overlay at the directory holding the skills", async () => {
    const workspace = aWorkspace();

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    const overlay = workspace.written[0]?.contents ?? "";
    expect(overlay).toContain("skills:");
    expect(overlay).toContain("customDirectories:");
    expect(overlay).toContain(`"${STAGED_SKILLS_DIR}"`);
  });

  it("places every skill where the overlay says to look", async () => {
    const workspace = aWorkspace();

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(workspace.links).toHaveLength(2);
    for (const link of workspace.links) {
      expect(link.target.startsWith(`${STAGED_SKILLS_DIR}/`)).toBe(true);
    }
    expect(workspace.made).toContain(STAGED_SKILLS_DIR);
  });

  it("keeps each skill under its own runtime name", async () => {
    const workspace = aWorkspace();

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(workspace.links.map((link) => link.target.split("/").at(-1))).toEqual([
      "paperclip-runtime",
      "paperclip-create-agent-runtime",
    ]);
  });

  it("writes nothing whatsoever into the agent's own directory", async () => {
    const workspace = aWorkspace();

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    const touched = [
      ...workspace.links.map((link) => link.target),
      ...workspace.written.map((file) => file.path),
      ...workspace.made,
    ];
    for (const path of touched) {
      expect(path.startsWith(AGENT_CWD)).toBe(false);
    }
  });

  it("quotes the directory so an awkward path cannot break the overlay", async () => {
    const workspace = aWorkspace({ makeTempDir: async () => "/tmp/skills: odd #1" });

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(workspace.written[0]?.contents).toContain('"/tmp/skills: odd #1/skills"');
  });
});

describe("choosing which skills to expose", () => {
  it("exposes every skill when the agent has expressed no preference", async () => {
    const workspace = aWorkspace();

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(workspace.links).toHaveLength(2);
  });

  it("exposes only the skills the agent asked for", async () => {
    const workspace = aWorkspace();
    const config = { paperclipSkillSync: { desiredSkills: ["paperclip"] } };

    await prepareSkills(config, workspace.deps, ignoreWarnings);

    expect(workspace.links.map((link) => link.source)).toEqual(["/paperclip/skills/paperclip"]);
  });

  it("exposes nothing when the agent asked for nothing", async () => {
    const workspace = aWorkspace();
    const config = { paperclipSkillSync: { desiredSkills: [] as string[] } };

    const prepared = await prepareSkills(config, workspace.deps, ignoreWarnings);

    expect(workspace.links).toHaveLength(0);
    expect(prepared.configOverlays).toHaveLength(0);
  });

  it("ignores a requested skill that does not exist", async () => {
    const workspace = aWorkspace();
    const config = { paperclipSkillSync: { desiredSkills: ["nope"] } };

    await prepareSkills(config, workspace.deps, ignoreWarnings);

    expect(workspace.links).toHaveLength(0);
  });

  it("does nothing at all when Paperclip ships no skills", async () => {
    const workspace = aWorkspace({ listSkills: async () => [] });

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(prepared.configOverlays).toHaveLength(0);
    expect(workspace.written).toHaveLength(0);
  });
});

describe("clearing up after the run", () => {
  it("removes everything it created", async () => {
    const workspace = aWorkspace();

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);
    await prepared.cleanup();

    expect(workspace.removed).toEqual(["/tmp/paperclip-skills-abc"]);
  });

  it("has nothing to clear up when it created nothing", async () => {
    const workspace = aWorkspace({ listSkills: async () => [] });

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);
    await prepared.cleanup();

    expect(workspace.removed).toHaveLength(0);
  });

  it("does not fail the run when clearing up fails", async () => {
    const workspace = aWorkspace({
      removeDir: async () => {
        throw new Error("device busy");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);

    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });
});

describe("carrying on when skills cannot be injected", () => {
  it("still runs when a skill cannot be linked", async () => {
    const warnings: string[] = [];
    const workspace = aWorkspace({
      linkSkill: async (source) => {
        if (source.endsWith("paperclip")) throw new Error("permission denied");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, warningsInto(warnings));

    expect(prepared.configOverlays).toHaveLength(1);
    expect(warnings.join(" ")).toContain("permission denied");
  });

  it("still runs when no temporary directory can be made", async () => {
    const warnings: string[] = [];
    const workspace = aWorkspace({
      makeTempDir: async () => {
        throw new Error("read-only file system");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, warningsInto(warnings));

    expect(prepared.configOverlays).toHaveLength(0);
    expect(warnings.join(" ")).toContain("read-only file system");
  });

  it("still runs when the staging directory cannot be created", async () => {
    const warnings: string[] = [];
    const workspace = aWorkspace({
      makeDirectory: async () => {
        throw new Error("no space left on device");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, warningsInto(warnings));

    expect(prepared.configOverlays).toHaveLength(0);
    expect(warnings.join(" ")).toContain("no space left on device");
  });

  it("clears up what it staged when the overlay cannot be written", async () => {
    const workspace = aWorkspace({
      writeFile: async () => {
        throw new Error("permission denied");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(prepared.configOverlays).toHaveLength(0);
    expect(workspace.removed).toEqual([TEMP_ROOT]);
  });

  it("reports a failure that was not thrown as an error", async () => {
    const warnings: string[] = [];
    const workspace = aWorkspace({
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      listSkills: async () => {
        throw "skills backend offline";
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, warningsInto(warnings));

    expect(prepared.configOverlays).toHaveLength(0);
    expect(warnings.join(" ")).toContain("skills backend offline");
  });

  it("still runs when the skills cannot even be listed", async () => {
    const warnings: string[] = [];
    const workspace = aWorkspace({
      listSkills: async () => {
        throw new Error("skills directory missing");
      },
    });

    const prepared = await prepareSkills({}, workspace.deps, warningsInto(warnings));

    expect(prepared.configOverlays).toHaveLength(0);
    expect(warnings.join(" ")).toContain("skills directory missing");
  });

  it("links the skills it can when one of them fails", async () => {
    const linked: string[] = [];
    const workspace = aWorkspace({
      linkSkill: async (source) => {
        if (source.endsWith("/paperclip")) throw new Error("permission denied");
        linked.push(source);
      },
    });

    await prepareSkills({}, workspace.deps, ignoreWarnings);

    expect(linked).toEqual(["/paperclip/skills/paperclip-create-agent"]);
  });
});
