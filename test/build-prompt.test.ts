import { describe, expect, it } from "vitest";

import { buildOmpPrompt, type PromptInputs } from "../src/server/prompt.js";

const anAgent = () => ({ id: "agent-1", name: "Ada", companyId: "company-9" });

const inputs = (overrides?: Partial<PromptInputs>): PromptInputs => ({
  agent: anAgent(),
  runId: "run-42",
  context: {},
  ...overrides,
});

describe("telling the agent who and where it is", () => {
  it("names the agent it is standing in for", () => {
    const prompt = buildOmpPrompt(inputs());

    expect(prompt).toContain("- Agent: Ada (agent-1)");
  });

  it("states the company and run so the agent can call back to Paperclip", () => {
    const prompt = buildOmpPrompt(inputs());

    expect(prompt).toContain("- Company: company-9");
    expect(prompt).toContain("- Run: run-42");
  });

  it("states its identity even when the template says nothing about it", () => {
    const prompt = buildOmpPrompt(inputs({ promptTemplate: "Get on with it." }));

    expect(prompt).toContain("- Agent: Ada (agent-1)");
    expect(prompt).toContain("- Company: company-9");
    expect(prompt).toContain("- Run: run-42");
  });
});

describe("carrying Paperclip's execution contract", () => {
  it("uses Paperclip's own agent contract rather than wording of our own", () => {
    const prompt = buildOmpPrompt(inputs());

    expect(prompt).toContain("Execution contract:");
    expect(prompt).toContain("do not stop at a plan unless the issue asks for planning");
  });
});

describe("describing the task", () => {
  it("passes the canonical task markdown through untouched", () => {
    const prompt = buildOmpPrompt(
      inputs({ context: { paperclipTaskMarkdown: "## Task ENG-1\n\nShip the thing." } }),
    );

    expect(prompt).toContain("## Task ENG-1\n\nShip the thing.");
  });

  it("describes the issue itself when no task markdown was built", () => {
    const prompt = buildOmpPrompt(
      inputs({
        context: {
          paperclipIssue: {
            id: "issue-1",
            identifier: "ENG-1",
            title: "Ship the thing",
            description: "Do it carefully.",
          },
        },
      }),
    );

    expect(prompt).toContain("ENG-1");
    expect(prompt).toContain("Ship the thing");
    expect(prompt).toContain("Do it carefully.");
  });

  it("prefers the canonical markdown over the structured issue", () => {
    const prompt = buildOmpPrompt(
      inputs({
        context: {
          paperclipTaskMarkdown: "## The real task",
          paperclipIssue: { identifier: "ENG-1", title: "Stale title", description: "Stale body." },
        },
      }),
    );

    expect(prompt).toContain("## The real task");
    expect(prompt).not.toContain("Stale title");
  });

  it("still produces a usable prompt when there is no task at all", () => {
    const prompt = buildOmpPrompt(inputs());

    expect(prompt).toContain("agent-1");
    expect(prompt.trim().length).toBeGreaterThan(0);
  });

  it("describes an issue that has a title but no description", () => {
    const prompt = buildOmpPrompt(
      inputs({ context: { paperclipIssue: { identifier: "ENG-2", title: "Investigate" } } }),
    );

    expect(prompt).toContain("ENG-2");
    expect(prompt).toContain("Investigate");
  });

  it("ignores an issue that carries nothing worth saying", () => {
    const withIssue = buildOmpPrompt(inputs({ context: { paperclipIssue: {} } }));
    const withoutIssue = buildOmpPrompt(inputs());

    expect(withIssue).toBe(withoutIssue);
  });

  it("survives an issue field that is present but empty", () => {
    const prompt = buildOmpPrompt(inputs({ context: { paperclipIssue: null } }));

    expect(prompt).toContain("- Agent: Ada (agent-1)");
  });

  it("falls back to the raw issue id when it has no human identifier", () => {
    const prompt = buildOmpPrompt(
      inputs({ context: { paperclipIssue: { id: "issue-abc", title: "Investigate" } } }),
    );

    expect(prompt).toContain("issue-abc");
  });

  it("describes an issue that has only a description", () => {
    const prompt = buildOmpPrompt(
      inputs({ context: { paperclipIssue: { description: "Just do this." } } }),
    );

    expect(prompt).toContain("Just do this.");
  });
});

describe("letting an operator override the wording", () => {
  it("uses the configured template instead of Paperclip's default", () => {
    const prompt = buildOmpPrompt(inputs({ promptTemplate: "Do the work, {{agent.name}}." }));

    expect(prompt).toContain("Do the work, Ada.");
    expect(prompt).not.toContain("Execution contract:");
  });

  it("fills in the run and company for a custom template too", () => {
    const prompt = buildOmpPrompt(
      inputs({ promptTemplate: "{{agent.id}} of {{company.id}} on {{runId}}" }),
    );

    expect(prompt).toContain("agent-1 of company-9 on run-42");
  });

  it("still attaches the task to a custom template", () => {
    const prompt = buildOmpPrompt(
      inputs({
        promptTemplate: "Custom opening.",
        context: { paperclipTaskMarkdown: "## Task ENG-1" },
      }),
    );

    expect(prompt).toContain("Custom opening.");
    expect(prompt).toContain("## Task ENG-1");
  });

  it("falls back to the default when the configured template is blank", () => {
    const prompt = buildOmpPrompt(inputs({ promptTemplate: "   " }));

    expect(prompt).toContain("Execution contract:");
  });
});

describe("producing a stable prompt", () => {
  it("builds the same prompt from the same inputs", () => {
    const given = inputs({ context: { paperclipTaskMarkdown: "## Task ENG-1" } });

    expect(buildOmpPrompt(given)).toBe(buildOmpPrompt(given));
  });

  it("separates its sections with blank lines rather than running them together", () => {
    const prompt = buildOmpPrompt(inputs({ context: { paperclipTaskMarkdown: "## Task ENG-1" } }));

    expect(prompt).toContain("\n\n## Task ENG-1");
  });
});
