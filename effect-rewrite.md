Plan for rewriting the provider on Effect 4. Nothing is implemented yet.

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
| `ClaudeProcess.retire`                                                                     | `cause` (`idle`, `signature`, `history`, `failure`, `abort`, `shutdown`), `ended` (`exited`, `killed`)                                                                         |
| `ClaudeProcessPool.take` / `park`                                                          | hit or miss, idle duration                                                                                                                                                     |
| `ClaudeProcess.applyThinking`                                                              | from, to, acknowledged                                                                                                                                                         |
| `toolCall` (one per handed-off tool call)                                                  | tool-use id, tool name, outcome                                                                                                                                                |
| `ProviderRuntime.build` / `dispose`                                                        | which services came up, broker address or none                                                                                                                                 |

Rules:

- **No span or event per streamed token.** By default `episode` carries a count of wire messages by type and the time to first token as attributes, so an always-on trace stays small.
- **Wire detail is opt-in.** `PI_CLAUDE_CLI_TRACE_WIRE=1` adds one event per NDJSON line with its type; `PI_CLAUDE_CLI_TRACE_WIRE=raw` includes the line itself, for protocol debugging.
- **No content by default.** Never prompt text, tool arguments, tool results or the broker secret. Record ids, names, sizes, counts and durations. Only `WIRE=raw` breaks this, and only when asked.
- **Logs are span events.** `Logger.layer([Logger.tracerLogger])` is the only logger; see "Logging".

### Sink

A custom tracer wraps `Tracer.nativeTracer.span` and appends one NDJSON record when a span starts and one when it ends. The wrapper shape was run against 4.0.3 **(tested)**: parent ids, attributes, log events and the three statuses all come through.

```ts
{ kind: "start" | "end", name, traceId, spanId, parentSpanId, pid, timeMs,
  durMs, status: "ok" | "error" | "interrupted", error, attributes, events, links }
```

- **On by default.** With `PI_CLAUDE_CLI_TRACE` unset, records go to `<state>/traces/<YYYY-MM-DD>.ndjson`, where `<state>` is `$XDG_STATE_HOME/pi-claude-cli` or `~/.local/state/pi-claude-cli`. Any session can then be inspected after the fact, without having been started in a special way.
- **`PI_CLAUDE_CLI_TRACE=<path>`** writes to that file instead; `trace run` uses this to isolate a scenario. **`PI_CLAUDE_CLI_TRACE=off`** writes nothing.
- **Append-only**, so several pi processes share a file; every record carries the pid.
- **Private and bounded.** The directory is `0700` and files `0600`. Files older than seven days are pruned when a runtime builds.
- **Never in the way.** A failed write disables the sink for that runtime and is otherwise ignored; tracing must not be able to fail an episode.
- **Not a transcript.** Records hold no conversation content, so invariant 5 stands; the docs step states this in `AGENTS.md`.
- **Start records matter.** A span that starts and never ends is a leak (a process never retired, a scope never closed), and the CLI can only show it if the start was written.
- **Synchronous append is fine** at span boundaries: an episode has a handful of spans.

`effect/observability`'s `OtlpTracer.layer` can be added later for a real collector. It is not part of this plan.

### Trace CLI

`scripts/trace.mjs`: plain Node, no dependencies and no Effect import, so it still works when the rewrite is broken. With no `--file` it reads the default trace location, so `trace tree --last` works straight after any session.

| Command                    | Does                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `run -- <command>`         | Create a fresh trace file, set `PI_CLAUDE_CLI_TRACE`, run the command, print the tree, exit with the command's status           |
| `tree [traceId \| --last]` | Indented span tree with duration, status, attributes and inline events; open spans flagged                                      |
| `ls`                       | One line per trace: root span, start, duration, status                                                                          |
| `spans`                    | Filter by `--name`, `--status`, `--attr k=v`; `--json` for piping                                                               |
| `open`                     | Spans that started and never ended                                                                                              |
| `tail`                     | Follow the file live                                                                                                            |
| `stats`                    | Count and p50 / max duration by span name                                                                                       |
| `assert`                   | Exit non-zero unless the trace matches: `--name`, `--count`, `--status`, `--attr k=v`, `--max-ms`, `--no-open`, `--order a,b,c` |

`assert` is what replaces test assertions. Build the CLI against a ten-line Effect sample program using the same sink, so it is usable before the first service exists.

### Verification by scenario

A scenario runs real code: real `pi` with the stub CLI (`tests/e2e/claude-stub.cjs`, extended as needed) where pi can drive it, and a small driver that calls the provider's `streamSimple` directly for multi-call sequences print mode cannot express. Each scenario is `trace run` followed by `trace assert`, kept as a script under `scripts/scenarios/` so it can be re-run.

| Scenario                                                   | The trace must show                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Fresh spawn                                                | `episode` with `mode=spawn`, `outcome=done`; one `ClaudeCli.spawn`; one `park`                                             |
| Warm turn                                                  | Second `episode` with `mode=turn`; no `ClaudeCli.spawn`; same pid                                                          |
| Tool handoff                                               | `outcome=toolUse`; `park` at the handoff idle time; next `episode` with `mode=handoff`, same pid; `toolCall` ok            |
| Changed history, prompt, tools, or a foreign-provider turn | `mode=spawn` with the matching `spawnReason`; the old process retired with the matching `cause`                            |
| Thinking change                                            | `applyThinking` acknowledged and no spawn; a refusal leads to a spawn                                                      |
| Abort mid-stream                                           | `episode` interrupted; `outcome=aborted` within milliseconds; `retire` with `cause=abort` ending afterwards; no open spans |
| Inactivity timeout                                         | `outcome=error`; process killed                                                                                            |
| Process dies mid-turn                                      | `outcome=error` carrying the stderr tail; nothing parked                                                                   |
| Idle expiry                                                | `retire` with `cause=idle` at the keepalive (set short through env)                                                        |
| `session_shutdown`                                         | `ProviderRuntime.dispose`; no open spans; runtime directory gone; print mode exits                                         |
| Layer build failure                                        | An `error` terminal event; no hang                                                                                         |
| Env stripping                                              | The stub reports no `ANTHROPIC_*` variables                                                                                |
| Live, spends tokens                                        | One turn, one tool call, one warm follow-up                                                                                |

What this means for the test suite:

- **Keep** the existing unit tests for modules that stay pure: `pi-context`, `thinking-config`, `overflow`, `tool-mapping`, and the `event-bridge` reducer.
- **Delete** the tests of deleted modules. Do not port them, and do not write new unit or integration tests for the Effect services; scenarios cover them.
- **No `@effect/vitest` and no vitest upgrade.** Scenarios use short timeouts set through env instead of `TestClock`.
- **Coverage covers what unit tests cover.** Narrow coverage `include` in `vitest.config.ts` to the pure modules and keep the 92% / 85% floors on them. A gate that can never pass gets ignored; this one stays meaningful.
- **Scenarios are the gate for the services.** `npm run test:scenarios` runs every stub scenario and fails if any `trace assert` fails. It joins the command list in `AGENTS.md`.

## Decide the tool bridge first

Today a tool call leaves the CLI through `mcp-schema-server.cjs`, a unix socket, a shared secret and a handoff broker. Claude Code can instead host an MCP server in-band over the stdio control channel (`"type": "sdk"`, the Agent SDK's mechanism).

**Tested, with no model call:** 2.1.292, launched with this project's flags and `--mcp-config '{"mcpServers":{"custom-tools":{"type":"sdk","name":"custom-tools"}}}'`, sent `initialize`, `notifications/initialized` and `tools/list` as `control_request {subtype: "mcp_message"}` on stdout. `mcp_status` then reported the server connected with the probe tool. Probe: `/tmp/effect-audit/scratch/sdk-probe.mjs`.

**Not tested** (the spike; needs one live turn):

1. A `tools/call` round trip, held open while pi runs the tool.
2. Whether the call carries the tool-use id (`_meta["claudecode/toolUseId"]`).
3. What the CLI sends when the turn is interrupted mid-call.
4. Whether the call has a timeout, and whether `MCP_TOOL_TIMEOUT` governs it.
5. The same on the 2.1.263 floor.
6. Whether the `initialize` control request the probe sent is required.
7. `mcp_set_servers` (present in the binary): can it change the tool surface on a live process?

If the spike passes, a tool call is one more control request the stdout reader already handles, answered by completing a `Deferred`. The rest of this plan marks what that removes as **bridge only**:

- `mcp-schema-server.cjs` and the `node` child per CLI process
- `HandoffBroker`, the socket, the shared secret and its file
- `ToolSchemaStore` and the per-process `--mcp-config` file
- `SocketServer`, `NodeSocketServer`, `RcMap`, `Redacted`, `timingSafeEqual`

`RuntimeDirectory` would then hold only the system prompt file.

## Lifetimes as scopes

```text
runtime scope                      one ManagedRuntime per extension instance
├── TraceSink                      tracer + tracerLogger; writes unless PI_CLAUDE_CLI_TRACE=off
├── RuntimeDirectory               0700 temp dir, removed on close
├── HandoffBroker                  bridge only: socket + secret file
├── ToolSchemaStore                bridge only: content-addressed schema files
└── ClaudeProcessPool
    └── process scope              Scope.fork(runtime), closed by retire
        ├── mcp-config file        bridge only
        ├── child process          finalizer: see "Retiring a process"
        ├── stdout reader fiber    answers control requests, fills inbox
        ├── stdin writer fiber     drains one outbound Queue
        ├── stderr tail            last 64 KiB
        ├── idle timer             FiberHandle; re-parking replaces it
        └── broker registration    bridge only

episode scope                      one pi call, Effect.scoped
├── system prompt file             makeTempFileScoped
├── inactivity timeout
└── borrows one process scope; on exit: park it or close it
```

The process scope is deliberately not a child of the episode scope; that is the one place needing explicit `Scope.fork` / `Scope.close` instead of `Effect.scoped`.

### The runtime belongs to the extension instance

pi calls the extension factory once per session (`/new`, `/resume`, `/fork`, `/reload` each tear down and re-create), and emits `session_shutdown` before each teardown and on quit. So:

- Create the runtime inside the factory, lazily on the first model call.
- Dispose it on `session_shutdown`. A disposed runtime cannot be reused **(tested)**, so the handler clears the reference and the next call builds a fresh one.
- `session_start`, `model_select`, `session_tree` and `session_compact` call `pool.retireAll` only.

This is required, not tidy-up. pi's print mode exits by letting the event loop drain (`main.js` sets `process.exitCode` and returns). Effect timers are not `unref`'d, and `NodeSocketServer` hides its `net.Server`, so neither can be `unref`'d the way today's are. Disposing on `session_shutdown` is what lets print mode exit. `beforeExit` is not a usable hook: it only fires once the loop is already empty.

Keep every layer infallible. A failed layer build is memoized: it is attempted once and every later call fails the same way **(tested)**. A broker that cannot bind yields `Option.none`, not a failure.

## The pi boundary and abort

pi needs the stream returned synchronously. `index.ts` stays free of Effect imports and loads the runtime on the first model call, because a top-level `import "effect"` costs about 135 ms and 60 MB RSS on every pi start **(tested)**, used or not.

```ts
// index.ts, inside the factory
let loaded: Promise<ProviderRuntime> | undefined;
const provider = () =>
  (loaded ??= import("./src/provider-runtime.js").then((m) => m.make()));

const streamSimple = (model, context, options) => {
  const piStream = createAssistantMessageEventStream();
  provider().then(
    (p) => p.startEpisode(piStream, model, context, options),
    (err) => failStream(piStream, model, err),
  );
  return piStream;
};

pi.on("session_shutdown", async () => {
  const current = loaded;
  loaded = undefined;
  await (await current)?.dispose();
});
```

```ts
// src/provider-runtime.ts
startEpisode: (piStream, model, context, options) => {
  const partial = MutableRef.make(emptyAssistantMessage(model));
  runtime.runCallback(runEpisode(model, context, options, piStream, partial), {
    signal: options?.signal, // abort = fiber interruption
    onExit: (exit) => pushTerminalEvent(piStream, partial, exit),
  });
};
```

The terminal event is pushed from `runCallback`'s `onExit`, not from an `Effect.onExit` inside `runEpisode`. If the runtime fails to build, `runEpisode` never starts and its own exit handler never runs, leaving pi's stream open forever **(tested)**. The boundary `onExit` also covers defects and an already-aborted signal, which arrives as an interrupt-only cause **(tested)**. It replaces the `streamEnded` guard: one fiber, one exit, one of `done`, `error` or `aborted`.

`partial` is a `MutableRef` owned by the boundary, so the plain `onExit` callback can read what was already streamed.

Check the dynamic import under pi's bundled jiti before relying on it; the load cost was measured with jiti 2.7.0 and pi's options, not through pi.

## State that becomes Effect primitives

| Today                                                                                               | Effect                                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sink` + `buffer` + `attach`/`detach`                                                               | One `Queue.sliding<CliMessage, ProcessExited>(20_000)` inbox per process; an episode takes from it, so buffering during a handoff gap needs no code |
| `onClose` / `onError` sink callbacks                                                                | `Queue.fail(inbox, ProcessExited)`; buffered lines drain before the failure surfaces **(tested)**                                                   |
| `awaiting` / `pending` / `ready` maps                                                               | One `Deferred<HandoffResult>` per tool-use id, created by `expectToolCall`; the call awaits it, pi's result completes it, in either order           |
| `controlWaiters` + 5 s timer                                                                        | `Deferred<boolean>` per request id, with `Effect.timeout`                                                                                           |
| Inactivity `setTimeout` reset per line                                                              | `Queue.take(inbox).pipe(Effect.timeoutOrElse(...))`; a timed-out take loses nothing **(tested)**                                                    |
| `retire()` grace timers (2 s, 500 ms)                                                               | Process-scope finalizer; see "Retiring a process"                                                                                                   |
| `activeProcesses` + `killAllProcesses`                                                              | Gone; every process scope is a child of the runtime scope                                                                                           |
| Idle timer per parked process                                                                       | `FiberHandle` inside the process scope; `run` interrupts the previous timer, and retiring the process removes it                                    |
| `parked` map                                                                                        | `SynchronizedRef<HashMap<PiSessionId, ParkedProcess>>`                                                                                              |
| `process.env` reads scattered across files                                                          | One `Config` struct, read once; see "Config"                                                                                                        |
| `any` NDJSON messages                                                                               | `Schema` union decoded at the stdout boundary; see "Decoding stdout"                                                                                |
| `execSync("claude --version")` on every spawn; `claude auth status` blocking startup (about 220 ms) | `Effect.cached` version check; auth check forked at first use                                                                                       |
| `addUsage` / `maxUsage`                                                                             | `Struct.makeReducer` with `Number.ReducerSum` / `ReducerMax`                                                                                        |
| `Date.now()` and `Math.random()` in ids and timestamps                                              | `Clock` and `Crypto`, so tests are deterministic                                                                                                    |
| `console.warn` / `console.error`                                                                    | `Effect.log*`, recorded as span events; see "Logging"                                                                                               |

Take from the inbox one message at a time with `Queue.take`. Do not consume it through `Stream.fromQueue`: that pulls with `takeAll`, so an episode that ends mid-batch would drop lines belonging to the next episode.

### Retiring a process

Two finalizers, run in this order:

1. Ours, registered after the spawn so it runs first: if a turn is live, write the interrupt and wait up to 2 s for exit; then `Queue.end(outbound)`, which closes the child's stdin **(tested)**, and wait up to 500 ms.
2. The spawner's own: signal whatever is still running. Spawn with `killSignal: "SIGKILL"` so this matches today's last step.

### Decoding stdout

Use `Stream.decodeText` + `Stream.splitLines`, then a lenient per-line decode: skip lines that do not start with `{`, and treat a failed decode as an ignored envelope. Lines arrive one per write, with no batching **(tested)**.

- Do not use `encoding/Ndjson` here. One unparseable line fails the whole channel, and the CLI prints non-JSON debug lines.
- The wire format is undocumented and changes. The inner `event` union needs its own catch-all, so a new delta type degrades to "ignored" and never fails an episode.
- Decode synchronously (`Schema.decodeUnknownOption`) on this path; it runs once per streamed token.

### Config

`Config` fails on an invalid value; today an unparseable `PI_CLAUDE_CLI_TIMEOUT_MS` silently falls back to the default. `Config.withDefault` covers only a missing value. Decide per variable whether to stay lenient (`Config.orElse`) or surface the mistake as an assistant error. `PI_CLAUDE_CLI_KEEPALIVE_MS` also accepts `off`, `false` and `none`, which needs a custom `Config.schema`.

Scenarios set real env vars. Any unit test that needs config supplies it through `ConfigProvider.fromEnvRecord` instead of mutating `process.env`.

### Logging

The default Effect logger writes to stdout through `console.log`, which would corrupt pi's RPC protocol and TUI. Replace it in the provider layer with `Logger.layer([Logger.tracerLogger])` and no console logger.

Every `Effect.log*` call then becomes an event on the current span **(tested)**, so logs appear in the trace in order, under the operation that produced them. There is no separate log file.

## Where RcMap fits, and where it doesn't

- **Not the process pool.** `RcMap` derives a resource from its key alone and shares it. A parked process depends on the request (signature, acknowledged history), is exclusive, and has an idle time that depends on why it was parked (10 minutes after a turn, 30 minutes in a handoff). 4.0.3's per-key `idleTimeToLive` does not change this.
- **Yes for `ToolSchemaStore`, bridge only.** `RcMap<ToolSurfaceJson, SchemaFile>`, acquired in each process scope. Schema files are then deleted when the last process using them retires, instead of accumulating until exit. The content hash can replace the `version` counter in the launch signature.

## Services

```ts
interface IClaudeProcess {
  // a scoped value, not a contextual service
  readonly inbox: Queue.Dequeue<CliMessage, ProcessExited>;
  readonly writeUser: (blocks: UserContent) => Effect.Effect<void, ProcessGone>;
  readonly interruptTurn: Effect.Effect<void>;
  readonly applyThinking: (t: CliThinking) => Effect.Effect<boolean>;
  readonly expectToolCall: (
    id: ToolUseId,
    name: PiToolName,
  ) => Effect.Effect<void>;
  readonly answerToolCall: (
    id: ToolUseId,
    r: HandoffResult,
  ) => Effect.Effect<void>;
  readonly acknowledged: Ref.Ref<Option.Option<HistoryCheckpoint>>;
  readonly retire: Effect.Effect<void>; // closes the process scope
}

interface IClaudeProcessPool {
  readonly take: (
    id: PiSessionId,
  ) => Effect.Effect<Option.Option<IClaudeProcess>>;
  readonly park: (
    id: PiSessionId,
    p: IClaudeProcess,
    idle: Duration.Duration,
  ) => Effect.Effect<void>;
  readonly retireAll: Effect.Effect<void>;
}

interface IHandoffBroker {
  // bridge only
  readonly address: Option.Option<SocketPath>; // none = interrupt-and-reimport fallback
  readonly register: (
    id: CliSessionId,
    route: HandoffRoute,
  ) => Effect.Effect<void, never, Scope.Scope>;
}
```

`ClaudeCli` wraps `ChildProcessSpawner` (launch flags, env stripping, version and auth checks). `ProviderConfig`, `RuntimeDirectory` and, on the bridge route, `ToolSchemaStore` are the remaining services.

### Spawning

- **Env stripping.** `extendEnv: true` with `env: { ANTHROPIC_API_KEY: undefined, ... }` removes the variables from the child **(tested)**. Keep a test that reads the child's real environment; this is invariant 6.
- **`detached: false`, explicitly.** Effect defaults to `detached: true` off Windows, which puts the child in its own process group **(tested)**. Ctrl-C in `pi -p` would then no longer reach `claude`. With `false`, the spawner's group kill fails and falls back to a plain kill.
- **Windows.** Effect's spawner calls `child_process.spawn` directly and does not resolve `claude.cmd`. `shell: true` is not a fix: it drops empty arguments, turning `--tools "" --setting-sources ""` into `--tools --setting-sources` **(tested)**. Keep `cross-spawn` behind a custom `ChildProcessSpawner` layer; `ChildProcessSpawner.make` and `makeHandle` are exported for this. The same seam gives tests a fake spawner.

## The episode

```text
runEpisode(model, context, options, piStream, partial)
  request   = normalize pi context
  parked    = pool.take(sessionId)
  mode      = decide(parked, request)            # pure: spawn | turn | handoff
  process   = mode is spawn ? retire parked, ClaudeCli.spawn, write full history
                            : parked
  mode is turn    → applyThinking, writeUser(delta)
  mode is handoff → answerToolCall for each tool result
  loop take inbox (with inactivity timeout)
    stream_event → reduce bridge state into partial, push pi events,
                   expectToolCall on tool_use
    message_stop with tool call
      handoff on  → return HandedOff
      handoff off → interruptTurn, keep reading for result
    result       → apply usage, return TurnEnded | fail CliResultError
  on exit (inside the fiber)
    HandedOff → park(30 min)      TurnEnded → park(keepalive) or retire
    failure / interrupt → fork retire into the runtime scope, do not await it
  then the boundary onExit pushes exactly one of done | error | aborted
```

Two ordering rules:

- **Park before the fiber exits.** `done` is pushed after exit, so the process is already parked when pi issues the next call.
- **Never await a retire on the failure or abort path.** Retiring can take 2.5 s; awaiting it would delay `aborted` by that long. Today's code pushes first and retires in the background, and this keeps that.

## File layout

```text
index.ts                      # pi registration, lazy import, session_shutdown → dispose
src/
├── provider-runtime.ts       # ManagedRuntime, provider layer, startEpisode
├── tracing.ts                # file tracer, tracerLogger layer
├── provider-config.ts        # Config
├── errors.ts                 # tagged errors
├── cli-protocol.ts           # Schema for the NDJSON wire format
├── runtime-directory.ts      # service
├── claude-cli.ts             # service (ChildProcessSpawner)
├── cross-spawn-spawner.ts    # ChildProcessSpawner layer over cross-spawn
├── claude-process.ts         # scoped process resource
├── claude-process-pool.ts    # service
├── episode.ts                # runEpisode
├── event-bridge.ts           # reducer: (state, event) → [state, piEvents]
├── pi-context.ts, thinking-config.ts, overflow.ts, tool-mapping.ts   # stay pure
│
│   bridge only:
├── tool-schema-store.ts      # service (RcMap)
├── handoff-broker.ts         # service (socket server)
└── mcp-schema-server.cjs     # unchanged
```

On the in-band route, add `mcp-inband.ts` (answers `initialize`, `tools/list`, `tools/call`, typed with `effect/ai/McpSchema`) in place of the three bridge files.

## Module inventory

Import paths are for 4.0.3: `effect/process`, `effect/socket`, `effect/encoding`, with no `unstable/` prefix. They are still annotated unstable, as is `Crypto`.

- **Core, heavy use:** `Effect`, `Layer`, `Context`, `Scope`, `ManagedRuntime`, `Exit`, `Cause`, `Fiber`, `Deferred`, `Queue`, `Ref`, `SynchronizedRef`, `Stream`, `Schema`, `Config`, `Duration`, `Option`, `Data`.
- **Core, one specific job:**
  - `FiberHandle`: idle timer per process
  - `MutableRef`: the partial message
  - `HashMap`: the parked map
  - `FileSystem`: `makeTempDirectoryScoped`, `makeTempFileScoped`, `writeFileString` with `mode`
  - `Path`
  - `Crypto`: UUID, digest
  - `Clock`: timestamps
  - `Tracer`: the file sink; see "Tracing and verification"
  - `Logger`: `tracerLogger` only
  - `ConfigProvider`: tests
  - `Struct` + `Number` reducers: usage arithmetic
  - `Match`: mode decision
- **Process:** `effect/process` `ChildProcess` + `ChildProcessSpawner`.
- **Bridge only:** `RcMap`, `effect/socket`, `Redacted`, `Crypto` random bytes.
- **In-band route only:** `effect/ai/McpSchema`.
- **Node platform:** `@effect/platform-node-shared`, not `@effect/platform-node`. The shared package has every layer needed (spawner, filesystem, path, crypto, socket server) and depends only on `ws`. `@effect/platform-node` adds `undici` and a non-optional `redis` peer, which would land in every pi install. Its `NodeServices.layer` is a plain merge that is easy to write by hand.
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

- **`index.ts`.** Registration, the lazy import and the `session_shutdown` handler; see "The pi boundary and abort".
- **`mcp-schema-server.cjs`, bridge only.** The CLI starts it with plain `node` once per process. It has no dependencies, and this package has no build step, so an Effect/TypeScript entry point could not be launched that way.
- **A synchronous `process.on("exit")` fallback.** Effect finalizers cannot run there; keep a small `rmSync` + SIGKILL last resort. Register it once per runtime and remove it on dispose, so `/reload` does not accumulate listeners.
- **The bridge socket, if kept.** `NodeSocketServer` cannot be `unref`'d or capped at a request size. Either accept that (dispose on `session_shutdown` covers exit) or own a `node:net` server in `Effect.acquireRelease`.
- **Constant-time secret comparison, bridge only.** `Crypto` has no equivalent, so `node:crypto`'s `timingSafeEqual` stays.

## Things to verify before committing

1. **The in-band MCP spike.** It decides whether the bridge services are built at all.
2. **Dynamic import under pi's bundled jiti.**
3. **Windows launch**, through the `cross-spawn` spawner layer.
4. **Print mode exits** after a turn with a parked process and, on the bridge route, a live socket.
5. **Every scenario** in "Verification by scenario" passes its `trace assert` (`npm run test:scenarios`).
6. **Coverage** passes on the narrowed `include`. 6,784 lines of tests are built on mock `ChildProcess` objects and fake timers; most go away with the modules they test.

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
