Design of the provider on Effect 4, and the record of how the plan met reality. The rewrite is implemented on the `effect-rewrite` branch; "What changed from the plan" at the end lists every place the original plan was wrong or was overruled.

Checked against the `effect@4.0.3` and `@effect/platform-node-shared@4.0.3` source, pi 0.87.1, and Claude Code 2.1.292. Claims marked **(tested)** were run in a scratch project; everything else was read from source.

## What the project is, in Effect terms

One pi model call ("episode") borrows a long-lived `claude -p` subprocess, streams its NDJSON to pi, and either parks the process or retires it. Three things make it hard today, and all three are lifetime problems:

- **A process outlives the call that spawned it.** It is parked between calls, and during a tool handoff it sits blocked while pi runs the tool.
- **Cleanup is hand-threaded.** `removeSessionMcpConfig`, `unregisterHandoffTarget`, `clearIdleTimer`, `failPendingCalls` and `failControlWaiters` are each called from `retire`, `handleProcClose` and several provider paths.
- **Episode control flow is flags.** `finished`, `streamEnded`, `aborted`, `selfInterrupted` and `sawToolCall` guard against double-ending the pi stream.

## Tracing and verification

Traces are how this rewrite is debugged and verified. Each step is checked by running a scenario and reading its trace, in preference to writing unit or integration tests. The trace sink and the trace CLI are therefore built first, before any provider code.

### Spans

Every service operation is an `Effect.fn("Service.operation")`, so it is a span with no extra code. On top of that:

| Span                                                                                       | Attributes                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `episode` (root, one per pi call)                                                          | pi session, CLI session, model, `mode` (`spawn`, `turn`, `handoff`), `spawnReason` (which reuse check failed), `outcome` (`done`, `toolUse`, `error`, `aborted`), billed usage |
| `ClaudeCli.spawn`                                                                          | argv flags, pid, CLI version                                                                                                                                                   |
| `ClaudeProcess` (root, one per process lifetime; linked from each episode that borrows it) | CLI session, pid, exit code                                                                                                                                                    |
| `ClaudeProcess.retire`                                                                     | `cause` (`idle`, `signature`, `history`, `thinking`, `failure`, `timeout`, `abort`, `interrupted`, `unparked`, `replaced`, `exited`, `shutdown`), `ended` (`exited`, `killed`) |
| `ClaudeProcessPool.take` / `park`                                                          | hit or miss, idle duration                                                                                                                                                     |
| `ClaudeProcess.applyThinking`                                                              | from, to, acknowledged                                                                                                                                                         |
| `toolCall` (one per handed-off tool call)                                                  | tool-use id, tool name, outcome                                                                                                                                                |
| `ProviderRuntime.build` / `dispose`                                                        | runtime directory ready or not, tool bridge, handoff proxy, wire detail                                                                                                        |

Rules:

- **No span or event per streamed token.** By default `episode` carries a count of wire messages by type and the time to first token as attributes, so an always-on trace stays small.
- **Wire detail is opt-in.** `PI_CLAUDE_CLI_TRACE_WIRE=1` adds one `wire <type>` event per message to `episode`; `PI_CLAUDE_CLI_TRACE_WIRE=raw` also records each raw stdout line as a `wire raw` event on `ClaudeProcess`, for protocol debugging. Raw lines go on the process span because the reader is the only place that still has them undecoded.
- **No content by default.** Never prompt text, tool arguments or tool results. Record ids, names, sizes, counts and durations. Only `WIRE=raw` breaks this, and only when asked.
- **Logs are span events.** `Logger.layer([Logger.tracerLogger])` is the only logger; see "Logging".

### Sink

A custom tracer returns a subclass of `Tracer.NativeSpan` that appends one NDJSON record when a span starts, one for each span event, and one when it ends. Events are their own records, not a field of the end record, so `trace tail` shows them live and a span that never ends still shows what it logged.

```ts
{ kind: "start", name, traceId, spanId, parentSpanId, pid, timeMs, links }
{ kind: "event", name, traceId, spanId, pid, timeMs, attributes }
{ kind: "end",   name, traceId, spanId, parentSpanId, pid, timeMs, durMs,
  status: "ok" | "error" | "interrupted", error, attributes, links }
```

- **On by default.** With `PI_CLAUDE_CLI_TRACE` unset, records go to `<state>/traces/<YYYY-MM-DD>.ndjson`, where `<state>` is `$XDG_STATE_HOME/pi-claude-cli` or `~/.local/state/pi-claude-cli`. Any session can then be inspected after the fact, without having been started in a special way.
- **`PI_CLAUDE_CLI_TRACE=<path>`** writes to that file instead; `trace run` uses this to isolate a scenario. **`PI_CLAUDE_CLI_TRACE=off`** writes nothing.
- **Append-only**, so several pi processes share a file; every record carries the pid.
- **Private and bounded.** The directory is `0700` and files `0600`. Files not written for seven days are pruned when a runtime builds. `trace run` keeps its per-run files in `<state>/traces/runs/`, pruned the same way.
- **Never in the way.** A failed write disables the sink for that runtime and is otherwise ignored; tracing must not be able to fail an episode.
- **Not a transcript.** Records hold no conversation content, so invariant 5 stands; the docs step states this in `AGENTS.md`.
- **Start records matter.** A span that starts and never ends is a leak (a process never retired, a scope never closed), and the CLI can only show it if the start was written.
- **Synchronous append is fine** at span boundaries: an episode has a handful of spans.

`effect/observability`'s `OtlpTracer.layer` can be added later for a real collector. It is not part of this plan.

### Trace CLI

`scripts/trace.ts` is an Effect program (`effect/cli` commands over `FileSystem`, `Path` and `ChildProcessSpawner`), run directly by Node's type stripping: `node scripts/trace.ts <command>` or `npm run trace -- <command>`. The original plan asked for plain Node with no Effect import so the tool would survive a broken rewrite; the owner overruled that in favour of Effect everywhere. The CLI imports only `src/trace-location.ts` and `src/node-platform.ts`, so a broken provider still leaves it working.

With no `--file` a command reads `PI_CLAUDE_CLI_TRACE` when it names a file, otherwise the newest daily file in the default location, so `trace tree --last` works straight after any session. `--run` reads the file of the most recent `trace run`.

| Command                    | Does                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run -- <command>`         | Create a fresh trace file, set `PI_CLAUDE_CLI_TRACE`, run the command, print the tree, exit with the command's status                                                                      |
| `tree [traceId \| --last]` | Indented span tree with duration, status, attributes and inline events; open spans flagged                                                                                                 |
| `ls`                       | One line per trace: root span, start, duration, status                                                                                                                                     |
| `spans`                    | Filter by `--name`, `--status`, `--attr`, `--event`, `--under`, `--trace`; `--json` for piping                                                                                             |
| `open`                     | Spans that started and never ended; exits 1 when there are any                                                                                                                             |
| `tail`                     | Follow the file live                                                                                                                                                                       |
| `stats`                    | Count and p50 / max duration by span name                                                                                                                                                  |
| `assert`                   | Exit non-zero unless the trace matches: the `spans` filters plus `--count`, `--min-count`, `--max-count`, `--max-ms`, `--min-ms`, `--same k`, `--distinct k`, `--no-open`, `--order a,b,c` |

`--attr` takes `k=v`, `k!=v`, `k~regex`, bare `k` (present) and `!k` (absent). An `--order` selector is `name[k=v,...]`, optionally suffixed `:end` to order by end time. `assert` is what replaces test assertions.

### Verification by scenario

A scenario runs real code against the stub CLI (`tests/e2e/claude-stub.cjs`), under `trace run`, and then checks the recorded trace with `trace assert`. `scripts/scenarios.ts` holds every scenario as data (what to run, with which environment, and its assertions) and is the runner:

```bash
npm run test:scenarios                 # every stub scenario; non-zero if any assertion fails
node scripts/scenarios.ts warm-turn    # one scenario
node scripts/scenarios.ts --keep abort-mid-stream   # keep the trace file and print its path
node scripts/scenarios.ts --list
node scripts/scenarios.ts --live       # also the live scenario; spends subscription tokens
```

Most scenarios run `scripts/scenarios/driver.ts`, which calls the provider runtime's `startEpisode` the way pi does and keeps a pi-style conversation, for sequences print mode cannot express. `print-mode-exit` runs real `pi -p`. The driver also checks what a trace cannot show: the terminal event pi received, the stub's view of its argv and environment, and files on disk.

| Scenario                                                          | The trace must show                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh-spawn`                                                     | `episode` with `mode=spawn`, `outcome=done`; one `ClaudeCli.spawn`; one `park`                                                               |
| `warm-turn`                                                       | Second `episode` with `mode=turn`; one `ClaudeCli.spawn` in total; same pid                                                                  |
| `tool-handoff`, `tool-handoff-parallel`                           | `outcome=toolUse`; `park` at the handoff idle time; next `episode` with `mode=handoff`, same pid; `toolCall` ok                              |
| `tool-abandoned`                                                  | A user message instead of the tool result: `spawnReason=handoffMismatch`; `toolCall` interrupted; the blocked process retired                |
| `handoff-proxy-off`                                               | `PI_CLAUDE_CLI_HANDOFF_PROXY=0`: no `toolCall`; `retire` with `cause=interrupted`; the tool result is reimported                             |
| `changed-history`, `changed-prompt`, `foreign-provider`           | `mode=spawn` with the matching `spawnReason`; the old process retired with `cause=history` or `cause=signature`; distinct pids               |
| `changed-tools`, `changed-tools-handoff`, `changed-tools-refused` | `applyTools` acknowledged and no spawn, between turns and with a tool call open; a CLI that does not list again leads to `spawnReason=tools` |
| `thinking-change`, `thinking-refused`                             | `applyThinking` acknowledged and no spawn; a refusal leads to `spawnReason=thinking`                                                         |
| `abort-mid-stream`, `abort-during-launch`, `already-aborted`      | `episode` interrupted with `outcome=aborted`; `retire` with `cause=abort` ending afterwards; nothing parked; no open spans                   |
| `inactivity-timeout`                                              | `outcome=error`; `retire` with `cause=timeout`, `ended=killed`                                                                               |
| `process-dies`, `turn-fails`                                      | `outcome=error` (the driver checks the stderr tail and exit code in the message); nothing parked                                             |
| `idle-expiry`                                                     | `retire` with `cause=idle` at the keepalive (set short through env)                                                                          |
| `no-session`, `lifecycle-retire`                                  | No pi session: served and ended, not parked. A lifecycle event: `retire` with `cause=shutdown`                                               |
| `session-shutdown`                                                | `ProviderRuntime.dispose`; no open spans; the driver checks the runtime directory is gone                                                    |
| `layer-build-failure`                                             | No `episode` span at all; the driver checks both calls end with an `error` event instead of hanging                                          |
| `env-stripping`, `launch-flags`                                   | The stub reports no `ANTHROPIC_*` variables; host `--settings` kept, empty arguments preserved, never `--bare`                               |
| `wire-counts`, `wire-events`, `wire-raw`                          | Counts and `ttftMs` by default and no events; `wire <type>` events at `=1`; `wire raw` events on the process at `=raw`                       |
| `trace-sink`, `trace-default-location`                            | The three statuses and events; the default daily file is `0600` in a `0700` directory, pruned, and found by the CLI                          |
| `print-mode-exit`                                                 | Real `pi -p` loads the provider lazily, parks a process, disposes on `session_shutdown` and exits                                            |
| `live` (spends tokens)                                            | One turn, one tool call held open, one warm follow-up, all on one pid                                                                        |

Every scenario also asserts `--no-open`.

What this means for the test suite:

- **Keep** the existing unit tests for modules that stay pure: `pi-context`, `thinking-config`, `overflow`, `tool-mapping` and `event-bridge`.
- **Delete** the tests of deleted modules. Do not port them, and do not write new unit or integration tests for the Effect services; scenarios cover them.
- **No `@effect/vitest` and no vitest upgrade.** Scenarios use short timeouts set through env instead of `TestClock`.
- **Coverage covers what unit tests cover.** Coverage `include` in `vitest.config.ts` lists the five pure modules and keeps the 92% / 85% floors on them. `pi-context` and `tool-mapping` were previously covered only through tests of deleted modules, so they gained direct unit tests.
- **Scenarios are the gate for the services.** `npm run test:scenarios` runs every stub scenario and fails if any `trace assert` fails. CI runs it in the job that already installs pi.

## Decide the tool bridge first

Before the rewrite a tool call left the CLI through `mcp-schema-server.cjs`, a unix socket, a shared secret and a handoff broker. Claude Code can instead host an MCP server in-band over the stdio control channel (`"type": "sdk"`, the Agent SDK's mechanism). The spike settled it: **the in-band route is taken and the socket bridge is gone.**

The spike is kept as `scripts/spikes/inband-mcp.ts` so it can be repeated against a new Claude Code version (`probe` spends no tokens; `round-trip`, `timeout`, `list-changed`, `list-changed-mid-call` and `list-removed` run one or two haiku turns; `--claude <path>` probes another binary).

Spike results, on 2.1.292 and repeated on the 2.1.263 floor:

1. **A `tools/call` round trip held open works.** The call arrives as `control_request {subtype: "mcp_message"}`; the answer is a `control_response` carrying `mcp_response`. Held for 3 s while "pi ran the tool", then the turn continued in-process.
2. **The call carries the tool-use id** in `_meta["claudecode/toolUseId"]`, on both versions.
3. **An interrupt mid-call** makes the CLI send `notifications/cancelled {requestId, reason: "AbortError: remote-cancel"}` and end the turn with `error_during_execution`. A late answer to the cancelled call is ignored.
4. **The call has a timeout and `MCP_TOOL_TIMEOUT` governs it.** At `2000` the CLI told the model the tool timed out after 2 s and sent `notifications/cancelled {reason: "SdkError: Request timed out"}`. The provider keeps setting it to one hour.
5. **The floor behaves the same.** 2.1.263 lists the tools at start and completes the round trip.
6. **The `initialize` control request is not required.** Without it the CLI still sends MCP `initialize`, `notifications/initialized` and `tools/list` within half a second of launch.
7. **`mcp_set_servers` with the same server is a no-op** (`{added: [], removed: []}`). An MCP `notifications/tools/list_changed` sent as an `mcp_message` is the way to change the surface: the CLI asks for `tools/list` again within milliseconds, and on the next turn the model was offered and called the new tool on the live process. 2.1.263 acknowledges the notification and lists nothing; a no-token `probe` of nine versions found 2.1.265 to be the first that lists again, so the floor is now 2.1.265 and `ClaudeProcess.applyTools` uses the notification.
8. **A tool added while a `tools/call` is open is offered in the same turn.** The CLI listed again 2 ms after the notification, and the model request that followed the tool result called the new tool (`list-changed-mid-call`).
9. **A removed tool is gone from the CLI, not from the model's memory.** `mcp_status` and the next turn's `system init` no longer list it, but a model that has just used it may still emit a `tool_use` for it; the CLI refuses that itself and no `tools/call` reaches the server (`list-removed`).

One thing the spike showed that the plan had not anticipated: the `tools/call` and the `message_stop` of the assistant message that asked for it arrive in either order. See "State that becomes Effect primitives".

What the in-band route removed: `mcp-schema-server.cjs` and its `node` child per CLI process, `HandoffBroker`, the socket, the shared secret and its file, the content-addressed schema files and the per-process `--mcp-config` file. `--mcp-config` is now a constant JSON string. `RuntimeDirectory` holds only system prompt files.

## Lifetimes as scopes

```text
runtime scope                      one ManagedRuntime per extension instance
├── tracing                        tracer + tracerLogger; file sink unless PI_CLAUDE_CLI_TRACE=off
├── RuntimeDirectory               0700 temp dir, removed on close
└── ClaudeProcessPool
    └── process scope              Scope.fork(runtime), closed by retire
        ├── ClaudeProcess span     root span for the process lifetime
        ├── child process          finalizer: see "Retiring a process"
        ├── stdout reader fiber    answers control and MCP requests, fills inbox
        ├── stdin writer fiber     drains one outbound Queue
        ├── stderr reader fiber    keeps the last 64 KiB
        ├── tool-call fibers       one per open `tools/call`, waiting on pi's result
        └── idle timer             FiberHandle; re-parking replaces it

episode scope                      one pi call, Effect.scoped
├── system prompt file             acquireRelease in the runtime directory
└── borrows one process scope; on exit: park it or retire it
```

The process scope is deliberately not a child of the episode scope; that is the one place needing explicit `Scope.fork` / `Scope.close` instead of `Effect.scoped`.

### The runtime belongs to the extension instance

pi calls the extension factory once per session (`/new`, `/resume`, `/fork`, `/reload` each tear down and re-create), and emits `session_shutdown` before each teardown and on quit. So:

- Create the runtime inside the factory, lazily on the first model call.
- Dispose it on `session_shutdown`. A disposed runtime cannot be reused **(tested)**, so the handler clears the reference and the next call builds a fresh one.
- `session_start`, `model_select`, `session_tree` and `session_compact` call `pool.retireAll` only.

This is required, not tidy-up. pi's print mode exits by letting the event loop drain (`main.js` sets `process.exitCode` and returns). Effect timers are not `unref`'d, and a parked process keeps its pipes open. Disposing on `session_shutdown` is what lets print mode exit; the `print-mode-exit` scenario checks it with a process parked at the default keepalive. `beforeExit` is not a usable hook: it only fires once the loop is already empty.

Keep every layer infallible. A failed layer build is memoized: it is attempted once and every later call fails the same way **(tested)**. A runtime directory that cannot be created is therefore recorded in the service and reported by each episode that needs it, and a trace directory that cannot be created turns the file sink off.

## The pi boundary and abort

pi needs the stream returned synchronously. `index.ts` stays free of Effect imports and loads the runtime on the first model call, because a top-level `import "effect"` costs about 135 ms and 60 MB RSS on every pi start **(tested)**, used or not. The dynamic import works under pi's bundled jiti (the `print-mode-exit` scenario and `npm run test:e2e` both go through it).

```ts
// index.ts, inside the factory
let loaded: Promise<ProviderRuntime> | undefined;
const provider = () =>
  (loaded ??= import("./src/provider-runtime.ts").then((m) =>
    m.startProviderRuntime(),
  ));

const streamSimple = (model, context, options) => {
  const piStream = createAssistantMessageEventStream();
  provider().then(
    (runtime) => runtime.startEpisode(piStream, model, context, options),
    (cause) => failStream(piStream, model, cause),
  );
  return piStream;
};

pi.on("session_shutdown", async () => {
  const current = loaded;
  loaded = undefined;
  await (await current?.catch(() => undefined))?.dispose();
});
```

```ts
// src/provider-runtime.ts
startEpisode: (piStream, model, context, options) => {
  const bridge = createEventBridge(piStream, model);
  runtime.runCallback(runEpisode({ model, context, options, bridge }), {
    signal: options?.signal, // abort = fiber interruption
    onExit: (exit) => pushTerminalEvent(piStream, bridge, exit),
  });
};
```

The terminal event is pushed from `runCallback`'s `onExit`, not from an `Effect.onExit` inside `runEpisode`. If the runtime fails to build, `runEpisode` never starts and its own exit handler never runs, leaving pi's stream open forever **(tested)**. The boundary `onExit` also covers defects and an already-aborted signal, which arrives as an interrupt-only cause **(tested)**. It replaces the `streamEnded` guard: one fiber, one exit, one of `done`, `error` or `aborted`.

The event bridge is created by the boundary and owns the partial message, so the plain `onExit` callback can read what was already streamed. The plan had a `MutableRef` for this; the bridge already is one.

`ProviderRuntime` (`startEpisode`, `retireParkedProcesses`, `dispose`) has no Effect types in its signature. `startProviderRuntime` takes the provider layer as a parameter, which is how the `layer-build-failure` scenario runs the real boundary over a layer that cannot build.

## State that becomes Effect primitives

| Today                                                                                               | Effect                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sink` + `buffer` + `attach`/`detach`                                                               | One `Queue.sliding<CliMessage, ProcessExited>(20_000)` inbox per process; an episode takes from it, so buffering during a handoff gap needs no code                          |
| `onClose` / `onError` sink callbacks                                                                | `Queue.fail(inbox, ProcessExited)`; buffered lines drain before the failure surfaces **(tested)**                                                                            |
| `awaiting` / `pending` / `ready` maps                                                               | One `Deferred<McpToolResult>` per tool-use id, created by the stdout reader when it sees the `tool_use` block; the call awaits it, pi's result completes it, in either order |
| `controlWaiters` + 5 s timer                                                                        | `Deferred<boolean>` per request id, with `Effect.timeout`                                                                                                                    |
| Inactivity `setTimeout` reset per line                                                              | `Queue.take(inbox).pipe(Effect.timeoutOrElse(...))`; a timed-out take loses nothing **(tested)**                                                                             |
| `retire()` grace timers (2 s, 500 ms)                                                               | Process-scope finalizer; see "Retiring a process"                                                                                                                            |
| `activeProcesses` + `killAllProcesses`                                                              | Gone; every process scope is a child of the runtime scope                                                                                                                    |
| Idle timer per parked process                                                                       | `FiberHandle` inside the process scope; `run` interrupts the previous timer, and retiring the process removes it                                                             |
| `parked` map                                                                                        | `Ref<HashMap<piSessionId, ParkedProcess>>`; no update is effectful, so `SynchronizedRef` was not needed                                                                      |
| `process.env` reads scattered across files                                                          | One `Config` struct, read once; see "Config"                                                                                                                                 |
| `any` NDJSON messages                                                                               | `Schema` union decoded at the stdout boundary; see "Decoding stdout"                                                                                                         |
| `execSync("claude --version")` on every spawn; `claude auth status` blocking startup (about 220 ms) | Version asked once per runtime and remembered only once known, so installing the CLI mid-session works; auth check forked at first launch                                    |
| `addUsage` / `maxUsage`                                                                             | `Struct.makeReducer` with `Number.ReducerSum` / `ReducerMax`                                                                                                                 |
| `Date.now()` and `Math.random()` in ids and timestamps                                              | `Clock` and `Crypto` in the services; the event bridge keeps `Date.now()` for the message timestamp                                                                          |
| `console.warn` / `console.error`                                                                    | `Effect.log*`, recorded as span events; see "Logging"                                                                                                                        |

Take from the inbox one message at a time with `Queue.take`. Do not consume it through `Stream.fromQueue`: that pulls with `takeAll`, so an episode that ends mid-batch would drop lines belonging to the next episode.

**The reader, not the episode, registers expected tool calls.** The plan had the episode call `expectToolCall` when it read a `tool_use` block. But the reader and the episode are different fibers: the CLI's `tools/call` can reach the reader before the episode has taken the block out of the inbox, and the call would be refused as unmatched. The reader sees every line in order, so it creates the `Deferred` itself and `expectToolCall` is not part of the interface.

### Retiring a process

`retire(cause)` closes the process scope. The first call does the work under a `ClaudeProcess.retire` span; later calls wait for it. Two finalizers matter, run in this order:

1. Ours, registered after the spawn so it runs first. If a turn is live, write the interrupt and wait up to 2 s for the turn to end or the process to exit, whichever is first; then `Queue.end(outbound)`, which closes the child's stdin **(tested)**, and wait up to 500 ms for the exit. The plan waited the full 2 s for an _exit_ after the interrupt, as the old code did; but the CLI answers an interrupt with a `result` and keeps running, so that always cost 2 s. Waiting for the turn to end retires an interrupted process in milliseconds.
2. The spawner's own: signal whatever is still running. The process is spawned with `killSignal: "SIGKILL"`.

`cause=timeout` skips step 1: a CLI that has gone silent is killed at once, as before.

A process that ends on its own (stdout EOF) fails its inbox with `ProcessExited` and retires itself with `cause=exited`. That retire is forked into the runtime scope, because it closes the scope the reader runs in.

### Decoding stdout

Use `Stream.decodeText` + `Stream.splitLines`, then a lenient per-line decode (`decodeCliLine` in `src/cli-protocol.ts`): skip lines that do not start with `{`, read the envelope's `type`, decode the body for the types the provider acts on, and fall back to an `Other` message for anything unknown or malformed, so it still counts as output for the inactivity timeout. Lines arrive one per write, with no batching **(tested)**.

- Do not use `encoding/Ndjson` here. One unparseable line fails the whole channel, and the CLI prints non-JSON debug lines.
- The wire format is undocumented and changes. The inner streaming event is one loose struct with optional fields, not a union, so a new event or delta type decodes and is ignored by the event bridge. Token counts accept `null`.
- Decode synchronously (`Schema.decodeUnknownOption`) on this path; it runs once per streamed token.

### Config

`ProviderConfig` reads every variable once when the runtime builds, and stays lenient everywhere: an unset, empty or unparseable value falls back to its default, as it always has, so a typo in a tuning variable cannot stop pi from getting a model response and the layer cannot fail. `PI_CLAUDE_CLI_KEEPALIVE_MS` accepts `0`, `off`, `false` and `none` for "park nothing". No `Config.schema` was needed: the values are read as optional strings and parsed by small pure functions.

`PI_CLAUDE_CLI_THINKING_DISPLAY` is still read by `thinking-config.ts` itself, which stays a pure module with its own tests.

Scenarios set real env vars; each runs in its own process.

### Logging

The default Effect logger writes to stdout through `console.log`, which would corrupt pi's RPC protocol and TUI. Replace it in the provider layer with `Logger.layer([Logger.tracerLogger])` and no console logger.

Every `Effect.log*` call then becomes an event on the current span **(tested)**, so logs appear in the trace in order, under the operation that produced them. There is no separate log file.

## Where RcMap fits, and where it doesn't

- **Not the process pool.** `RcMap` derives a resource from its key alone and shares it. A parked process depends on the request (signature, acknowledged history), is exclusive, and has an idle time that depends on why it was parked (10 minutes after a turn, 30 minutes in a handoff). 4.0.3's per-key `idleTimeToLive` does not change this.
- **Not needed at all on the in-band route.** Its one use was the bridge's schema files. The tool surface is a list the process holds and the in-band server lists on request.

## Services

```ts
interface IClaudeProcess {
  // a scoped value, not a contextual service
  readonly cliSessionId: string;
  readonly pid: number;
  readonly signature: LaunchSignature;
  readonly allowHandoff: boolean;
  readonly span: Tracer.Span; // linked from each episode that borrows it
  readonly inbox: Queue.Dequeue<CliMessage, ProcessExited>;
  readonly acknowledged: Ref.Ref<Option.Option<HistoryCheckpoint>>;
  readonly lastProcessTotals: Ref.Ref<TokenUsage>;
  readonly turnReported: Ref.Ref<TokenUsage>;
  readonly idleTimer: FiberHandle.FiberHandle<void>;
  readonly isAlive: Effect.Effect<boolean>;
  readonly isTurnActive: Effect.Effect<boolean>;
  readonly writeUser: (content) => Effect.Effect<void, ProcessGone>;
  readonly interruptTurn: Effect.Effect<void>;
  readonly applyThinking: (t: CliThinking) => Effect.Effect<boolean>;
  readonly awaitsToolCalls: (ids) => Effect.Effect<boolean>;
  readonly answerToolCall: (id, r: McpToolResult) => Effect.Effect<void>;
  readonly retire: (cause: RetireCause) => Effect.Effect<void>; // closes the process scope
  readonly awaitRetired: Effect.Effect<void>;
}

interface IClaudeProcessPool {
  readonly launch: (
    launch: ClaudeProcessLaunch,
  ) => Effect.Effect<IClaudeProcess, CliRequirementError | CliSpawnError>;
  readonly take: (id: string) => Effect.Effect<Option.Option<IClaudeProcess>>;
  readonly park: (
    id: string,
    p: IClaudeProcess,
    idle: Duration.Duration,
  ) => Effect.Effect<void>;
  readonly retireInBackground: (
    p: IClaudeProcess,
    cause: RetireCause,
  ) => Effect.Effect<void>;
  readonly retireAll: (cause: RetireCause) => Effect.Effect<void>;
}
```

The pool owns `launch` because the pool's scope is the parent of every process scope: `launchClaudeProcess` forks the process scope from it, and a failed launch closes that scope again. `retireInBackground` forks the retire into the same scope, which is where "never await a retire" lives.

`ClaudeCli` wraps `ChildProcessSpawner` (launch flags, env stripping, version and auth checks). `ProviderConfig` and `RuntimeDirectory` are the remaining services. Session and tool-use ids are plain strings; the plan's branded id types were not introduced.

### Spawning

- **Env stripping.** `extendEnv: true` with `env: { ANTHROPIC_API_KEY: undefined, ... }` removes the variables from the child **(tested)**. The `env-stripping` scenario reads the child's real environment; this is invariant 6.
- **`detached: false`, explicitly.** Effect defaults to `detached: true`, which puts the child in its own process group **(tested)**. Ctrl-C in `pi -p` would then no longer reach `claude`. With `false`, the spawner's group kill fails and falls back to a plain kill.
- **`killSignal: "SIGKILL"`.** The process scope's own finalizer asks the CLI to exit first; the spawner's finalizer only has to end what is still running after that.
- **Windows is not supported.** Effect's Node spawner calls `child_process.spawn` directly and cannot launch `claude.cmd`; the plan kept `cross-spawn` behind a custom `ChildProcessSpawner` for that. The owner decided Windows does not matter, so that spawner and the `cross-spawn` dependency were deleted and `NodeChildProcessSpawner.layer` is used as is. Empty arguments (`--tools ""`) reach the CLI intact; the `launch-flags` scenario checks it.

## The episode

```text
runEpisode({ model, context, options, bridge })
  request   = normalize pi context
  parked    = pool.take(sessionId)               # uninterruptible with recording it
  mode      = decideEpisodeMode(parked, request) # pure: spawn(reason) | turn | handoff
  mode is turn and applyThinking refused → spawn(thinking)
  process   = mode is spawn ? retire parked in background, stage prompt file,
                              pool.launch (uninterruptible), write full history
                            : parked
  mode is turn    → writeUser(delta)
  mode is handoff → answerToolCall for each tool result
  loop take inbox (with inactivity timeout)
    stream_event → bridge.handleEvent pushes pi events; note a tool_use block
    message_stop with tool call
      handoff on  → return HandedOff
      handoff off → interruptTurn, keep reading for result
    result       → apply usage, return TurnEnded | fail CliResultError
  release (uninterruptible)
    HandedOff → set checkpoint, park(handoff wait)
    TurnEnded → interrupted: retire in background
                else set checkpoint and park(keepalive), or retire in background
  on failure / interrupt → retire in background, do not await it
  then the boundary onExit pushes exactly one of done | error | aborted
```

Three ordering rules:

- **Park before the fiber exits.** `done` is pushed after exit, so the process is already parked when pi issues the next call.
- **Never await a retire on the failure or abort path.** Retiring can take 2.5 s; awaiting it would delay `aborted` by that long. This now also holds when a parked process is replaced on the spawn path, which the old code awaited.
- **Taking or launching a process and recording it are one uninterruptible step.** The first full scenario run caught this: an abort landing between `pool.launch` returning and the episode recording the process left a process that was neither parked nor retired until the runtime was disposed. `abort-during-launch` covers it.

`decideEpisodeMode` (`src/episode-mode.ts`) is a pure function of the parked process's facts and the request. The launch signature is a struct, not a JSON string, so a spawn names the setting that changed (`signature.prompt`, `signature.cwd`, …).

## File layout

```text
index.ts                      # pi registration, lazy import, session_shutdown → dispose
src/
├── provider-runtime.ts       # ManagedRuntime, provider layer, startEpisode, terminal event
├── episode.ts                # runEpisode
├── episode-mode.ts           # pure: launch signature, spawn | turn | handoff decision
├── claude-process-pool.ts    # service: launch, take, park, retire
├── claude-process.ts         # scoped process resource
├── claude-cli.ts             # service: launch flags, env, version and auth checks
├── runtime-directory.ts      # service: private temp dir, system prompt files
├── provider-config.ts        # service: environment configuration
├── mcp-inband.ts             # pure: the in-band MCP server's protocol
├── cli-protocol.ts           # Schema for the NDJSON wire format, stdin line builders
├── cli-requirements.ts       # pure: minimum CLI version
├── usage.ts                  # pure: token arithmetic for billing
├── errors.ts                 # tagged errors
├── terminal-event.ts         # plain: done / error events (no Effect import)
├── tracing.ts                # file tracer, tracerLogger layer
├── trace-location.ts         # where traces are written; shared with the CLI
├── node-platform.ts          # Node FileSystem, Path, Crypto, ChildProcessSpawner layers
├── event-bridge.ts           # CLI stream events → pi events and the partial message
└── pi-context.ts, thinking-config.ts, overflow.ts, tool-mapping.ts   # stay pure
scripts/
├── trace.ts, trace/          # the trace CLI
├── scenarios.ts              # scenario definitions and runner
└── scenarios/                # driver, sample program, trace-location check
```

## Module inventory

Import paths are for 4.0.3: `effect/process`, `effect/cli`, with no `unstable/` prefix. They are still annotated unstable, as is `Crypto`. Local TypeScript is imported with `.ts` specifiers and the package is `"type": "module"`, so Node's type stripping runs the scripts and the provider with no loader; jiti (pi) and vitest accept the same specifiers.

- **Core, heavy use:** `Effect`, `Layer`, `Context`, `Scope`, `ManagedRuntime`, `Exit`, `Cause`, `Fiber`, `Deferred`, `Queue`, `Ref`, `Stream`, `Schema`, `Config`, `Duration`, `Option`, `Data`.
- **Core, one specific job:**
  - `FiberHandle`: idle timer per process
  - `HashMap`: the parked map
  - `FileSystem`: `makeTempDirectoryScoped`, `writeFileString` with `mode`
  - `Path`
  - `Crypto`: UUID
  - `Clock`: timestamps
  - `Tracer`: the file sink; see "Tracing and verification"
  - `Logger`: `tracerLogger` only
  - `Struct` + `Number` reducers: usage arithmetic
  - `Result`: a layer that records a failure instead of failing
- **Process:** `effect/process` `ChildProcess` + `ChildProcessSpawner`.
- **Scripts:** `effect/cli` `Command`, `Flag`, `Argument`; `Console`; `Runtime.errorExitCode` for exit codes.
- **Planned and not used:** `SynchronizedRef`, `MutableRef`, `Match`, `ConfigProvider`, `Config.schema`, `makeTempFileScoped`, and `effect/ai/McpSchema` (the four MCP methods are typed with a few small `Schema` structs in `cli-protocol.ts` instead).
- **Node platform:** `@effect/platform-node-shared`, not `@effect/platform-node`, and imported by narrow entrypoint (`@effect/platform-node-shared/NodeFileSystem`), never the barrel: the barrel also loads the socket, cluster and `ws` modules, about 80 ms and 25 MB **(tested)**. The shared package has every layer needed (spawner, filesystem, path, crypto) and depends only on `ws`. `@effect/platform-node` adds `undici` and a non-optional `redis` peer, which would land in every pi install. Its `NodeServices.layer` is a plain merge that is easy to write by hand.
- **Testing:** none planned. Verification is by trace; see "Verification by scenario". `TestClock`, `TestCrypto`, `FileSystem.layerNoop` and a fake `ChildProcessSpawner` exist if a case turns out to need them. `@effect/vitest` 4.0.3 requires vitest 5 (the repo is on 3.2.7) and is not adopted.
- **Considered and rejected:**
  - `Pool`, `RcRef`, `ScopedRef`, `LayerMap`: wrong sharing model for an exclusive, request-dependent process.
  - `ScopedCache`, `Cache`: expiry is checked lazily on access, so an idle process would never be killed.
  - `FiberMap`: a pool-level timer map outlives the process it times; `FiberHandle` in the process scope does not.
  - `PubSub`, `SubscriptionRef`: there is one consumer.
  - `Semaphore`: exclusivity comes from `take` removing the process from the pool.
  - `Tx*` (STM): there are no multi-ref transactions.
  - `encoding/Ndjson`: see "Decoding stdout".
  - `ai/McpServer`: wants an RPC transport and a static toolkit; four hand-written methods over `McpSchema` are smaller.
  - `rpc` for the broker wire: the peer is a dependency-free `.cjs`.
  - `@effect/ai-anthropic` generated event schemas: 627 KB and strict, to read about ten fields from an undocumented stream.
  - `Schedule`: nothing here is retried.
  - `NodeRuntime.runMain`: pi owns the process.

## What should stay outside Effect

- **`index.ts`.** Registration, the lazy import and the `session_shutdown` handler; see "The pi boundary and abort". `src/terminal-event.ts` is plain for the same reason: `index.ts` uses it to report a runtime that failed to load.
- **A synchronous `process.on("exit")` fallback.** Effect finalizers cannot run there, so `RuntimeDirectory` keeps a small `rmSync` and the pool a SIGKILL of its live pids as last resorts. Each is registered once per runtime and removed on dispose, so `/reload` does not accumulate listeners.
- **The span sink's append.** `appendFileSync` inside the tracer: a span boundary is a synchronous callback.
- **The event bridge.** It stays the accumulator it was (`handleEvent`, `applyResult`, `getOutput`) and is called from the episode inside `Effect.sync`. The plan called for a `(state, event) → [state, piEvents]` reducer; that would have meant rewriting 600 lines that encode a dozen hard-won wire fixes, and their 1,700 lines of tests, for no change in behaviour.
- **The stub CLI** (`tests/e2e/claude-stub.cjs`): it stands in for a foreign binary and is plain CommonJS on purpose.

## Things to verify before committing

1. **The in-band MCP spike.** Done; in-band route taken. See "Decide the tool bridge first".
2. **Dynamic import under pi's bundled jiti.** Works: `npm run test:e2e` and the `print-mode-exit` scenario load `src/provider-runtime.ts` through it.
3. **Windows launch.** Dropped: Windows is not supported, by owner decision.
4. **Print mode exits** after a turn with a parked process. Verified with the stub (`print-mode-exit`, on pi 0.84.2, 0.87.1 and 1.1.0) and live through real `pi -p` with a real tool call.
5. **Every scenario** passes its `trace assert`: `npm run test:scenarios`.
6. **The coverage floors.** Settled: coverage is narrowed to the pure modules and the floors hold there.

Already settled: streaming latency (lines arrive per write) and load cost (about 135 ms, deferred by the lazy import).

## Order of work

0. Tracing first: add the dependencies, `src/tracing.ts` and `scripts/trace.mjs`, proven against a sample Effect program.
1. In-band MCP spike. One live turn, no provider code.
2. `provider-config`, `errors`, `cli-protocol`: no behaviour change.
3. `RuntimeDirectory`; then either `mcp-inband`, or `ToolSchemaStore` + `HandoffBroker`.
4. `ClaudeCli` with the `cross-spawn` spawner, and `ClaudeProcess`, with the spawn, retire and crash scenarios passing against the stub.
5. Pool and `runEpisode`; `provider-runtime` and the lazy boundary in `index.ts`; delete the old modules and their tests. All stub scenarios pass.
6. Run the live scenario and the print-mode exit check before pushing.
7. Update `AGENTS.md`, `README.md` and `docs/CONTEXT-POLICY.md` to describe the new architecture and the trace workflow.

## Status and next steps

The rewrite is complete on the local branch `effect-rewrite` and has not been pushed. Pushing is the release: pi installs this package from git.

What has been verified, and how:

| What                                                                                | How                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Every service path against the stub CLI                                             | `npm run test:scenarios`: 33 scenarios, each asserting on its trace and on `--no-open`                        |
| Registration, lazy load under jiti, print-mode exit                                 | `npm run test:e2e` and `print-mode-exit`, on pi 0.84.2, 0.87.1 and 1.1.0                                      |
| One turn, a held-open tool call, a warm follow-up, real CLI                         | `node scripts/scenarios.ts --live` (`live`) on Claude Code 2.1.292 and the 2.1.265 floor                      |
| Two tool calls in one message, each given its own result, real CLI                  | `live-parallel-tools`, on both versions                                                                       |
| Tools added between turns and during a call, then removed, on one process, real CLI | `live-tools-change`, on both versions                                                                         |
| Real pi tools and guards, a provider switch, compaction, recall                     | `tests/live-pi-roundtrip.test.ts`                                                                             |
| Thinking changes on a live process, read off the wire                               | `tests/live-thinking.test.ts`: haiku 4.5 and sonnet 5, four levels each on one process, and a mid-tool change |
| The in-band MCP protocol on the version floor                                       | `scripts/spikes/inband-mcp.ts` against Claude Code 2.1.265                                                    |
| The pure modules                                                                    | `npm run test:coverage`: 92% / 85% floors over five modules                                                   |

Known limits:

- **Windows is not supported.**
- **The provider has only run on macOS.** CI will run the unit tests, e2e and scenarios on Linux once the branch is pushed; none of that has run there yet.
- **On the 2.1.265 floor the three live scenarios were run**, not `tests/live-*.test.ts`.
- **The real CLI runs parallel tool calls one at a time.** It streams both `tool_use` blocks in one message but sends the second `tools/call` only after the first is answered (pi's tools carry no read-only hint). Both results are already there by then, so the second is answered at once. Calls open at the same time are exercised by the stub only (`tool-handoff-parallel`).
- **A removal is checked at the CLI, not at the model**: see spike result 9.
- **`event-bridge.ts` is still an accumulator** and session and tool-use ids are plain strings; see "What changed from the plan".

Worth doing next, in order of value:

1. **Rerun the spike's `probe` on each new Claude Code release**: the wire format is undocumented, and `applyTools` depends on the CLI listing its tools again.
2. **An OTLP exporter** (`effect/observability`'s `OtlpTracer.layer`) beside the file sink, if traces are ever wanted in a collector.

## What changed from the plan

Where the real API or the real CLI disagreed with the plan, or the owner overruled it:

- **The trace CLI is an Effect program** (`scripts/trace.ts`), by owner decision, not plain dependency-free Node.
- **Tracing is on by default** and coverage is narrowed to the pure modules, both by owner decision during the work.
- **Span events are their own records** in the trace file.
- **In-band MCP replaced the socket bridge**; every "bridge only" item is gone.
- **`expectToolCall` moved into the stdout reader**, because the `tools/call` can beat the episode to the `tool_use` block.
- **Retiring waits for the turn to end, not for an exit**, after the interrupt.
- **A parked process replaced on the spawn path is retired in the background**, not awaited.
- **Taking or launching a process is uninterruptible together with recording it**; found by a scenario.
- **The event bridge is not a reducer**; the boundary owns it in place of a `MutableRef`.
- **`Layer.withSpan` was not used for `ProviderRuntime.build`**: its span stays open for the layer's lifetime. A short span is emitted once the services are up.
- **The version check is not `Effect.cached`**, which would also remember "not installed" for the life of the runtime.
- **`Schema.UnknownFromJsonString` is internal in 4.0.3**; `Schema.fromJsonString(Schema.Unknown)` is the public spelling.
- **No custom spawner and no `cross-spawn`.** Windows support was dropped by owner decision, so Effect's Node spawner is used directly.
- **`.ts` import specifiers and `"type": "module"`**, so Node runs the TypeScript directly.
- **The CLI's presence is no longer checked at registration.** A missing or too-old CLI is an assistant error on the first call, and pi starts about 220 ms sooner.
- **More retire causes and spawn reasons** than the plan listed, so a trace says which reuse check failed.
