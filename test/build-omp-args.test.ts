import { describe, expect, it } from "vitest";

import { buildOmpArgs, type OmpInvocation } from "../src/server/args.js";

const anInvocation = (overrides?: Partial<OmpInvocation>): OmpInvocation => ({
  prompt: "Continue your Paperclip work.",
  cwd: "/workspace/project",
  sessionDir: "/home/user/.omp/paperclip/agent-1",
  ...overrides,
});

describe("invoking omp for an unattended Paperclip run", () => {
  it("runs non-interactively and emits the machine-readable event stream", () => {
    const args = buildOmpArgs(anInvocation());

    expect(args).toContain("-p");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("json");
  });

  it("approves tool calls automatically, since nobody is at the terminal", () => {
    expect(buildOmpArgs(anInvocation())).toContain("--auto-approve");
  });

  it("pins the working directory and the session store", () => {
    const args = buildOmpArgs(anInvocation());

    expect(args[args.indexOf("--cwd") + 1]).toBe("/workspace/project");
    expect(args[args.indexOf("--session-dir") + 1]).toBe("/home/user/.omp/paperclip/agent-1");
  });

  it("passes the task as the trailing positional argument", () => {
    expect(buildOmpArgs(anInvocation()).at(-1)).toBe("Continue your Paperclip work.");
  });

  it("keeps the task last even when extra arguments are configured", () => {
    const args = buildOmpArgs(anInvocation({ extraArgs: ["--no-lsp", "--max-time", "10m"] }));

    expect(args.at(-1)).toBe("Continue your Paperclip work.");
    expect(args).toContain("--no-lsp");
    expect(args.indexOf("--no-lsp")).toBeLessThan(args.length - 1);
  });
});

describe("selecting a model", () => {
  it("passes a provider-qualified model as one value", () => {
    const args = buildOmpArgs(anInvocation({ model: "anthropic/claude-opus-5" }));

    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-opus-5");
  });

  it("never splits the model across the legacy provider flag", () => {
    const args = buildOmpArgs(anInvocation({ model: "anthropic/claude-opus-5" }));

    expect(args).not.toContain("--provider");
    expect(args).not.toContain("anthropic");
  });

  it("lets omp choose when no model is configured", () => {
    expect(buildOmpArgs(anInvocation())).not.toContain("--model");
  });

  it("treats a blank model as no model rather than an empty flag value", () => {
    expect(buildOmpArgs(anInvocation({ model: "   " }))).not.toContain("--model");
  });
});

describe("resuming an earlier run", () => {
  it("resumes the session it is given", () => {
    const args = buildOmpArgs(anInvocation({ resumeSessionId: "01a030e2-a211-7000-9964-0903ee42ed0f" }));

    expect(args[args.indexOf("--resume") + 1]).toBe("01a030e2-a211-7000-9964-0903ee42ed0f");
  });

  it("starts fresh when there is no session to resume", () => {
    expect(buildOmpArgs(anInvocation())).not.toContain("--resume");
  });

  it("starts fresh rather than resuming a blank session id", () => {
    expect(buildOmpArgs(anInvocation({ resumeSessionId: "" }))).not.toContain("--resume");
  });
});

describe("supplying the agent's standing instructions", () => {
  it("hands omp the instructions file as a plain path", () => {
    const args = buildOmpArgs(anInvocation({ instructionsFilePath: "/workspace/AGENT.md" }));

    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/workspace/AGENT.md");
  });

  it("does not prefix the instructions path with @", () => {
    const args = buildOmpArgs(anInvocation({ instructionsFilePath: "/workspace/AGENT.md" }));

    expect(args).not.toContain("@/workspace/AGENT.md");
  });

  it("omits the flag when the agent has no standing instructions", () => {
    expect(buildOmpArgs(anInvocation())).not.toContain("--append-system-prompt");
  });
});

describe("making Paperclip skills reachable", () => {
  it("loads each configuration overlay omp should apply", () => {
    const args = buildOmpArgs(anInvocation({ configOverlays: ["/tmp/skills-a.yml", "/tmp/skills-b.yml"] }));

    expect(args.filter((arg) => arg === "--config")).toHaveLength(2);
    expect(args).toContain("/tmp/skills-a.yml");
    expect(args).toContain("/tmp/skills-b.yml");
  });

  it("loads nothing when there is no overlay to apply", () => {
    expect(buildOmpArgs(anInvocation())).not.toContain("--config");
  });

  it("ignores a blank overlay path", () => {
    expect(buildOmpArgs(anInvocation({ configOverlays: ["  "] }))).not.toContain("--config");
  });

  it("never reaches for --add-dir, which does not load skills", () => {
    const args = buildOmpArgs(anInvocation({ configOverlays: ["/tmp/skills-a.yml"] }));

    expect(args).not.toContain("--add-dir");
  });
});

describe("thinking level", () => {
  it("passes the configured thinking level through", () => {
    const args = buildOmpArgs(anInvocation({ thinking: "high" }));

    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("leaves omp on its default when no level is configured", () => {
    expect(buildOmpArgs(anInvocation())).not.toContain("--thinking");
  });
});

describe("producing a stable command line", () => {
  it("builds the same arguments for the same invocation", () => {
    const invocation = anInvocation({ model: "opus", thinking: "high", resumeSessionId: "01a03" });

    expect(buildOmpArgs(invocation)).toEqual(buildOmpArgs(invocation));
  });

  it("builds the full command line in a predictable order", () => {
    const args = buildOmpArgs(
      anInvocation({
        model: "opus",
        thinking: "high",
        resumeSessionId: "01a03",
        instructionsFilePath: "/workspace/AGENT.md",
        configOverlays: ["/tmp/skills.yml"],
        extraArgs: ["--no-lsp"],
      }),
    );

    expect(args).toEqual([
      "-p",
      "--mode",
      "json",
      "--auto-approve",
      "--cwd",
      "/workspace/project",
      "--session-dir",
      "/home/user/.omp/paperclip/agent-1",
      "--resume",
      "01a03",
      "--model",
      "opus",
      "--thinking",
      "high",
      "--append-system-prompt",
      "/workspace/AGENT.md",
      "--config",
      "/tmp/skills.yml",
      "--no-lsp",
      "Continue your Paperclip work.",
    ]);
  });
});
