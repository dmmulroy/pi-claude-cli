# pi-claude-cli

Private fork of `agustinsacco/pi-claude-cli` (remote `upstream`). A pi provider that uses the official Claude Code CLI for subscription authentication and model access. No build step: pi loads `index.ts` and its TypeScript imports.

This fork has **one** execution path: pi owns the prompt, tools, conversation and compaction. Upstream's legacy "observer" path (native Claude tools, `--resume`, tool markers, sub-agent tracking, `PI_CLAUDE_CLI_CONTEXT`) is deleted here, and the provider is rewritten on Effect 4, so upstream changes do not merge cleanly and usually should not be merged at all.

Read [README.md](README.md), [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md) and [docs/coding-standards.md](docs/coding-standards.md) before changing behavior. [effect-rewrite.md](effect-rewrite.md) is the design record: why each Effect primitive was chosen, what was tested, and where the plan was wrong.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage     # unit tests of the pure modules
npm run test:scenarios    # the gate for the Effect services: stub scenarios + trace assertions
npm run test:e2e          # real pi, stub CLI
node scripts/scenarios.ts --live   # spends subscription tokens
PI_OWNED_LIVE=1 npx vitest run tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts   # spends more
```

Coverage floors: 92% lines/functions/statements, 85% branches, over the pure modules listed in `vitest.config.ts`. The services have no unit tests; `test:scenarios` is their gate.

## Traces are the feedback loop

Every service operation is a span, and the provider writes spans as NDJSON by default (`~/.local/state/pi-claude-cli/traces/<date>.ndjson`; `PI_CLAUDE_CLI_TRACE=<path>` redirects, `=off` disables). Debug and verify by running something and reading its trace, in preference to adding tests.

```bash
npm run trace -- tree --last                  # the most recent trace of any pi session
npm run trace -- run -- <command>             # run with a fresh trace file, print the tree
npm run trace -- tree --run                   # the last `run` again
npm run trace -- assert --run --name episode --attr mode=turn --count 1
npm run trace -- open --run                   # spans that never ended: a leak
node scripts/scenarios.ts --keep warm-turn    # one scenario; keeps its trace file
```

`scripts/scenarios.ts` holds every scenario as data: what to run, its environment, and its `trace assert` arguments. A behavior change means changing or adding a scenario there; extend the stub (`tests/e2e/claude-stub.cjs`) or the trace CLI when one cannot express what you need. `PI_CLAUDE_CLI_TRACE_WIRE=1` adds one event per wire message; `=raw` records raw stdout lines, content included, for protocol debugging only.

## Architecture

- `index.ts`: register with both pi's provider composer and pi-ai's compatibility registry. No Effect import: the runtime is loaded on the first model call and disposed on `session_shutdown`. Other lifecycle events retire parked processes.
- `src/provider-runtime.ts`: the `ManagedRuntime`, one per extension instance, and the boundary with pi. An episode is one fiber; pi's abort signal interrupts it; its single exit becomes exactly one of `done`, `error`, `aborted`.
- `src/episode.ts`: one pi model call. Take or launch a process, stream, hand tool calls to pi, park or retire.
- `src/episode-mode.ts`: pure decision between `spawn`, `turn` and `handoff`, and the launch signature.
- `src/claude-process-pool.ts`: launches processes and parks one per pi session. Its scope is the parent of every process scope.
- `src/claude-process.ts`: one CLI process and everything it owns, in one scope. The stdout reader answers permission and MCP requests whether or not an episode is attached. `retire` closes the scope.
- `src/claude-cli.ts`: launch flags and environment, over Effect's Node `ChildProcessSpawner`. Replaces Claude Code's prompt, disables native tools and session persistence, preserves explicit host guards and OAuth. Never use `--bare`.
- `src/mcp-inband.ts`: the in-band (`"type": "sdk"`) MCP server that advertises pi's tools on the CLI's own control channel. No socket, no helper process, no secret. A `tools/call` is held open until pi's next call delivers the result, matched on the actual tool-use id and name.
- `src/cli-protocol.ts`: lenient `Schema` decoding of the CLI's NDJSON; builders for stdin lines.
- `src/event-bridge.ts`: convert CLI stream events to pi messages. Content indexes restart each model cycle, so blocks are tracked by `(cycle, index)`.
- `src/pi-context.ts`: normalize old/new pi context formats, import ordered messages and images, hash acknowledged history.
- `src/thinking-config.ts`: pi thinking levels as CLI flags and live control requests.
- `src/provider-config.ts`, `src/runtime-directory.ts`, `src/usage.ts`, `src/errors.ts`, `src/cli-requirements.ts`: configuration, the private temp directory, billing arithmetic, tagged errors, minimum CLI version.
- `src/tracing.ts`, `src/trace-location.ts`, `scripts/trace.ts`: the span sink and the trace CLI.

## Invariants

1. pi owns the prompt, active tools, complete tool results and compaction. A Claude process is a disposable cache of pi's history, never a second conversation ledger.
2. A warm process may continue only when its acknowledged pi-history prefix and launch signature match. Anything else retires it and imports pi's current history into a fresh process.
3. Tool calls reach pi as real toolCall blocks; the CLI waits for the matching pi result. The CLI has no native tools.
4. Nothing is written to pi's status line or to conversation content except the model's own output. Effect's console logger is replaced: logs are span events.
5. CLI sessions do not persist. No transcript, no resume. Trace files are not a transcript: they hold ids, names, sizes, counts and durations, never prompt text, tool arguments or tool results (unless `PI_CLAUDE_CLI_TRACE_WIRE=raw` is set on purpose).
6. Preserve host/managed guards and official subscription authentication. Never extract OAuth tokens. Never forward `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` to the CLI.
7. Report errors as assistant error events and aborts as aborted. Never return a raw string where pi expects an assistant message. Only `src/provider-runtime.ts` and `index.ts` end a pi stream.

## Conventions

- Effect everywhere, including scripts, following `docs/coding-standards.md`. The exceptions are `index.ts` and what it imports eagerly (`event-bridge`, `overflow`, `thinking-config`, `terminal-event`), which must not import Effect, and the stub CLI.
- Layers never fail. A failed layer build is remembered for the life of the runtime; record the failure in the service and report it per episode instead.
- Never await a `retire` on a path that ends pi's stream; use `pool.retireInBackground`.
- The package is an ES module and local TypeScript is imported with `.ts` specifiers, so `node scripts/x.ts` runs under Node's type stripping (Node 22.18+). That rules out enums, namespaces and parameter properties.
- Import `@effect/platform-node-shared` by narrow entrypoint, never its barrel.
- No `any` outside `tests/`; lint enforces it. Decode unknown input with `Schema` at the boundary and use pi's own types (`Message`, `Tool`, `Model<Api>`) inside.
- Windows is not supported; do not add code for it.
- Tests live in `tests/`; `tests/live-*.test.ts` are opt-in and spend tokens.
- `scripts/spikes/inband-mcp.ts` probes the real CLI's in-band MCP protocol. Rerun its `probe` mode (no tokens) when a new Claude Code version misbehaves.

## Installing a change

pi installs this package from git (`git:github.com/dmmulroy/pi-claude-cli` in `home/.pi/agent/settings.json` of the dotfiles repo). A change is live only after it is pushed and pi has updated the package. To exercise the working tree, use `pi -ne -e <repo>` as `scripts/e2e-stub.sh` does.
