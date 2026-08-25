# Event-stream fixtures

Every file here was **captured from a real `omp` run**, never hand-written. This is deliberate:
PR [paperclipai/paperclip#2810](https://github.com/paperclipai/paperclip/pull/2810) failed precisely
because its parser was written against an imagined output format. A hand-authored fixture would let
us re-invent a CLI that does not exist.

If you need a new fixture, **record one**. Do not edit these by hand beyond scrubbing.

## Provenance

- **omp version**: `omp/17.3.8`
- **Captured**: 2026-08-23
- **Model actually used**: `zai/glm-5.3` (the machine default; the adapter never assumes a model)
- **Common flags**: `--session-dir <tmp> -p --mode json --no-lsp` with **stdin closed** (`</dev/null`)

| File | Command | Result |
|---|---|---|
| `01-plain-answer.jsonl` | `omp … "Reply with exactly: OK"` | exit 0, 13 events. Last event is a `notice`, **not** `agent_end` — this is the regression guard for #2810's last-line parsing bug. |
| `02-resumed-session.jsonl` | `omp … -r <sid> "What exactly did I ask you to reply?"` | exit 0, 66 events. Re-emits the **same** session `id` and answers with prior context. |
| `03-tool-use.jsonl` | `omp … --auto-approve "Use your file listing tool …"` | exit 0, 123 events. Two assistant turns, one `read` tool call against a dir containing `alpha.txt` / `beta.txt`. |
| `04-unknown-session.stdout` / `.stderr` | `omp … -r 00000000-0000-7000-0000-000000000000 "…"` | **exit 1, stdout completely empty**, error on stderr. |

## Scrubbing

Applied to every file, verified to leave all `.jsonl` lines valid JSON:

- capture workspace absolute path → `/workspace`
- `/Users/<user>` → `/home/user`
- `/tmp/claude-501` → `/tmp/scrubbed`
- the slugified project path → `-workspace`
- username → `user`

A scan for `sk-…` keys, `api_key: "…"` assignments, the username, and `/Users/` paths reports clean.

## Facts these fixtures pin down

Findings from capture that the parser must honour. Each is load-bearing.

**1. Usage is per-message and must be SUMMED across the run.** `agent_end.messages[]` carries a
separate `usage` object on *each assistant message*. In `03-tool-use` there are two:

| | input | output | cacheRead | cost.total |
|---|---|---|---|---|
| `messages[1]` | 70 | 74 | 27200 | 0.0074956 |
| `messages[3]` | 400 | 29 | 27136 | 0.00774296 |
| **run total** | **470** | **103** | **54336** | **0.01523856** |

Reading only the last message under-reports by roughly half. Messages with role `user` or
`toolResult` carry no `usage` at all.

**2. `summary` comes from the LAST assistant message's `text` blocks only.** In `03-tool-use`,
`messages[1]` is `thinking` + `toolCall` with no text at all; the answer lives in `messages[3]`.
Concatenating all assistant text would prepend tool-call noise.

**3. `agent_end.messages[]` holds only the current run's messages, not session history.** The
resumed fixture contains just `user, assistant` despite having prior context. Summing usage over it
therefore yields per-run usage, which is what Paperclip wants.

**4. Roles are `user`, `assistant`, `toolResult`.** Content block types are `text`, `thinking`,
`toolCall` — camelCase, not snake_case.

**5. An unknown session produces NO JSON at all.** Exit 1, empty stdout, and on stderr:

```
Error: Session "00000000-0000-7000-0000-000000000000" not found.
Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.
```

Detection must read **stderr**, not stdout. Note that #2810's substring list would have missed
this: lowercased, the real text is `session "00000000-…" not found`, so a naive
`includes("session not found")` never matches — the session id sits between the two words.

The parser must also survive completely empty stdout without throwing.

**6. Tool events carry everything the run viewer needs.**

```json
{"type":"tool_execution_start","toolCallId":"call_…","toolName":"read","args":{"path":"."},"intent":"Listing current directory"}
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"read","result":{"content":[…]},"isError":false}
```

## ⚠ Not covered by these fixtures

- **A run whose last event is `agent_end`.** Every capture on this machine ends with an advisor
  `notice` (`Advisor unavailable for google/gemini-1.5-pro: API key not valid`), which appears to be
  a local config default. The parser must find `agent_end` by type regardless of position, so record
  an advisor-free run when one is available and add it rather than assuming position.
- **A failing run that still emits JSON** (mid-run model error, tool crash). Unknown shape.
- **`isError: true` on a tool result.** All captured tool calls succeeded.
