/**
 * Builds the task prompt sent to omp as its trailing positional argument.
 *
 * The default wording is Paperclip's own `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`,
 * not something invented here, so this adapter inherits the same execution
 * contract as the built-in ones: act in this heartbeat, leave durable progress,
 * reach a clear disposition, use child issues rather than polling.
 *
 * Skill content is never inlined. Skills are on-demand procedures — omp sees each
 * skill's name and description and loads the body only when it decides to, which
 * keeps the base prompt small.
 */

import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderTemplate,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";

export type PromptAgent = {
  readonly id: string;
  readonly name: string;
  readonly companyId: string;
};

export type PromptInputs = {
  readonly agent: PromptAgent;
  readonly runId: string;
  readonly context: Record<string, unknown>;
  readonly promptTemplate?: string | undefined;
  readonly resumedSession?: boolean | undefined;
};

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const identitySection = (agent: PromptAgent, runId: string): string =>
  [
    "Paperclip runtime:",
    `- Agent: ${agent.name} (${agent.id})`,
    `- Company: ${agent.companyId}`,
    `- Run: ${runId}`,
  ].join("\n");

/**
 * Describes the issue directly.
 *
 * `selectPaperclipTaskMarkdown` returns an empty string when the server did not
 * build task markdown — it reads only `paperclipTaskMarkdown` and ignores the
 * structured issue entirely. Without this fallback an agent woken with only a
 * structured issue would receive no task at all.
 */
const issueSection = (context: Record<string, unknown>): string | null => {
  const issue = context["paperclipIssue"];
  if (typeof issue !== "object" || issue === null) return null;

  const fields = issue as Record<string, unknown>;
  const identifier = asTrimmed(fields["identifier"]) ?? asTrimmed(fields["id"]);
  const title = asTrimmed(fields["title"]);
  const description = asTrimmed(fields["description"]);

  const heading = [identifier, title].filter((part) => part !== null).join(": ");
  if (heading.length === 0 && description === null) return null;

  return joinPromptSections([heading.length > 0 ? `## Task ${heading}` : "## Task", description]);
};

const taskSection = (context: Record<string, unknown>, resumedSession: boolean): string | null =>
  asTrimmed(selectPaperclipTaskMarkdown(context, { resumedSession })) ?? issueSection(context);

export const buildOmpPrompt = (inputs: PromptInputs): string => {
  const template = asTrimmed(inputs.promptTemplate) ?? DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;

  const opening = renderTemplate(template, {
    agent: inputs.agent,
    agentId: inputs.agent.id,
    company: { id: inputs.agent.companyId },
    companyId: inputs.agent.companyId,
    run: { id: inputs.runId },
    runId: inputs.runId,
    context: inputs.context,
  });

  return joinPromptSections([
    opening,
    identitySection(inputs.agent, inputs.runId),
    taskSection(inputs.context, inputs.resumedSession ?? false),
  ]);
};
