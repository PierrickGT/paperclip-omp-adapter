import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentConfigurationDoc,
  createServerAdapter,
  label,
  models,
  type,
} from "../src/server/index.js";

describe("what the adapter tells Paperclip about itself", () => {
  it("identifies itself as the omp adapter", () => {
    expect(type).toBe("omp");
  });

  it("gives itself a name a person would recognise", () => {
    expect(label).toBe("omp");
  });

  it("lists no models of its own, because omp resolves them", () => {
    expect(models).toEqual([]);
  });
});

describe("the server adapter Paperclip builds", () => {
  it("offers everything the host calls", () => {
    const adapter = createServerAdapter();

    expect(adapter.type).toBe("omp");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.getConfigSchema).toBe("function");
    expect(adapter.sessionCodec).toBeDefined();
  });

  it("lets an agent call the Paperclip API with its own identity", () => {
    expect(createServerAdapter().supportsLocalAgentJwt).toBe(true);
  });

  it("carries the configuration documentation through to the host", () => {
    expect(createServerAdapter().agentConfigurationDoc).toBe(agentConfigurationDoc);
  });

  it("describes its settings through the same schema the form renders", () => {
    const fields = createServerAdapter().getConfigSchema().fields;

    expect(fields.map((field) => field.key)).toContain("model");
  });

  it("reports a failing environment rather than throwing when omp is absent", async () => {
    const result = await createServerAdapter().testEnvironment({
      companyId: "company-9",
      adapterType: "omp",
      config: { command: "definitely-not-a-real-command-xyz" },
    });

    expect(result.status).toBe("fail");
    expect(result.adapterType).toBe("omp");
  });
});

describe("the documentation an LLM reads before choosing this adapter", () => {
  it("says when to reach for it and when not to", () => {
    expect(agentConfigurationDoc).toContain("Use when");
    expect(agentConfigurationDoc).toContain("Don't use when");
  });

  it("documents every setting the form offers", () => {
    for (const field of createServerAdapter().getConfigSchema().fields) {
      expect(agentConfigurationDoc).toContain(field.key);
    }
  });

  it("names only commands omp actually has", () => {
    expect(agentConfigurationDoc).toContain("omp models");
    expect(agentConfigurationDoc).not.toContain("--list-models");
  });

  it("warns about the stdin hang, which anyone hand-rolling omp will hit", () => {
    expect(agentConfigurationDoc.toLowerCase()).toContain("stdin");
  });

  it("explains how to reach a subscription plan rather than an API key", () => {
    expect(agentConfigurationDoc).toContain("auth-broker");
  });

  it("inlines no skill content, which would bloat every prompt", () => {
    expect(agentConfigurationDoc.length).toBeLessThan(6000);
  });
});

describe("the wiring that meets the real host", () => {
  it("spawns the configured command and reports what happened", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "omp-adapter-wiring-"));
    const logged: string[] = [];

    try {
      // `node` stands in for `omp`: it is guaranteed present, and given omp's
      // flags it exits immediately. That is enough to prove the process runner,
      // the directory check and the skills staging are really wired up.
      const result = await createServerAdapter().execute({
        runId: "run-wiring",
        agent: { id: "agent-1", companyId: "company-9", name: "Ada" },
        config: { command: "node", cwd: workspace, timeoutSec: 20, graceSec: 2 },
        context: {},
        onLog: async (stream, chunk) => {
          logged.push(`${stream}:${chunk}`);
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.errorMessage).toBeTruthy();
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates the working directory it was told to run in", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omp-adapter-wiring-"));
    const workspace = join(parent, "made-on-demand");

    try {
      await createServerAdapter().execute({
        runId: "run-wiring",
        agent: { id: "agent-1", companyId: "company-9", name: "Ada" },
        config: { command: "node", cwd: workspace, timeoutSec: 20, graceSec: 2 },
        context: {},
        onLog: async () => {},
      });

      expect((await stat(workspace)).isDirectory()).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
