# Plan: `omp` — External Paperclip Adapter for omp

**Branch**: `feat/omp-adapter`
**Status**: Active
**Created**: 2026-08-23
**Last revised**: 2026-08-23 — reconciled against the authoritative `create-agent-adapter` skill

## Goal

Ship `paperclip-omp-adapter` (npm, unscoped; published by [pierrick](https://www.npmjs.com/~pierrick)), an external Paperclip adapter that runs [omp](https://omp.sh) as the agent runtime for a Paperclip agent, with session resume across heartbeats and accurate usage/cost reporting.

The adapter type is **`omp`**, not `omp_local`. PR #2810 used `omp_local` to sit alongside Paperclip's in-tree `pi_local` / `gemini_local` / `opencode_local` types, but that suffix marks an in-tree local-runtime family we are not joining — the external reference adapter is likewise just `paperclip-prime-agent-adapter`. Execution is still a child process on the Paperclip host; the name simply does not encode it.

**Package name is unscoped by choice, not by requirement.** Paperclip's plugin loader resolves external adapters by explicit npm package name or local path (Board UI, or `POST /api/adapters/install`) — there is no name-pattern discovery, so scoped and unscoped load identically. Unscoped wins on precedent (`paperclip-prime-agent-adapter`), discoverability, and avoiding `--access public` on a scope with no prior publishes. Both `paperclip-omp-adapter` and `@pierrick/paperclip-omp-adapter` were verified available on 2026-08-23.

**The README must state that this is a community package.** The official org publishes under `@paperclipai/*`; an unscoped `paperclip-…` name must not be mistakable for a first-party adapter.

---

## Part A — The Paperclip Adapter Contract

Source of truth: [`.agents/skills/create-agent-adapter/SKILL.md`](https://github.com/paperclipai/paperclip/blob/master/.agents/skills/create-agent-adapter/SKILL.md) in the Paperclip repo. This supersedes anything inferred from the prime adapter's `.d.ts` or from PR #2810.

### `AdapterExecutionResult` — the shape we must return

```ts
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: UsageSummary;           // { inputTokens, outputTokens, cachedInputTokens? }
  sessionId?: string | null;      // Legacy — prefer sessionParams
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;        // Human-readable summary of what the agent did
  clearSession?: boolean;         // true = tell Paperclip to forget the stored session
}
```

Three corrections this forces on the earlier draft of this plan:

**1. The assistant's final text goes in `summary`, not `result`.** There is no `result` field.

**2. Usage field names do not match omp's.** A mapping layer is mandatory:

| omp emits | Paperclip expects |
|---|---|
| `usage.input` | `usage.inputTokens` |
| `usage.output` | `usage.outputTokens` |
| `usage.cacheRead` | `usage.cachedInputTokens` |
| `usage.cost.total` | `costUsd` (top-level, not nested) |
| `usage.cacheWrite`, `usage.totalTokens` | no home — keep in `resultJson` |

**3. There is no `resultMeta`.** `usage` and `costUsd` are top-level result fields.

### `AdapterExecutionContext` — what we receive

```ts
interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;          // { id, companyId, name, adapterType, adapterConfig }
  runtime: AdapterRuntime;      // { sessionId, sessionParams, sessionDisplayId, taskKey }
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  authToken?: string;
}
```

**The prior session arrives on `ctx.runtime`, not `ctx.context.session`.** PR #2810 read `context.session`; this plan previously inherited that error. Read `runtime.sessionParams` / `runtime.sessionId`.

### Session handling — two rules the earlier draft missed

**Resume must be cwd-aware.** The skill gives the pattern used by both `claude-local` and `codex-local`, to prevent cross-project session contamination:

```ts
const canResumeSession =
  runtimeSessionId.length > 0 &&
  (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
const sessionId = canResumeSession ? runtimeSessionId : null;
```

**A stale session is retried inside `execute()`, not reported upward.** The earlier draft had the parser raise `unknownSession: true` and stop — that was PR #2810's invention. The real contract:

```ts
if (sessionId && !proc.timedOut && exitCode !== 0 && isUnknownSessionError(output)) {
  const retry = await runAttempt(null);           // rerun fresh, same execute() call
  return toResult(retry, { clearSessionOnMissingSession: true });  // → clearSession: true
}
```

The skill is explicit that session reuse is the **default primitive, not an optimisation**: an agent may be woken dozens of times for one issue, and each wake should resume so it keeps context about files read and decisions made.

### `testEnvironment` — status computation is specified

Contract confirmed as previously planned (`{adapterType, status, checks[], testedAt}`), with the status rule made exact:

- `fail` if any check is `error`
- `warn` if no errors and at least one `warn`
- `pass` otherwise

Severity policy is called **product-critical**: warnings must not block saving. The worked example is that a detected `ANTHROPIC_API_KEY` on `claude_local` is a `warn`, never an `error`, because the runtime still works — it just uses a different auth path. Our omp equivalents must follow the same logic.

### Export shape — external differs from in-tree

The four-export convention (`.`, `./server`, `./ui`, `./cli`) in the skill is the **in-tree workspace** layout. Confirmed by the Paperclip team, an **external** adapter ships two entries:

```json
{
  "exports": {
    ".": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  },
  "paperclip": { "adapterUiParser": "1.0.0" }
}
```

Un-built `./src/*.ts` exports are a workspace convenience, **not** the external convention — ship compiled TypeScript with `.d.ts`. `adapterUiParser` is matched on **major only**: declaring `1.0.0` against a host expecting `1.x` loads; declaring `2.0.0` warns and falls back to the generic parser; omitting the field still loads today but may be required later.

### The full `TranscriptEntry` contract

```typescript
{ kind: "assistant";   ts: string; text: string; delta?: boolean }
{ kind: "thinking";    ts: string; text: string; delta?: boolean }
{ kind: "user";        ts: string; text: string }
{ kind: "tool_call";   ts: string; name: string; input: unknown; toolUseId?: string }
{ kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
{ kind: "system";      ts: string; text: string }
{ kind: "stderr";      ts: string; text: string }
{ kind: "stdout";      ts: string; text: string }
```

Tool calls and results are linked by `toolUseId` for collapsible card rendering. Note there is **no `init` or `result` kind** here — usage and cost reach Paperclip through `AdapterExecutionResult` from the server module, not through the parser.

### Prompt default

`DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` is exported from `@paperclipai/adapter-utils/server-utils` — **verified present** at `dist/server-utils.d.ts:52` as `export declare const`, which an earlier grep for `declare function` missed. It is not on the package root; import it from the `/server-utils` subpath. It **should be the default**, so the adapter inherits Paperclip's execution contract: act in the same heartbeat, avoid planning-only exits unless asked, leave durable progress and a next action, use child issues rather than polling, mark blockers with owner and action, respect governance boundaries. The earlier draft invented its own default string.

### Skills injection — the ranked pattern

The skill ranks injection approaches and states one hard constraint: **never copy or symlink skills into the agent's `cwd`**, because cwd is the user's project checkout and writing there contaminates the repo, breaks git status, and can leak into commits.

1. **Best — tmpdir + "additional directory" flag** (claude-local): `mkdtemp("paperclip-skills-")`, symlink skills in, pass the flag, `fs.rm` in a `finally`. Zero side effects.
2. Acceptable — the runtime's own global config dir (codex-local), skipping entries that already exist so user customisations survive.
3. Acceptable — an env var pointing at the skills directory.
4. Last resort — inline skill content into the prompt.

**omp has `--add-dir=<value>` (verified in `omp --help`), so option 1 applies directly.** This resolves the earlier open question and overrides PR #2810's approach of symlinking into `~/.omp/agent/skills/`, which is option 2 at best and was never verified to be omp's discovery path.

Also load-bearing: do **not** inline skill content into `agentConfigurationDoc` or the prompt template. Skills are on-demand procedures — the agent sees name and description, and loads the body only when it decides to. And for mandatory procedures, instruct explicitly ("Use the paperclip skill to report progress") rather than relying on fuzzy description matching.

### Other contract details worth pinning

- `runChildProcess(runId, cmd, args, opts)` — positional signature. PR #2810 called it with a single options object.
- `ensureCommandResolvable(cmd, cwd, env)` — three arguments.
- `onMeta(...)` must be called **before** spawning, with `redactEnvForLogs()` applied to any env included.
- `agentConfigurationDoc` is read by LLM agents configuring other agents. Write it as **routing logic** with explicit "Use when" / "Don't use when" sections; the skill notes one concrete anti-pattern is worth more than three paragraphs of description.
- Treat agent stdout as untrusted: never `eval`, use the safe extraction helpers, validate session IDs before passing them on, and record but never act on URLs, paths, or commands found in output.
- Secrets go in env, never in prompts or config that flows through the LLM. `redactEnvForLogs()` masks `/(key|token|secret|password|authorization|cookie)/i`.
- `timeoutSec` / `graceSec` are described as safety rails to always enforce.

---

## Part B — Verified Facts (probed against installed `omp v17.3.8`)

Everything below was confirmed by running the real binary at `~/Library/pnpm/omp`, not read from docs. `omp.sh/docs` is a client-rendered SPA that returns HTTP 403 to fetchers, so the binary is the only source of truth.

### The CLI surface we depend on

| Flag | Verified behaviour |
|---|---|
| `-p, --print` | Non-interactive: process prompt, exit. Exit code 0 on success. |
| `--mode=json` | Emits JSONL event stream on stdout. Values: `text` (default), `json`, `rpc`, `rpc-ui`. |
| `--model=<value>` | Fuzzy match. Accepts `opus`, `gpt-5.2`, or `openai/gpt-5.2`. |
| `--provider=<value>` | Exists but documented as **legacy; prefer `--model`**. Do not use. |
| `--thinking=<value>` | `off\|minimal\|low\|medium\|high\|xhigh\|max\|auto` |
| `--cwd=<value>` | Directory to start in, overrides launch cwd. |
| `--add-dir=<value>` | Add a workspace directory beyond the working directory (repeatable). **This is the skills-injection hook.** |
| `--session-dir=<value>` | Directory for session storage and lookup. |
| `-r, --resume=<value>` | Resume by ID prefix, path, or picker. |
| `--append-system-prompt=<value>` | Appends text **or file contents** to the system prompt. |
| `--max-time=<value>` | Stop session after duration (`600`, `10m`, `1h`). |
| `--auto-approve` | Auto-approve all tool calls. **Required for unattended runs.** |
| `--approval-mode=<value>` | `always-ask\|write\|yolo` |
| `--no-lsp`, `--no-tools`, `--tools=`, `--skills=`, `--no-skills` | Tool/skill scoping. |
| `--profile=<value>` | Isolated auth, sessions, settings, caches. |
| `omp models` | Lists models. (Note: `--list-models` does **not** exist.) |

### ⚠ Process invocation: stdin must be closed

**If omp is spawned with an open pipe on stdin, it never starts.** It prints
`Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…`, then `Still starting after Ns — phase: readPipedInput` every ten seconds, until killed. Confirmed by a run that hit a 120 s timeout with zero stdout; the identical command with `</dev/null` completed immediately.

`runChildProcess` pipes stdin by default, so **the adapter must explicitly close or ignore the child's stdin**. Without this every run hangs until `timeoutSec` expires. This is the single most likely cause of a silent "adapter does nothing" failure.

The flip side is a useful capability: omp will take the prompt from stdin when one is piped. For very large Paperclip task markdown that is safer than the positional argument, which is bounded by `ARG_MAX`. Not adopted for v1 — noted as the escape hatch if a long task ever fails to spawn.

### The JSON event stream

`omp -p --mode json "..."` emits newline-delimited JSON. Observed event types, in order:

```
session → agent_start → turn_start → message_start → message_update* → message_end → turn_end → agent_end → notice*
```

**1. The session ID is on the FIRST line, not the last.**
```json
{"type":"session","version":3,"id":"01a03076-c564-7000-9b98-6d4777b6a2c9","timestamp":"...","cwd":"/abs/path"}
```

**2. The LAST line is not the result.** In every probe run the final line was a `notice`:
```json
{"type":"notice","level":"warning","message":"Advisor unavailable for ...","source":"advisor"}
```

The terminal result is the `agent_end` event, which carries `isTerminal: true` and the full `messages` array. Assistant text lives in `content[]` blocks of `type: "text"`; blocks of `type: "thinking"` must be excluded from `summary` but are surfaced separately in the UI parser.

**2b. Usage is per-message and must be SUMMED; `summary` comes from the LAST assistant message only.** Confirmed by the `03-tool-use` fixture, which has two assistant messages carrying separate `usage` objects (in 70/out 74/cost 0.0074956 and in 400/out 29/cost 0.00774296 — run totals 470/103/0.01523856). Reading only the last message under-reports usage by roughly half. Conversely `messages[1]` there is `thinking` + `toolCall` with **no text at all**, so the answer lives only in `messages[3]` — concatenating all assistant text would prepend tool-call noise. Roles are `user`, `assistant`, `toolResult`; content block types are `text`, `thinking`, `toolCall` (camelCase). `agent_end.messages[]` holds only the current run's messages, not session history, so summing over it yields per-run usage — exactly what Paperclip wants.

**3. Usage and cost come free and exact**, on `message_end`, `turn_end`, and inside `agent_end.messages[]`:
```json
{"api":"anthropic-messages","provider":"zai","model":"glm-5.3",
 "usage":{"input":21272,"output":14,"cacheRead":5824,"cacheWrite":0,"totalTokens":27110,
          "cost":{"input":0.0297808,"output":0.0000616,"cacheRead":0.00151424,"cacheWrite":0,"total":0.03135664}},
 "stopReason":"stop","duration":1886.1,"ttft":1736.3}
```
`provider` and `model` here are the **actual** resolved values after fuzzy matching — report these, not the configured string. See Part A for the required field-name mapping.

**4. `message_update` carries streaming deltas** (`thinking_start`/`thinking_delta`/`thinking_end`/`text_start`/`text_delta`/`text_end`, each with a `contentIndex`). These feed the run viewer.

### Session storage and resume

Default location is **keyed by cwd**:
```
~/.omp/agent/sessions/<slugified-abs-cwd>/<ISO-timestamp>_<uuid>.jsonl
```

With an explicit `--session-dir <abs>`, sessions are written **flat into that directory**, with no cwd-slug subdirectory:
```
<session-dir>/<ISO-timestamp>_<uuid>.jsonl
```

**This is the decisive fact for resume.** Relying on the default location breaks resume whenever Paperclip relocates the execution workspace, so we pass an explicit per-agent `--session-dir`. Note this does **not** remove the need for the cwd-aware resume guard from Part A — that guard exists to prevent cross-project contamination, which is a separate concern from storage location.

Resume verified end-to-end: `omp -p --mode json -r <uuid> "What did I just ask you?"` re-emitted **the same session `id`** and answered with full prior context. The session ID is stable across resumes, so `sessionCodec` can store it directly.

**An unknown session fails cleanly, and only on stderr.** Resuming a nonexistent id gives **exit 1, completely empty stdout, no JSON whatsoever**, and on stderr:

```
Error: Session "00000000-0000-7000-0000-000000000000" not found.
Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.
```

Two consequences. Detection must read **stderr**, not the event stream. And PR #2810's detector would have missed this outright: lowercased, the real text is `session "00000000-…" not found`, so its `includes("session not found")` never matches — the session id sits between the two words. The parser must also survive empty stdout without throwing.

### Dependency availability

`@paperclipai/adapter-utils@2026.817.0` is published on npm. Verified present in `dist/server-utils.d.ts`: `runChildProcess`, `ensureCommandResolvable`, `asString`, `asNumber`, `asBoolean`, `asStringArray`, `parseObject`, `parseJson`, `renderTemplate`, `joinPromptSections`, `buildPaperclipEnv`, `ensurePathInEnv`, `ensureAbsoluteDirectory`, `readPaperclipRuntimeSkillEntries`, `resolvePaperclipDesiredSkillNames`, `ensurePaperclipSkillSymlink`, `removeMaintainerOnlySkillSymlinks`, `selectPaperclipTaskMarkdown`, `renderPaperclipWakePrompt`, `redactEnvForLogs`. `inferOpenAiCompatibleBiller` is exported from the package root (defined in `dist/billing.d.ts`).

**Not yet verified**: `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`, which the skill names as the default prompt export. Confirm it exists in the published version before Step 7.

### Why PR #2810 is not the base

PR [paperclipai/paperclip#2810](https://github.com/paperclipai/paperclip/pull/2810) was **closed, not merged**. Against the real CLI:

- `--output-format jsonl` — no such flag. The real flag is `--mode=json`.
- Sends the task via `--append-system-prompt` instead of the positional `MESSAGES` argument, so the agent receives the task as system text with no user turn.
- Uses `--allow-home` as a cwd mechanism; that flag only suppresses the auto-switch out of `~`. The real flag is `--cwd`.
- `--provider X --model Y` splitting, when `--provider` is legacy and `--model` already accepts `provider/model`.
- Writes an empty `.jsonl` session file that omp never reads.
- `parse.ts` reads only the last stdout line and probes for `content`/`text`/`result`/`response` fields that appear in no omp event.
- Never passes `--auto-approve`, so an unattended run blocks on the first tool approval prompt.

And against the adapter contract in Part A:

- `testEnvironment` returns `{ok, error}` rather than the checks structure.
- Reads the prior session from `context.session` instead of `ctx.runtime`.
- Returns `unknownSession: true` instead of retrying fresh and setting `clearSession: true`.
- No cwd-aware resume guard.
- No `onMeta` call.
- Ships no `./ui` or `./cli` export at all.
- Calls `runChildProcess` with an options object rather than the positional signature.
- Imports `ensureCommandResolvable`, `joinPromptSections`, `buildInvocationEnvForLogs`, `resolveCommandForLogs` and never uses them; declares `firstNonEmptyLine`, `resolveOmpBiller`, `buildSessionPath` unused.

We reuse its `package.json` exports map and tsconfig, and nothing else.

---

## Architecture Decisions

**→ External adapter, not an in-tree fork.** PR #2810's in-tree route required edits to `AGENT_ADAPTER_TYPES` plus three registries, and it was rejected. Paperclip's plugin loader handles external adapters without touching the core repo.

**→ TypeScript strict + Vitest, not plain JS + `node:test`.** The prime reference adapter ships hand-written `.d.ts` over plain ESM. Our project guidelines mandate TypeScript strict mode and Vitest, and those win for our own repo. We compile to `dist/` and point the exports map there.

**→ One-shot `-p --mode json` per heartbeat for v1.** This maps exactly onto `execute()`: spawn, stream, exit, return. `omp --mode rpc` is a real alternative — it emits `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}` and speaks a framed stdin/stdout protocol, which is what resident attachable agents would need. Strictly more complexity for no v1 benefit. **Deferred to v2**, recorded so it is not re-litigated.

**→ Session resume is the default primitive.** Per the skill, not an optimisation to add later. Combined with omp's own context management across resumes, this gives us compaction for free.

**→ Parser is a pure function over the full event array.** No last-line heuristics. It consumes every line, ignores unknown `type` values forward-compatibly, and extracts from named events only.

**→ Fixtures are recorded from real runs, never hand-written.** The single lesson from PR #2810. Every parser fixture is a captured `--mode json` transcript under `test/fixtures/`, secrets scrubbed. A hand-authored fixture would let us re-invent a CLI that does not exist.

**→ ⚠ Skills via a `--config` overlay, NOT `--add-dir`.** The earlier draft assumed claude-local's tmpdir + "additional directory" pattern transferred to omp. It does not. Probing omp 17.3.8 directly: a skill placed in an `--add-dir` directory was **never discovered**, while the same skill reached through a `--config` overlay setting `skills.customDirectories` was found and used. The overlay is per-run, writes nothing to the agent's cwd, and writes nothing to omp's global config:

```yaml
skills:
  customDirectories:
    - "/tmp/paperclip-skills-xxxx/skills"
```

Also learned: omp already discovers Claude, Codex, Pi and Agents user and project skills by default (`skills.enableClaudeUser` and friends all default true), so a Paperclip host sees the operator's personal skills unless scoped. And `--config` applies to runs but not to the `config` subcommand, which makes a naive check look like a false negative.

**→ ✅ Resolved by the Paperclip team: two surfaces, two layers, both shipped.** The earlier draft treated the in-tree and prime-adapter UI contracts as competing. They are not.

- The **server module** (`.` export) carries `execute`, `testEnvironment`, and `getConfigSchema()`. `getConfigSchema()` drives the config form — the in-tree React `ConfigFields` component has **no external equivalent**, so the earlier Step 13 (`buildAdapterConfig`) was aimed at the wrong contract and is replaced.
- The **UI parser** (`./ui-parser` export) is a separate entry the host **fetches over HTTP and evals in the browser**. It uses the **same `TranscriptEntry` kinds as in-tree**, not the prime adapter's assistant/status/error — prime is on an older shape.

**→ Use the stateful parser factory.** The contract accepts either `parseStdoutLine(line, ts)` or `createStdoutParser() => { parseLine(line, ts), reset() }`, and **the stateful factory wins when both are present**. omp's stream is delta-based, and resolving a `text_delta` requires remembering which `contentIndex` was opened as text versus thinking, so state is required. `TranscriptEntry` carries `delta?: boolean` on `assistant` and `thinking`, so deltas pass straight through.

**→ The `./ui-parser` file must be zero-import and side-effect free.** Because it is eval'd in the browser it may carry **no runtime imports, no top-level side effects, no DOM or Node APIs**, must be deterministic, must fall back to a `stdout` entry rather than throwing, and should stay small. Type-only imports erase under `verbatimModuleSyntax`, but a build-output test asserting the emitted file contains no `import`/`require` is cheaper than discovering this in a browser.

**→ ⚠ No CLI surface for external adapters.** The in-tree convention has a `./cli` export (`formatStdoutEvent` for `paperclipai run --watch`), but the team's external export shape names only `.` and `./ui-parser`. The CLI formatter step is **removed pending confirmation** rather than built speculatively — `picocolors` has been dropped from dependencies accordingly. Restore it if the team confirms external adapters can contribute CLI formatters.

---

## Acceptance Criteria

- [ ] A Paperclip agent configured with `adapterType: "omp"` runs an omp session to completion and returns the assistant's final text in `summary`.
- [ ] A second heartbeat for the same agent resumes the prior omp session and the agent demonstrably retains prior context.
- [ ] A third heartbeat whose stored session no longer exists retries with a fresh session **within the same run** and returns `clearSession: true`, rather than failing.
- [ ] A stored session created under a different `cwd` is not resumed.
- [ ] The result reports `usage.inputTokens` / `usage.outputTokens` / `usage.cachedInputTokens` and `costUsd` matching the values omp emitted, under Paperclip's field names.
- [ ] The result reports the *resolved* `provider` and `model`, not the configured string.
- [ ] A run whose stream ends with a `notice` event still returns the correct `summary` (regression guard for PR #2810's bug).
- [ ] The run viewer shows assistant text streaming incrementally, with thinking distinguishable from output and tool calls visible.
- [ ] `paperclipai run --watch` prints readable coloured output for an omp run.
- [ ] `testEnvironment` returns `fail` with an actionable message when `omp` is absent, `pass` with the detected version when present, and `warn` — never `fail` — for non-blocking findings.
- [ ] A run exceeding `timeoutSec` terminates the child and reports `timedOut: true`.
- [ ] Paperclip runtime skills are discoverable by omp without any file being written into the agent's `cwd`.
- [ ] Configuring the adapter in the Paperclip UI surfaces labelled fields with hints for model, thinking, timeout, and cwd.

---

## Steps

Every step follows RED → GREEN → MUTATE → KILL MUTANTS → REFACTOR. No production code without a failing test first.

### PR 1 — Pure core: parser and argument builder

*No I/O, no child processes. The two functions PR #2810 got wrong.*

#### Step 1: Capture real omp event-stream fixtures

**Acceptance criteria**: `test/fixtures/` contains committed transcripts captured from real `omp -p --mode json` runs, scrubbed of keys and home paths: (a) a plain text answer, (b) a run ending in a trailing `notice`, (c) a resumed session, (d) a run that used at least one tool, (e) a resume against a bogus session ID. A `test/fixtures/README.md` records the omp version and exact command for each.
**RED**: N/A — produces test data. Prerequisite for Steps 2 and 3.
**GREEN**: Record, scrub, commit.
**MUTATE / REFACTOR**: N/A.
**Done when**: Fixtures committed, provenance documented, a grep for key-shaped strings finds nothing.
**✅ DONE.** Four files captured against `omp/17.3.8`: `01-plain-answer.jsonl` (13 events; (a) and (b) coincide — its last event is a `notice`), `02-resumed-session.jsonl` (66), `03-tool-use.jsonl` (123), and `04-unknown-session.{stdout,stderr}`. Secret scan clean. **Gap recorded in the fixtures README**: every run on this machine ends with an advisor `notice`, so no fixture has `agent_end` last — the parser must locate `agent_end` by type, never by position, and an advisor-free run should be added when one is available.

#### Step 2: Parse an omp event stream into a Paperclip result

**Acceptance criteria**: Given `01-plain-answer`, the parser returns the assistant's final text as `summary`, the session UUID from the `session` event, and usage mapped to Paperclip's names — `input`→`inputTokens`, `output`→`outputTokens`, `cacheRead`→`cachedInputTokens`, `cost.total`→`costUsd`. `cacheWrite` and `totalTokens` are preserved in `resultJson`. `provider` and `model` are the resolved values from the event. Its trailing `notice` does not prevent the correct `summary` — the explicit #2810 regression guard. Given `03-tool-use`, **usage is summed across both assistant messages** (inputTokens 470, outputTokens 103, costUsd 0.01523856) and `summary` comes from the **last** assistant message only, so the text-free `thinking`+`toolCall` message contributes nothing to it. `thinking` blocks never appear in `summary`. `agent_end` is located by type, never by line position. Empty stdout returns an empty result rather than throwing. Unknown event types are ignored.
**RED**: `parseOmpEvents(fixture)` returns the expected result for each fixture.
**GREEN**: Fold over all lines; skip unparseable lines; read `session.id`; find `agent_end` by type; sum usage over messages carrying it; take text from the last assistant message.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Expect survivors on the `thinking` filter and each usage field mapping — a swapped `input`/`output` mapping must fail a test. Pin summing explicitly: a mutant that reads only the last message's usage must be killed by the `03-tool-use` totals.
**REFACTOR**: If valuable.
**Done when**: All fixtures parse correctly, mutation report reviewed, commit approved.

#### Step 3: Detect a stale-session failure

**Acceptance criteria**: `isOmpUnknownSessionError(stderr)` returns true for `04-unknown-session.stderr` and false for every healthy fixture's stderr. It reads **stderr**, since an unknown session produces no stdout JSON at all. A test asserts it matches the real recorded text `Error: Session "<id>" not found.` and — as an explicit guard — that PR #2810's substring `session not found` does **not** occur in that text, so the naive detector is provably insufficient.
**RED**: True for the stale fixture, false for healthy ones.
**GREEN**: Match the real observed shape.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Add a near-miss (an unrelated error mentioning "session") that must not trip the detector.
**REFACTOR**: If valuable.
**Done when**: Both directions covered, commit approved.
**✅ Shape resolved by Step 1(e)** — omp does fail rather than silently starting fresh, so the Step 9 retry path is needed as planned.
**✅ DONE.** `isOmpUnknownSessionError` matches `/\bsessions?\b(?:[ \t]+"[^"]*")?[ \t]+not[ \t]+found\b/i` against stderr. All four of #2810's substrings are absent from the real text — a standing test proves it. Mutation testing replaced an earlier arbitrary `{0,80}` character gap with the explicit optional quoted id, killing three realistic false positives (`Session could not be written to disk`, `Session not writable`, `Session 01a03 found, resuming`).

**Decision: the plural matches on purpose.** If omp reports that sessions in general are not found, our stored one cannot be there either, so retrying fresh is correct. The costs are asymmetric — a missed detection kills the run with exit 1, while a false positive only discards context the agent can rebuild. Word boundaries are kept so an unrelated `subsession not found` does not match.

#### Step 4: Build the omp argument vector from adapter config

**Acceptance criteria**: `buildOmpArgs(config, session)` produces, for a default config, an argv containing `-p`, `--mode json`, `--auto-approve`, `--cwd <abs>`, `--session-dir <abs>`, and the prompt as the **positional trailing argument**. Given `model: "anthropic/claude-opus-5"` it emits `--model anthropic/claude-opus-5` as a single value and **never** emits `--provider`. Given a resumable session it emits `--resume <id>`. Given `thinking: "high"` it emits `--thinking high`. Given a skills tmpdir it emits `--add-dir <path>`. `extraArgs` append last. Omitted optional config produces no flag.
**RED**: Table-driven test over config permutations asserting the exact argv.
**GREEN**: Pure function, no I/O.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin that an empty-string `model` emits no flag (empty vs undefined).
**REFACTOR**: If valuable.
**Done when**: Commit approved.
**✅ DONE.** `buildOmpArgs` in `src/server/args.ts`. Mutation score 100% (21/21), no test changes needed after the first pass.

**⚠ A third #2810 bug, found by probing before implementation.** `--append-system-prompt` accepts three forms and they do not behave alike on `omp/17.3.8`:

| Form | Result |
|---|---|
| `@/path/to/file` | **Silently ignored** — the instruction is never applied, and nothing is reported |
| `/path/to/file` | Works — omp reads the file |
| direct text | Works |

PR #2810 passed `` `@${instructionsFilePath}` ``, so agent instructions would have vanished with no error. The `@` prefix is documented for the positional `MESSAGES` argument, not for this flag. A test pins the bare path and asserts the `@` form is never produced.

---

### PR 2 — Session codec and environment probe

#### Step 5: Round-trip a session through the codec

**Acceptance criteria**: `sessionCodec.serialize({sessionId, cwd})` → `deserialize` returns an equal value. `deserialize` rejects `null`, arrays, primitives, and blank `sessionId` by returning `null`. `getDisplayId` returns a short human-readable form. The stored params include `cwd`, because Step 6 needs it.
**RED**: Round-trip and rejection tests.
**GREEN**: Minimal codec.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin whitespace-only `sessionId` rejection.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

#### Step 6: Refuse to resume a session from a different cwd

**Acceptance criteria**: `canResumeSession({sessionId, sessionCwd}, cwd)` returns true when the stored cwd resolves equal to the current cwd, true when no stored cwd is recorded, and false otherwise. Path comparison uses `path.resolve` so `/a/b` and `/a/b/` and `/a/./b` are equal. An empty `sessionId` always returns false.
**RED**: Tests over matching, non-matching, absent, and non-normalised cwd pairs.
**GREEN**: Pure predicate.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin that the absent-cwd case returns **true**, not false — the permissive branch is easy to invert silently.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

#### Step 7: Report omp availability and version as categorised checks

**Acceptance criteria**: With `omp` on PATH, `testEnvironment` returns `{adapterType: "omp", status: "pass", checks: [...], testedAt}` including the detected version. With `omp` absent, `status: "fail"` and a check naming the install command. With `omp` present but the configured `cwd` missing, `status: "warn"`. Status is computed by the specified rule: `fail` if any `error`, else `warn` if any `warn`, else `pass`. Check `code` values are deterministic. The probe is lightweight and side-effect free.
**RED**: Tests with the command resolver injected, covering pass / fail / warn and the status-precedence rule.
**GREEN**: Implement against an injected resolver so no real process spawns in unit tests.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin that `warn` never collapses to `pass` and never escalates to `fail`.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

---

### PR 3 — Execution

#### Step 8: Build the prompt from Paperclip task context

**Acceptance criteria**: The default template is `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` from adapter-utils, not a local invention. Given `context.paperclipTaskMarkdown`, the prompt contains it verbatim. Given only the structured `paperclipIssue` fallback, the prompt contains identifier, title, and description. Agent identity (agent id, name, company id, run id) appears. A configured `promptTemplate` overrides the default and receives `{{agent.id}}`-style substitution via `renderTemplate` with the standard variable set (`agentId`, `companyId`, `runId`, `company`, `agent`, `run`, `context`). No skill content is inlined.
**RED**: Tests over context permutations.
**GREEN**: Prefer `selectPaperclipTaskMarkdown` / `renderPaperclipWakePrompt` over reimplementing.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin markdown-over-fallback precedence.
**REFACTOR**: If valuable.
**Done when**: Commit approved.
**✅ DONE.** `src/server/prompt.ts`, mutation score 100% (29/29).

**⚠ `selectPaperclipTaskMarkdown` has no fallback.** It returns `""` for a structured `paperclipIssue` — it reads only `paperclipTaskMarkdown`. The plan had assumed it handled the precedence; leaning on it would have sent an agent woken with only a structured issue **no task at all**. The fallback and the precedence are built explicitly here.

#### Step 9: Execute an omp run and return an `AdapterExecutionResult`

**Acceptance criteria**: `execute(ctx)` reads the prior session from `ctx.runtime`, gates resume through Step 6's predicate, calls `onMeta` with `redactEnvForLogs`-masked env **before** spawning, spawns via `runChildProcess(runId, cmd, args, opts)` **with the child's stdin closed or ignored** — an open stdin pipe makes omp wait for EOF and hang until timeout — streams both stdout and stderr to `onLog`, and returns a full `AdapterExecutionResult` — `exitCode`, `signal`, `timedOut`, `summary`, `usage`, `costUsd`, `provider`, `model`, `sessionParams`, `sessionDisplayId`. On a resumed run that exits non-zero with a stale-session error, it reruns once with a fresh session **inside the same call** and returns `clearSession: true`. A non-zero exit populates `errorMessage` rather than throwing. A parse failure puts raw stdout and stderr in `resultJson`. Exceeding `timeoutSec` terminates the child and returns `timedOut: true`. `instructionsFilePath` is passed via `--append-system-prompt`, separate from the task prompt.
**RED**: Tests with an injected fake process runner replaying fixtures; assert the result shape, that `onLog` received the stream, that `onMeta` fired before spawn, and that the stale-session path reruns exactly once.
**GREEN**: Wire parser, arg builder, prompt builder, and resume guard together. Inject the runner so unit tests spawn nothing.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin resolved-vs-configured model, the non-zero-exit path, and that the retry happens **once** — an infinite retry loop must fail a test.
**REFACTOR**: If valuable.
**Done when**: Commit approved.
**✅ DONE.** `src/server/execute.ts`, mutation score 100% (44/44).

**The stdin hang is narrower than first recorded.** `runChildProcess` sets `stdio: [opts.stdin != null ? "pipe" : "ignore", ...]`, so it already ignores stdin unless a value is passed. The rule is simply never to pass one, and a test asserts the runner is called without a `stdin` key.

Three of the four retry guards had no test distinguishing them until mutation testing: a resumed run that timed out, and a resumed run that succeeded with stale-session text on stderr, would both have been retried.

#### Step 10: Make Paperclip skills discoverable without touching the agent's cwd

**Acceptance criteria**: Before spawning, the adapter creates a tmpdir via `mkdtemp("paperclip-skills-")`, symlinks the selected Paperclip runtime skills into it, and passes it to omp via `--add-dir`. The tmpdir is removed in a `finally` block even when the run throws or times out. **No file is created inside the agent's `cwd`** — asserted directly by a test. Skills not selected for the agent are not linked. Injection failure logs a warning and the run proceeds.
**RED**: Tests over selection, cleanup-on-throw, the cwd-untouched assertion, and failure tolerance.
**GREEN**: Use `readPaperclipRuntimeSkillEntries` / `resolvePaperclipDesiredSkillNames` / `ensurePaperclipSkillSymlink` against the tmpdir.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin that cleanup runs on the throwing path, not just the happy path.
**REFACTOR**: If valuable.
**Done when**: Commit approved.
**✅ DONE.** Implemented against the probed mechanism, not the assumed one: `--add-dir` does not expose skills, a `--config` overlay does. `src/server/skills.ts`, mutation score 100% (20/20).

**Selection uses `config.paperclipSkillSync.desiredSkills`**, not `config.skills`. `resolvePaperclipDesiredSkillNames` returns `[]` both for "none selected" and "not specified"; `readPaperclipSkillSyncPreference(config).explicit` is what separates them, so an agent with no stated preference correctly receives every skill rather than none.

All five mutation survivors here shared one cause: test skills with `key === runtimeName`, and a temp root that was a string prefix of the skills directory. Identical values hid every mix-up between them.

---

### PR 4 — UI parser and config schema

*Unblocked: contract confirmed by the Paperclip team and the [Adapter UI Parser](https://docs.paperclip.ing/reference/adapters/adapter-ui-parser/) reference.*

#### Step 11: Map omp's event stream to `TranscriptEntry[]`

**Acceptance criteria**: `createStdoutParser()` returns `{parseLine(line, ts), reset()}`. Against the fixtures it emits: `text_delta` → `{kind:"assistant", delta:true}`; thinking deltas → `{kind:"thinking", delta:true}`; `tool_execution_start` → `{kind:"tool_call", name, input, toolUseId}` from `toolName`/`args`/`toolCallId`; `tool_execution_end` → `{kind:"tool_result", toolUseId, content, isError}` with `toolUseId` **matching** the call so the UI can pair them; the `session` event → `{kind:"system"}`; `notice` → `system` or `stderr` by `level`. An unparseable line returns a single `{kind:"stdout"}` entry and never throws. `reset()` clears accumulated state so a reused parser does not leak the previous run's `contentIndex` map. Parsing is deterministic.
**RED**: Feed fixture lines through the factory, assert emitted entries and call/result pairing.
**GREEN**: Stateful line-to-entry mapping. State is needed only to remember which `contentIndex` was opened as text versus thinking.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin the `notice.level` branch, the `isError` flag, and that `reset()` actually clears — a no-op `reset()` must fail a test.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

#### Step 12: Guarantee the built parser is browser-safe

**Acceptance criteria**: A test reads the **built** `dist/ui-parser.js` and asserts it contains no `import`, no `require`, no `node:` specifier, and no DOM global. A second test imports it and asserts loading it produces no observable side effect. This exists because the host fetches this file over HTTP and evals it in the browser — a stray import is invisible in unit tests and fatal at runtime.
**RED**: The assertions, run against build output.
**GREEN**: Keep `src/ui-parser.ts` self-contained; declare its types locally rather than importing them.
**MUTATE**: N/A — this is itself a guard.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

#### Step 13: Report the config schema for the agent form

**Acceptance criteria**: `getConfigSchema()` returns labelled fields with hints for `model`, `thinking`, `cwd`, `sessionDir`, `timeoutSec`, `graceSec`, `extraArgs`, and `env`. Every key it names is a key `execute()` actually reads — a test asserts that correspondence in both directions, so the form can never advertise a field the runtime ignores.
**RED**: Schema-shape tests plus the bidirectional key-correspondence test.
**GREEN**: Declarative schema, no React.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin that removing a field from the schema fails the correspondence test.
**REFACTOR**: If valuable.
**Done when**: Commit approved.

---

### PR 5 — Metadata and packaging

#### Step 14: Expose adapter metadata and the server factory

**Acceptance criteria**: The `.` export (`dist/server/index.js`) exports `type` (`"omp"`), `label`, `models`, `agentConfigurationDoc`, and `createServerAdapter()`. The factory returns `{type, execute, testEnvironment, sessionCodec, getConfigSchema, models, agentConfigurationDoc, supportsLocalAgentJwt}`. `agentConfigurationDoc` is written as routing logic with explicit "Use when" / "Don't use when" sections, documents every config field, and names only flags verified to exist — `omp models`, never `--list-models`. It documents the closed-stdin requirement, since anyone hand-rolling an omp invocation will hit that hang.
**RED**: A public-contract test asserting every documented export exists with the right shape.
**GREEN**: Implement.
**MUTATE**: Run `mutation-testing` skill.
**KILL MUTANTS**: Pin the `type` string.
**REFACTOR**: If valuable.
**Done when**: Commit approved.
**✅ DONE.** `src/server/index.ts` holds metadata, `agentConfigurationDoc` and the factory; `src/server/runtime.ts` holds the real filesystem and child-process bindings every other module takes injected.

`runtime.ts` is tested against real directories and a real binary, with `node` standing in for `omp`. Mutation score 94% (16/17); the survivor drops empty `PATH` entries, which no test can distinguish without placing an executable in the test process's own directory — documented in the source as hardening rather than tested behaviour.

A wiring test runs `createServerAdapter().execute()` against `node` as the command, which exercises the process runner, the directory creation and the skills staging together without needing omp installed.

#### Step 15: Package for the Paperclip plugin loader

**Acceptance criteria**: `package.json` is named `paperclip-omp-adapter` and declares exactly the external shape — `.` → `./dist/server/index.js` and `./ui-parser` → `./dist/ui-parser.js` — plus `paperclip.adapterUiParser: "1.0.0"`, `type: "module"`, and `engines.node >= 20`. `npm run build` emits `dist/` with `.d.ts`; `npm pack --dry-run` includes it. A fresh install of the packed tarball resolves both entry points. No dependency is declared that no source file imports. The README opens with a line stating this is a community package, not an official `@paperclipai/*` adapter.
**RED**: A test importing each declared export path from the built output, failing if any is unresolvable.
**GREEN**: Configure `package.json` and `tsconfig.json`.
**MUTATE / REFACTOR**: N/A — packaging config.
**Done when**: Commit approved.
**✅ DONE.** `test/package-is-installable.test.ts` builds, then checks the manifest as the loader reads it: the two export entries resolve to files the build emits, `npm pack --dry-run` ships `dist/` and no `src/` or `test/`, every declared dependency is actually imported by the source, and the README states plainly that this is a community package.

---

### PR 6 — End-to-end verification

#### Step 16: Verify a real multi-heartbeat run against live omp

**Acceptance criteria**: An integration test gated behind `OMP_ADAPTER_LIVE=1`, skipped by default with a clear message, that: runs a real omp session through `execute()`; resumes it and asserts retained context; then resumes with a deliberately bogus session id and asserts the fresh-retry path returns `clearSession: true`.
**RED**: The live test, initially failing.
**GREEN**: Fix whatever the real binary surfaces that the fakes did not.
**MUTATE**: N/A — integration test.
**REFACTOR**: If valuable.
**Done when**: Live test passes locally, is skipped by default, commit approved.

---

## Open Questions

**→ ⚠ Can an external adapter contribute a CLI formatter?** The in-tree convention has a `./cli` export feeding `paperclipai run --watch`, but the team's external export shape names only `.` and `./ui-parser`. The formatter step is removed and `picocolors` dropped rather than building against an entry point the loader may never call. **Ask the team.** Cheap to restore — the event mapping is shared with Step 11.

**→ Does omp discover skills in an `--add-dir` directory, and in what layout?** The whole of Step 10 rests on this. Claude Code expects `.claude/skills/`; omp's equivalent is unprobed. **Check before Step 10.**

**→ ✅ Closed: authentication needs no adapter change either way.** omp reads provider keys from env, and also ships `omp auth-broker` — a credential vault served over HTTP that a run reaches through exactly two variables, `OMP_AUTH_BROKER_URL` and a bearer token (`auth.broker.url` / `auth.broker.token`). Both routes travel through the same `config.env` mechanism already built and tested, so this was never a fork in the road.

Default stays `config.env`: it matches the skill's "secrets through environment, never prompts" rule and needs no extra process.

**The broker is the only route to subscription-plan auth**, which `config.env` cannot express — there is no API key to paste for a Claude Pro or ChatGPT Plus plan. `omp auth-broker list` shows OAuth support for anthropic, openai-codex, zai, github-copilot, cursor, google-gemini-cli, xai, gitlab-duo, and about ten more. It also centralises rotation, so agents hold a broker bearer rather than a provider key each.

Its cost is a long-running `omp auth-broker serve` process to supervise alongside Paperclip. `agentConfigurationDoc` (Step 14) must document both routes and say plainly that subscription plans require the broker.

**→ Should `--profile` isolate each Paperclip agent?** `omp --profile <name>` gives isolated auth, sessions, settings, and caches — a stronger per-agent boundary than `--session-dir` alone. Evaluate during PR 2; not assumed in the current steps.

**→ Flag stability across omp versions.** Everything is pinned to `v17.3.8`. `testEnvironment` records the detected version; decide whether to warn on untested majors.

**→ The advisor emits noise.** Probe runs ended with `Advisor unavailable for google/gemini-1.5-pro: API key not valid`. `--advisor` is opt-in yet the advisor ran anyway, suggesting a config default on this machine. Confirm whether adapter runs should explicitly disable it.

---

## Pre-PR Quality Gate

Before each PR:

1. Mutation testing — run the `mutation-testing` skill; report reviewed.
2. Refactoring assessment — run the `refactoring` skill.
3. Typecheck and lint pass.
4. No `any` types, no unjustified type assertions.
5. No unused imports or dead helpers — the specific rot that made PR #2810 unreviewable.
6. No secrets in prompts, config defaults, or committed fixtures.

---

*Delete this file when the plan is complete. If `plans/` is empty, delete the directory.*
