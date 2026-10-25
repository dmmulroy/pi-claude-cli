# pi-claude-cli

Fork of `agustinsacco/pi-claude-cli` (remote `upstream`). A pi provider that uses the official Claude Code CLI for subscription authentication and model access. No build step: pi loads `index.ts` and its TypeScript imports.

This fork has **one** execution path: pi owns the prompt, tools, conversation and compaction. Upstream's legacy "observer" path (native Claude tools, `--resume`, tool markers, sub-agent tracking, `PI_CLAUDE_CLI_CONTEXT`) is deleted here, and the provider is rewritten on Effect 4, so upstream changes do not merge cleanly and usually should not be merged at all.

Read [README.md](README.md), [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md) and [docs/coding-standards.md](docs/coding-standards.md) before changing behavior. [effect-rewrite.md](effect-rewrite.md) is the design record: why each Effect primitive was chosen, what was tested, and where the plan was wrong.

## Commands

```bash
vp install                # pnpm, through Vite+
vp check                  # oxfmt + oxlint (type-aware) + type check
vp check --fix            # format and apply lint fixes
vp test                   # unit tests
vp run test:coverage      # unit tests of the pure modules, with coverage floors
vp run test:scenarios     # the gate for the Effect services: stub scenarios + trace assertions
vp run test:e2e           # real pi, stub CLI
vp run ready              # all of the above
node scripts/scenarios.ts --live   # spends subscription tokens
PI_OWNED_LIVE=1 vp test tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts tests/live-structured-import.test.ts   # spends more
```

Coverage floors: 92% lines/functions/statements, 85% branches, over the pure modules listed under `test.coverage` in `vite.config.ts`. The services have no unit tests; `test:scenarios` is their gate.

## Traces are the feedback loop

Every service operation is a span, and the provider writes spans as NDJSON by default (`~/.local/state/pi-claude-cli/traces/<date>.ndjson`; `PI_CLAUDE_CLI_TRACE=<path>` redirects, `=off` disables). Debug and verify by running something and reading its trace, in preference to adding tests.

```bash
vp run trace -- tree --last                  # the most recent trace of any pi session
vp run trace -- run -- <command>             # run with a fresh trace file, print the tree
vp run trace -- tree --run                   # the last `run` again
vp run trace -- assert --run --name episode --attr mode=turn --count 1
vp run trace -- open --run                   # spans that never ended: a leak
node scripts/scenarios.ts --keep warm-turn    # one scenario; keeps its trace file
```

`scripts/scenarios.ts` holds every scenario as data: what to run, its environment, and its `trace assert` arguments. A behavior change means changing or adding a scenario there; extend the stub (`tests/e2e/claude-stub.cjs`) or the trace CLI when one cannot express what you need. `PI_CLAUDE_CLI_TRACE_WIRE=1` adds one event per wire message; `=raw` records raw stdout lines, content included, for protocol debugging only.

## Architecture

- `index.ts`: register a native pi provider (its auth check, the subscription marker, the account's models) and the same stream with pi-ai's compatibility registry, plus `/pi-claude-cli-status`. No Effect import: the runtime is loaded on the first model call and disposed on `session_shutdown`. Other lifecycle events, and pi-ai's session cleanup, retire parked processes.
- `src/provider-runtime.ts`: the `ManagedRuntime`, one per extension instance, and the boundary with pi. An episode is one fiber; pi's abort signal interrupts it; its single exit becomes exactly one of `done`, `error`, `aborted`.
- `src/episode.ts`: one pi model call. Take or launch a process, stream, hand tool calls to pi, park or retire.
- `src/episode-mode.ts`: pure decision between `spawn`, `turn` and `handoff`, and the launch signature.
- `src/claude-process-pool.ts`: launches processes and parks one per pi session. Its scope is the parent of every process scope.
- `src/claude-process.ts`: one CLI process and everything it owns, in one scope. The stdout reader answers permission and MCP requests whether or not an episode is attached. `retire` closes the scope.
- `src/claude-cli.ts`: launch flags and environment, over Effect's Node `ChildProcessSpawner`. Replaces Claude Code's prompt, disables native tools and session persistence, preserves explicit host guards and OAuth. Never use `--bare`.
- `src/mcp-inband.ts`: the in-band (`"type": "sdk"`) MCP server that advertises pi's tools on the CLI's own control channel. No socket, no helper process, no secret. A `tools/call` is held open until pi's next call delivers the result, matched on the actual tool-use id and name. A changed tool list is announced with `notifications/tools/list_changed` and confirmed by the CLI's next `tools/list`.
- `src/cli-protocol.ts`: lenient `Schema` decoding of the CLI's NDJSON; builders for stdin lines.
- `src/event-bridge.ts`: convert CLI stream events to pi messages. Content indexes restart each model cycle, so blocks are tracked by `(cycle, index)`.
- `src/pi-context.ts`: normalize old/new pi context formats, import ordered messages and images (as structured frames by default, or as labelled text with `PI_CLAUDE_CLI_IMPORT=flat`), hash acknowledged history.
- `src/signed-thinking.ts`: Claude's raw signed thinking blocks, stored on pi's assistant message under `piClaudeCli` by the event bridge (never in `diagnostics`: pi's bug report collects those) and replayed by a structured import only while the message is unchanged. Pure; imported eagerly through `event-bridge`.
- `src/cli-auth.ts`: `claude auth status` as pi's auth check (models offered while the CLI is installed and not logged out; a subscription reports as OAuth for pi's "(sub)" label), kept in `auth-status.json` under the state directory and refreshed in the background, because pi waits for auth checks at start. Pure apart from the probe and the file; loaded at pi start.
- `src/usage-credits.ts`: the usage-credit guard's rule and messages; every message says "billing" so pi does not retry it.
- `src/subscription-env.ts`: the variables that would move the CLI off the subscription login, for launches, the model probe and the auth check.
- `src/tool-call-id.ts`: tool call ids Claude would reject, mapped to valid ones in what is sent and back. pi's stored ids never change.
- `src/thinking-config.ts`: pi thinking levels as CLI flags and live control requests.
- `src/account-models.ts`, `src/model-probe.ts`: the model list. The first is pure and loaded at pi start: it joins the account's models with pi's catalogue and implements pi 1.x `refreshModels`. The second asks a short-lived CLI process for the account's models (`initialize`), and is loaded only when a refresh needs it.
- `src/provider-config.ts`, `src/runtime-directory.ts`, `src/usage.ts`, `src/errors.ts`, `src/cli-requirements.ts`: configuration, the private temp directory, billing arithmetic, tagged errors, minimum CLI version.
- `src/tracing.ts`, `src/trace-location.ts`, `scripts/trace.ts`: the span sink and the trace CLI.

## Invariants

1. pi owns the prompt, active tools, complete tool results and compaction. A Claude process is a disposable cache of pi's history, never a second conversation ledger.
2. A warm process may continue only when its acknowledged pi-history prefix and launch signature match. Anything else retires it and imports pi's current history into a fresh process. Thinking and the tool list are not in the signature: they are applied to the live process (`applyThinking`, `applyTools`), and only a change the CLI does not take retires it.
3. Tool calls reach pi as real toolCall blocks; the CLI waits for the matching pi result. The CLI has no native tools.
4. Nothing is written to pi's status line or to conversation content except the model's own output. A pi message also gets the fields pi's own Anthropic provider sets (`responseId`, `rawStopReason`, the usage breakdown, `providerThinkingLevel`) one `diagnostics` entry, the subscription's latest limit status, and the `piClaudeCli` key, which holds the model's signed thinking as the API returned it. `diagnostics` stay content-free: pi's bug report collects them. Effect's console logger is replaced: logs are span events.
5. CLI sessions do not persist. No transcript, no resume. Trace files are not a transcript: they hold ids, names, sizes, counts and durations, never prompt text, tool arguments or tool results (unless `PI_CLAUDE_CLI_TRACE_WIRE=raw` is set on purpose).
6. Preserve host/managed guards and official subscription authentication. Never extract OAuth tokens. Never forward a variable of `SUBSCRIPTION_OVERRIDE_ENV_VARS` (`src/subscription-env.ts`: API keys and tokens, `ANTHROPIC_BASE_URL`, other model providers' switches) to the CLI. A model call charged to usage credits ends the episode unless the user allowed it.
7. Report errors as assistant error events and aborts as aborted. Never return a raw string where pi expects an assistant message. Only `src/provider-runtime.ts` and `index.ts` end a pi stream.

## Conventions

- Effect everywhere, including scripts, following `docs/coding-standards.md`. The exceptions are `index.ts` and what it imports eagerly (`account-models`, `cli-auth`, `event-bridge`, `overflow`, `signed-thinking`, `subscription-env`, `thinking-config`, `terminal-event`), which must not import Effect, and the stub CLI.
- Vite+ owns the tooling: `vite.config.ts` configures oxfmt, oxlint (type-aware, with type checking) and the tests. Import test APIs from `vite-plus/test`, never `vitest`. Develop with pnpm (`packageManager`), but keep the package installable by npm: pi installs git packages with the user's package manager, and npm refuses a `devEngines` package-manager requirement.
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
