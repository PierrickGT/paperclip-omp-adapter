# paperclip-omp-adapter

> **Community package.** Not affiliated with Paperclip. Official adapters are published under
> `@paperclipai/*`; this is not one of them.

An external [Paperclip](https://docs.paperclip.ing) adapter that runs [omp](https://omp.sh) as the
agent runtime, with session resume across heartbeats and accurate usage and cost reporting.

## Status

Alpha. Every module is built and tested, but the adapter has not yet been run inside a live
Paperclip instance. Paperclip's own external-adapter runtime is also flagged alpha.

Verified against **omp 17.3.8**.

## Install

Install from the Paperclip Board UI, under Settings → Adapters, or:

```
POST /api/adapters/install   { "package": "paperclip-omp-adapter" }
```

Then create an agent with adapter type `omp`. Use **Test environment** in the agent form to check
that omp is installed and reachable before the first run.

## Configuration

| Setting | Purpose |
|---|---|
| `command` | omp executable. Defaults to `omp` on the server's PATH. |
| `cwd` | Absolute working directory. Ignored when Paperclip assigns a workspace. Created if missing. |
| `model` | Passed whole, so `anthropic/claude-opus-5` and `opus` both work. `omp models` lists them. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. |
| `sessionDir` | Where omp keeps this agent's sessions. Defaults per-agent. |
| `instructionsFilePath` | Markdown file appended to omp's system prompt. |
| `promptTemplate` | Replaces Paperclip's default agent prompt. |
| `timeoutSec` / `graceSec` | Run limit and SIGTERM grace. Default 900 and 15. |
| `extraArgs` | Passed to omp verbatim. |
| `env` | Environment for the run. Credentials belong here. |

### Credentials

Provider keys such as `ANTHROPIC_API_KEY` go in `env` and reach the agent through the process
environment, never through the prompt.

Subscription plans have no API key to paste. For those, run `omp auth-broker serve` and set
`OMP_AUTH_BROKER_URL` and its bearer token in `env` instead.

## Behaviour worth knowing

**Sessions resume automatically.** An agent woken repeatedly for one issue continues its previous
omp session, so it keeps what it has already read and decided. A session recorded in a different
working directory is not resumed, so one project's context cannot leak into another. If omp has
dropped the session, the run retries once from scratch and tells Paperclip to forget the stale id.

**Skills are staged per run.** Paperclip's skills are linked into a temporary directory and exposed
to omp through a `--config` overlay setting `skills.customDirectories`. Nothing is written into the
agent's working directory, and the staging directory is removed when the run ends.

**Nothing is inlined into the prompt.** omp reads each skill's name and description and loads the
body only when it decides to use one.

## Gotchas found by probing omp

Each of these was established by running omp 17.3.8, not read from documentation. All three are
mistakes [PR #2810](https://github.com/paperclipai/paperclip/pull/2810) made.

**Never give omp a piped stdin.** It waits for EOF and the run never starts — it prints
`Still starting after Ns — phase: readPipedInput` until killed. This adapter never passes one, but
anything else invoking omp must take the same care.

**`--append-system-prompt @path` is silently ignored.** The `@` prefix belongs to the positional
`MESSAGES` argument. Pass the path alone.

**`--add-dir` does not load skills.** A skill placed in an added directory is never discovered. The
`--config` overlay above is what works.

## Development

```
pnpm install
pnpm test            # 309 tests
pnpm test:coverage   # 100% required on all four metrics
pnpm typecheck
pnpm build
```

The decision-making modules take their filesystem and process work as injected dependencies, so unit
tests spawn nothing. `src/server/runtime.ts` holds the real bindings and is tested against real
directories and a real binary.

Test fixtures under `test/fixtures/` are recorded from real omp runs and must never be hand-written.
See `test/fixtures/README.md` for why.

## Licence

MIT
