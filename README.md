# paperclip-omp-adapter

> **Community package.** Not affiliated with Paperclip. Official adapters are published under
> `@paperclipai/*`; this is not one of them.

An external [Paperclip](https://docs.paperclip.ing) adapter that runs [omp](https://omp.sh) as the
agent runtime, with session resume across heartbeats and accurate usage and cost reporting.

## Status

Alpha. Every module is built and tested. The adapter installs, loads, and passes its environment
test inside a live Paperclip instance (2026.817.0), but no agent run has executed through it yet.
Paperclip's own external-adapter runtime is also flagged alpha.

Verified against **omp 17.3.8** and **17.4.0**; the environment test accepts any 17.x.

## Install

This package is not published to npm, so install it from a local checkout:

```
git clone https://github.com/PierrickGT/paperclip-omp-adapter
cd paperclip-omp-adapter && pnpm install && pnpm build

paperclipai adapter install --payload-json \
  '{"packageName":"/absolute/path/to/paperclip-omp-adapter","isLocalPath":true}'
```

The install route's field is `packageName`, not `package`, and `isLocalPath` is what makes it read
your checkout instead of the npm registry. The Paperclip Board UI's Settings → Adapters form does
the same thing.

Then create an agent with adapter type `omp`. Use **Test environment** in the agent form to check
that omp is installed and reachable before the first run, or from the CLI:

```
paperclipai adapter test-environment omp -C <companyId> \
  --payload-json '{"adapterConfig":{"command":"/absolute/path/to/omp"}}'
```

The config goes under `adapterConfig`, and `-C` is required.

### omp must be reachable from the *server's* PATH

Paperclip resolves `command` against the environment of the long-running server process, which is
usually not the PATH of the shell you installed omp from. If omp is a JS entrypoint with a
`#!/usr/bin/env bun` (or node) shebang, that interpreter has to be reachable too, or every
invocation exits 127 — which surfaces only as `Could not read the omp version`, because the
`omp_command` check passes on a bare stat.

Check what the server actually has:

```
tr '\0' '\n' < /proc/$(pgrep -f 'paperclipai.*run')/environ | grep ^PATH=
```

The reliable fix is a wrapper on an absolute path, with `command` pointed at it:

```sh
#!/bin/sh
PATH="$HOME/.bun/bin:$PATH"; export PATH
exec "$HOME/.local/share/pnpm/omp" "$@"
```

## Configuration

| Setting | Purpose |
|---|---|
| `command` | omp executable. Defaults to `omp` on the server's PATH — usually set this to an absolute path, see above. |
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

### `@paperclipai/adapter-utils` must not be duplicated

`adapter-utils` keeps `runningProcesses` in a module-scope Map, and Paperclip's heartbeat reads that
Map to cancel and reap runs. An adapter that loads a *second* copy registers its child processes
somewhere the server never looks: runs start, then cannot be stopped and stale-run detection misses
them. Nothing throws, so this is worth preventing rather than debugging.

It is therefore a **peer** dependency. It is also a devDependency, because the build and tests need
it — and that installed copy is what Node would otherwise resolve. `scripts/link-adapter-utils.mjs`
runs on `postinstall` and repoints `node_modules/@paperclipai/adapter-utils` at whatever copy the
host Paperclip CLI is running. It no-ops when no Paperclip install is found, so CI and fresh clones
are unaffected. Override the search root with `PAPERCLIP_HOME`.

Verify with:

```
realpath node_modules/@paperclipai/adapter-utils/dist/server-utils.js
```

Test fixtures under `test/fixtures/` are recorded from real omp runs and must never be hand-written.
See `test/fixtures/README.md` for why.

## Licence

MIT
