# paperclip-omp-adapter

> **Community package.** Not affiliated with Paperclip. Official adapters are published under
> `@paperclipai/*`; this is not one of them.

An external [Paperclip](https://docs.paperclip.ing) adapter that runs [omp](https://omp.sh) as the
agent runtime, with session resume across heartbeats and accurate usage and cost reporting.

## Status

**Work in progress — not yet usable.** No adapter code exists yet. What is here:

- Real `omp` event-stream fixtures captured from `omp/17.3.8` (`test/fixtures/`)
- The implementation plan (`plans/omp-adapter.md`)
- Package scaffolding

See the plan for the step-by-step build and the open questions still outstanding.

## Why not PR #2810

[paperclipai/paperclip#2810](https://github.com/paperclipai/paperclip/pull/2810) attempted an
in-tree `omp_local` adapter and was closed unmerged. Its execution path targets flags omp does not
have (`--output-format jsonl`, `--provider`/`--model` splitting, `--allow-home` as a cwd mechanism)
and parses an output format omp does not emit. This package is written against the real binary
instead: every fact in the plan was verified by running it, and every test fixture is a recorded
transcript rather than a hand-written one.

## Gotcha worth knowing regardless

If you spawn `omp` as a child process **with an open stdin pipe, it never starts** — it waits for
EOF, printing `Still starting after Ns — phase: readPipedInput` until killed. Close or ignore the
child's stdin. This is the most likely cause of an omp integration that appears to hang doing
nothing.

## Licence

MIT
