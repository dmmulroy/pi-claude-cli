/**
 * One Claude CLI process that outlives a single pi call.
 *
 * Spawning is expensive: a fresh process must be handed pi's whole history
 * again, and that import misses the prompt cache. A process therefore stays
 * alive through a tool call (the CLI blocks on the in-band `tools/call`
 * while pi runs the tool) and between turns (parked in the pool).
 *
 * Everything the process owns lives in its own scope: the child, the stdout
 * and stderr readers, the stdin writer, the idle timer and the open tool
 * calls. `retire` closes that scope, and nothing else cleans up.
 *
 * Lines that arrive while no episode is reading sit in the inbox, so the next
 * episode sees the stream as if it were live. Permission and MCP requests
 * are answered here, by the reader, whether or not an episode is attached:
 * the CLI must never wait on one.
 */

import {
  type Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberMap,
  HashMap,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
  type Tracer,
} from "effect";
import { ClaudeCli } from "./claude-cli.ts";
import {
  assistantReplayLine,
  type ClaudeRateLimitInfo,
  type CliMessage,
  type CliUserContentBlock,
  controlRequestLine,
  decodeCliLine,
  type JsonRpcId,
  mcpNotificationAckLine,
  mcpResponseLine,
  mcpServerNotificationLine,
  toolPermissionResponseLine,
  userMessageLine,
} from "./cli-protocol.ts";
import { supportsStructuredImport } from "./cli-requirements.ts";
import type { HistoryCheckpoint, LaunchSignature } from "./episode-mode.ts";
import { ProcessExited, ProcessGone } from "./errors.ts";
import {
  INBAND_MCP_SERVER_NAME,
  MCP_TOOLS_CHANGED_METHOD,
  type McpToolDefinition,
  type McpToolResult,
  mcpServerAction,
  mcpToolCallResponse,
  mcpToolErrorResult,
} from "./mcp-inband.ts";
import { type CliThinking, type ThinkingControl, thinkingControls } from "./thinking-config.ts";
import { isHandoffClaudeTool, mapClaudeToolNameToPi } from "./tool-mapping.ts";
import type { CliReplayFrame } from "./pi-context.ts";
import { recordSpanEvent } from "./tracing.ts";
import { type TokenUsage, ZERO_TOKEN_USAGE } from "./usage.ts";

/** Why a process was retired. */
export type RetireCause =
  /** Parked and nobody came back within the idle time. */
  | "idle"
  /** The next call's model, prompt or launch settings differ. */
  | "signature"
  /** pi's history is not the one the process acknowledged. */
  | "history"
  /** The process refused a thinking change. */
  | "thinking"
  /** The process did not list its tools again after a tool change. */
  | "tools"
  /** It did not take a structured history import. */
  | "import"
  /** The episode it was serving failed. */
  | "failure"
  /** It stopped writing to stdout; killed without a grace period. */
  | "timeout"
  /** pi aborted the episode it was serving. */
  | "abort"
  /** Its turn was interrupted at a tool call (handoff proxy off). */
  | "interrupted"
  /** Its turn ended and nothing parks it (no pi session, or keepalive off). */
  | "unparked"
  /** Another process was parked for the same pi session. */
  | "replaced"
  /** The process ended on its own. */
  | "exited"
  /** A pi lifecycle event or the runtime's disposal. */
  | "shutdown";

/** A limit status the CLI reported, and when it arrived. */
export interface ReportedRateLimit {
  readonly info: ClaudeRateLimitInfo;
  readonly reportedAtMillis: number;
}

/** What a process is launched with. */
export interface ClaudeProcessLaunch {
  readonly cliSessionId: string;
  readonly modelId: string;
  readonly systemPromptFile: string;
  readonly cwd: string;
  readonly thinking: CliThinking;
  /** What a later call must match to reuse the process. */
  readonly signature: LaunchSignature;
  /** True holds a tool call open for pi; false denies it so the turn can be interrupted. */
  readonly allowHandoff: boolean;
  /** pi's tools at launch, as the in-band MCP server lists them. */
  readonly tools: ReadonlyArray<McpToolDefinition>;
  /**
   * Record every stdout line on the process span, content included. Protocol
   * debugging only (`PI_CLAUDE_CLI_TRACE_WIRE=raw`).
   */
  readonly traceRawWire: boolean;
}

/** A live Claude CLI process. A scoped value, not a contextual service. */
export interface IClaudeProcess {
  readonly cliSessionId: string;
  readonly pid: number;
  readonly signature: LaunchSignature;
  readonly allowHandoff: boolean;
  /** The process's lifetime span, for linking from the episodes that borrow it. */
  readonly span: Tracer.Span;
  /**
   * The CLI's stdout, one decoded message at a time. Fails with
   * `ProcessExited` once the process has ended and the buffer is drained.
   */
  readonly inbox: Queue.Dequeue<CliMessage, ProcessExited>;
  /** The pi history this process has seen, set after each successful episode. */
  readonly acknowledged: Ref.Ref<Option.Option<HistoryCheckpoint>>;
  /** `result.modelUsage` of the previous result; it is cumulative for the process. */
  readonly lastProcessTotals: Ref.Ref<TokenUsage>;
  /** Usage earlier episodes of the current turn already handed to pi. */
  readonly turnReported: Ref.Ref<TokenUsage>;
  /** The pool's idle timer; lives and dies with the process. */
  readonly idleTimer: FiberHandle.FiberHandle<void>;
  readonly isAlive: Effect.Effect<boolean>;
  /**
   * When the CLI last wrote a line to stdout, of any kind: stream events,
   * control traffic the reader answers itself, and lines that are not JSON.
   */
  readonly lastOutputAtMillis: Effect.Effect<number>;
  /** A user message has been written and no `result` has followed yet. */
  readonly isTurnActive: Effect.Effect<boolean>;
  /** The thinking the process's current or next turn runs at. */
  readonly thinking: Effect.Effect<CliThinking>;
  /**
   * The subscription's limit status the CLI last reported, set by the stdout
   * reader as it arrives: after an API call's `message_stop`, which may be
   * after the episode that streamed the call has handed off.
   */
  readonly rateLimit: Effect.Effect<Option.Option<ReportedRateLimit>>;
  /** Start a turn. Fails with `ProcessGone` when the process has ended. */
  readonly writeUser: (
    content: ReadonlyArray<CliUserContentBlock>,
  ) => Effect.Effect<void, ProcessGone>;
  /** True when the CLI is a version known to take a structured history. */
  readonly takesStructuredImport: boolean;
  /**
   * Give a fresh process pi's history as the messages themselves and start
   * the turn with the last one. Every user message before the last is held
   * (the CLI adds it without asking the model) and awaited, so the order on
   * the wire is the order given.
   *
   * @returns False when the CLI did not take the history as sent: it asked
   *   the model about a held message, or did not confirm one in time. The
   *   process is then in an unknown state and the caller retires it.
   */
  readonly importHistory: (
    frames: ReadonlyArray<CliReplayFrame>,
  ) => Effect.Effect<boolean, ProcessGone>;
  /** Ask the CLI to end the running turn, as Esc does. */
  readonly interruptTurn: Effect.Effect<void>;
  /**
   * Move the process to `desired` thinking before its next user turn. False
   * means it cannot take the change in place; the caller spawns instead.
   */
  readonly applyThinking: (desired: CliThinking) => Effect.Effect<boolean>;
  /**
   * Make `desired` the tools the model is offered from its next request on,
   * mid-turn included. False means the CLI did not ask for the new list; the
   * caller spawns instead.
   */
  readonly applyTools: (desired: ReadonlyArray<McpToolDefinition>) => Effect.Effect<boolean>;
  /** True when pi's results for exactly these tool calls can continue the turn. */
  readonly awaitsToolCalls: (toolUseIds: ReadonlyArray<string>) => Effect.Effect<boolean>;
  /** Deliver pi's result; answers the CLI now or when its `tools/call` arrives. */
  readonly answerToolCall: (toolUseId: string, result: McpToolResult) => Effect.Effect<void>;
  /** End the process for good and release everything it owns. Idempotent. */
  readonly retire: (cause: RetireCause) => Effect.Effect<void>;
  /** Completes once `retire` has finished. */
  readonly awaitRetired: Effect.Effect<void>;
}

/** Cap on undelivered stdout lines before the oldest are dropped. */
const INBOX_CAPACITY = 20_000;
/** Ceiling on captured stderr: only the most recent output explains a failure. */
const STDERR_TAIL_LIMIT_CHARS = 64 * 1024;
/** Grace for the CLI to end an interrupted turn before stdin is closed. */
const INTERRUPT_GRACE = Duration.seconds(2);
/** Grace after closing stdin before a still-running CLI is killed. */
const EXIT_GRACE = Duration.millis(500);
/** How long a control request of ours may take to be acknowledged. */
const CONTROL_TIMEOUT = Duration.seconds(5);
/**
 * How long the CLI may take to ask for `tools/list` after being told the
 * tools changed. It asks within milliseconds or, on a CLI that ignores the
 * notification, never.
 */
const TOOLS_RELIST_TIMEOUT = Duration.seconds(3);
/**
 * How long the CLI may take to confirm one held message of a history import.
 * The first one also waits for the CLI to start; the rest take milliseconds.
 */
const IMPORT_HOLD_TIMEOUT = Duration.seconds(20);
/** How long stdout EOF waits for the exit code and the last of stderr. */
const EXIT_REPORT_GRACE = Duration.millis(500);

const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
const UNMATCHED_CALL_MESSAGE = "pi could not match this tool call to an assistant tool_use block";

/** One `tool_use` block the model streamed and pi is expected to answer. */
interface ExpectedToolCall {
  /** The pi tool the model asked for. */
  readonly name: string;
  /** pi's result; completed by `answerToolCall` or when the turn ends. */
  readonly result: Deferred.Deferred<McpToolResult>;
}

/**
 * Launch a CLI process whose scope is a child of `runtimeScope`, so the
 * runtime's disposal ends it, and which `retire` closes.
 *
 * @returns The live process, or the launch failure of `ClaudeCli.spawn`; a
 *   failed launch leaves nothing behind.
 */
export const launchClaudeProcess = Effect.fn("ClaudeProcess.launch")(function* (
  launch: ClaudeProcessLaunch,
  runtimeScope: Scope.Scope,
) {
  const scope = yield* Scope.fork(runtimeScope);
  return yield* startClaudeProcess(launch, scope, runtimeScope).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );
});

const startClaudeProcess = Effect.fnUntraced(function* (
  launch: ClaudeProcessLaunch,
  scope: Scope.Closeable,
  runtimeScope: Scope.Scope,
) {
  const cli = yield* ClaudeCli;

  const span = yield* Effect.makeSpanScoped("ClaudeProcess", {
    root: true,
    attributes: { cliSession: launch.cliSessionId },
  });
  const inbox = yield* Queue.sliding<CliMessage, ProcessExited>(INBOX_CAPACITY);
  const outbound = yield* Queue.unbounded<string, Cause.Done>();
  const alive = yield* Ref.make(true);
  const turnActive = yield* Ref.make(false);
  const turnEnded = yield* Ref.make(yield* Deferred.make<void>());
  const thinking = yield* Ref.make(launch.thinking);
  const rateLimit = yield* Ref.make(Option.none<ReportedRateLimit>());
  const tools = yield* Ref.make(launch.tools);
  /** Completed by the next `tools/list` the CLI sends. */
  const toolsRelisted = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
  const stderrTail = yield* Ref.make("");
  const expected = yield* Ref.make(HashMap.empty<string, ExpectedToolCall>());
  /**
   * The fiber holding each `tools/call` open until pi answers it, by its
   * JSON-RPC id. A fiber leaves the map when it ends; retiring interrupts
   * whatever is left before the CLI is asked to exit.
   */
  const openCalls = yield* FiberMap.make<JsonRpcId>();
  const controlWaiters = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<boolean>>());
  const controlSequence = yield* Ref.make(0);
  const retiring = yield* Ref.make(false);
  const retired = yield* Deferred.make<void>();
  const killWithoutGrace = yield* Ref.make(false);
  const lastOutputAt = yield* Ref.make(yield* Clock.currentTimeMillis);
  /**
   * The held message of a history import the CLI has not confirmed yet.
   * Completed with true by the empty `result` that confirms it, and with
   * false by anything that shows the CLI is answering it instead.
   */
  const heldMessage = yield* Ref.make(Option.none<Deferred.Deferred<boolean>>());
  const settleHeldMessage = (taken: boolean) =>
    Effect.gen(function* () {
      const held = yield* Ref.getAndSet(heldMessage, Option.none());
      if (Option.isSome(held)) yield* Deferred.succeed(held.value, taken);
      return Option.isSome(held);
    });
  const endedBy = yield* Ref.make<"exited" | "killed">("exited");

  const handle = yield* cli.spawn({
    cliSessionId: launch.cliSessionId,
    modelId: launch.modelId,
    systemPromptFile: launch.systemPromptFile,
    cwd: launch.cwd,
    thinking: launch.thinking,
    stdin: Stream.fromQueue(outbound).pipe(Stream.encodeText),
  });
  const pid = Number(handle.pid);
  span.attribute("pid", pid);

  const write = (line: string) => Effect.asVoid(Queue.offer(outbound, line));
  const isRunning = handle.isRunning.pipe(Effect.orElseSucceed(() => false));

  // ---- tool calls ----------------------------------------------------------

  const endTurn = Effect.gen(function* () {
    yield* Ref.set(turnActive, false);
    yield* Deferred.succeed(yield* Ref.get(turnEnded), undefined);
  });

  /** Answer every tool call pi has not answered; nothing can deliver them now. */
  const failExpectedToolCalls = (message: string) =>
    Effect.gen(function* () {
      const calls = yield* Ref.getAndSet(expected, HashMap.empty());
      for (const call of HashMap.values(calls))
        yield* Deferred.succeed(call.result, mcpToolErrorResult(message));
    });

  const respondToToolCall = (requestId: string, id: JsonRpcId, result: McpToolResult) =>
    write(mcpResponseLine(requestId, mcpToolCallResponse(id, result)));

  /**
   * The model's `tools/call`. It must name a `tool_use` block this process
   * streamed and has not answered, and the tool that block asked for;
   * anything else is refused at once so the CLI never waits on a call pi
   * will not run.
   */
  const handleToolCall = Effect.fnUntraced(function* (
    requestId: string,
    id: JsonRpcId,
    call: Option.Option<{
      readonly name: string;
      readonly toolUseId: Option.Option<string>;
    }>,
  ) {
    const refuse = (message: string) =>
      respondToToolCall(requestId, id, mcpToolErrorResult(message));
    if (Option.isNone(call)) return yield* refuse("malformed tool call");
    if (!launch.allowHandoff) return yield* refuse(TOOL_EXECUTION_DENIED_MESSAGE);
    const calls = yield* Ref.get(expected);
    // No id tag: fall back to the single awaited call if that is unambiguous.
    const toolUseId = Option.orElse(call.value.toolUseId, () =>
      HashMap.size(calls) === 1
        ? Option.fromUndefinedOr([...HashMap.keys(calls)][0])
        : Option.none(),
    );
    const entry = Option.flatMap(toolUseId, (key) => HashMap.get(calls, key));
    if (Option.isNone(toolUseId) || Option.isNone(entry))
      return yield* refuse(UNMATCHED_CALL_MESSAGE);
    if (entry.value.name !== call.value.name)
      return yield* refuse(
        `pi refused this tool call: tool_use ${toolUseId.value} asked for "${entry.value.name}", not "${call.value.name}"`,
      );

    const answer = Effect.gen(function* () {
      const result = yield* Deferred.await(entry.value.result);
      yield* respondToToolCall(requestId, id, result);
      yield* Effect.annotateCurrentSpan({
        outcome: result.isError ? "toolError" : "ok",
      });
    }).pipe(
      Effect.ensuring(Ref.update(expected, HashMap.remove(toolUseId.value))),
      Effect.withSpan("toolCall", {
        parent: span,
        attributes: { toolUseId: toolUseId.value, tool: entry.value.name },
      }),
    );
    yield* FiberMap.run(openCalls, id, answer);
  });

  const handleMcpRequest = Effect.fnUntraced(function* (
    message: Extract<CliMessage, { readonly _tag: "McpRequest" }>,
  ) {
    const action = mcpServerAction(
      message.message,
      message.serverName === INBAND_MCP_SERVER_NAME ? yield* Ref.get(tools) : [],
    );
    switch (action._tag) {
      case "ListTools": {
        yield* write(mcpResponseLine(message.requestId, action.response));
        const waiting = yield* Ref.getAndSet(toolsRelisted, Option.none());
        if (Option.isSome(waiting)) yield* Deferred.succeed(waiting.value, undefined);
        return;
      }
      case "Respond":
        return yield* write(mcpResponseLine(message.requestId, action.response));
      case "Acknowledge":
        return yield* write(mcpNotificationAckLine(message.requestId));
      case "CancelCall": {
        // The CLI gave up on the call (interrupt, or its own timeout).
        yield* FiberMap.remove(openCalls, action.id);
        return yield* write(mcpNotificationAckLine(message.requestId));
      }
      case "CallTool":
        return yield* handleToolCall(message.requestId, action.id, action.call);
    }
  });

  // ---- stdout --------------------------------------------------------------

  const handleMessage = Effect.fnUntraced(function* (message: CliMessage) {
    switch (message._tag) {
      case "ControlResponse": {
        // The answer to a control request of ours goes to whoever sent it.
        const waiter = HashMap.get(yield* Ref.get(controlWaiters), message.requestId);
        if (Option.isNone(waiter)) return yield* Queue.offer(inbox, message);
        return yield* Deferred.succeed(waiter.value, message.success);
      }
      case "ToolPermissionRequest":
        // Only pi's tools may run, and only when the call can be held open.
        return yield* write(
          toolPermissionResponseLine(
            message.requestId,
            launch.allowHandoff && isHandoffClaudeTool(message.toolName)
              ? { behavior: "allow", updatedInput: message.input }
              : { behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE },
          ),
        );
      case "McpRequest":
        return yield* handleMcpRequest(message);
      case "StreamEvent": {
        // The model is answering a message that was only to be held: this
        // CLI does not take a history import.
        if (yield* settleHeldMessage(false)) return;
        // Recorded here, not by the episode: the `tools/call` for a block
        // can reach this reader before the episode has read the block.
        const block = message.event.content_block;
        if (
          message.event.type === "content_block_start" &&
          block?.type === "tool_use" &&
          block.id !== undefined &&
          block.name !== undefined &&
          isHandoffClaudeTool(block.name)
        ) {
          const call: ExpectedToolCall = {
            name: mapClaudeToolNameToPi(block.name),
            result: yield* Deferred.make<McpToolResult>(),
          };
          yield* Ref.update(expected, HashMap.set(block.id, call));
        }
        return yield* Queue.offer(inbox, message);
      }
      case "Result":
        // The confirmation of a held message is not a turn's result.
        if (yield* settleHeldMessage(true)) return;
        // The turn is over before the episode sees the result, so an episode
        // that retires the process on it does not interrupt a finished turn.
        yield* endTurn;
        yield* Queue.offer(inbox, message);
        return yield* failExpectedToolCalls("the turn ended before pi delivered this result.");
      case "RateLimit":
        yield* Ref.set(
          rateLimit,
          Option.some({
            info: message.info,
            reportedAtMillis: yield* Clock.currentTimeMillis,
          }),
        );
        return yield* Queue.offer(inbox, message);
      case "AssistantMessage":
      case "Other":
        return yield* Queue.offer(inbox, message);
    }
  });

  const stderrReader = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTail, (tail) => (tail + chunk).slice(-STDERR_TAIL_LIMIT_CHARS)),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  /** stdout ended: no result is coming, whatever the process is doing. */
  const reportExit = Effect.gen(function* () {
    const exitCode = yield* handle.exitCode.pipe(
      Effect.map((code) => Option.some(Number(code))),
      Effect.orElseSucceed(() => Option.none<number>()),
      Effect.timeoutOption(EXIT_REPORT_GRACE),
      Effect.map(Option.flatten),
    );
    yield* Fiber.await(stderrReader).pipe(Effect.timeoutOption(EXIT_REPORT_GRACE));
    yield* Ref.set(alive, false);
    yield* endTurn;
    yield* settleHeldMessage(false);
    for (const waiter of HashMap.values(yield* Ref.get(controlWaiters)))
      yield* Deferred.succeed(waiter, false);
    yield* Effect.sync(() =>
      span.attribute(
        "exitCode",
        Option.getOrElse(exitCode, () => "signal"),
      ),
    );
    yield* Queue.fail(
      inbox,
      new ProcessExited({ exitCode, stderrTail: yield* Ref.get(stderrTail) }),
    );
    // Not awaited and not in this scope: retiring closes the scope this
    // reader runs in.
    yield* Effect.forkIn(retire("exited"), runtimeScope);
  });

  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        yield* Ref.set(lastOutputAt, yield* Clock.currentTimeMillis);
        if (launch.traceRawWire) yield* recordSpanEvent(span, "wire raw", { line });
        const message = decodeCliLine(line);
        if (Option.isSome(message)) yield* handleMessage(message.value);
      }),
    ),
    Effect.ignore,
    Effect.andThen(reportExit),
    Effect.withParentSpan(span),
    Effect.forkScoped,
  );

  // ---- retiring ------------------------------------------------------------

  const awaitExit = (grace: Duration.Duration) =>
    handle.exitCode.pipe(Effect.ignore, Effect.timeoutOption(grace));

  // Registered after the spawn, so it runs before the spawner's own
  // finalizer: ask the CLI to exit, and leave the kill to the spawner.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Ref.set(alive, false);
      if (!(yield* isRunning)) return;
      if (!(yield* Ref.get(killWithoutGrace))) {
        if (yield* Ref.get(turnActive)) {
          // Let the CLI end the interrupted turn before stdin goes away.
          yield* write(
            controlRequestLine(`pcc-retire-${launch.cliSessionId}`, {
              subtype: "interrupt",
            }),
          );
          yield* Effect.raceFirst(
            Deferred.await(yield* Ref.get(turnEnded)),
            awaitExit(INTERRUPT_GRACE),
          ).pipe(Effect.timeoutOption(INTERRUPT_GRACE));
        }
        yield* Queue.end(outbound);
        yield* awaitExit(EXIT_GRACE);
      }
      if (yield* isRunning) yield* Ref.set(endedBy, "killed");
    }),
  );
  // Registered after the one above, so it runs first: an open tool call is
  // abandoned, not answered, by the process that is going away.
  yield* Effect.addFinalizer(() => FiberMap.clear(openCalls));

  const closeScope = Effect.fn("ClaudeProcess.retire")(function* (cause: RetireCause) {
    yield* Effect.annotateCurrentSpan({ cause, pid });
    yield* Ref.set(killWithoutGrace, cause === "timeout");
    yield* Scope.close(scope, Exit.void);
    yield* Effect.annotateCurrentSpan({ ended: yield* Ref.get(endedBy) });
    yield* Deferred.succeed(retired, undefined);
  });

  /** The first call closes the scope; every later one waits for it. */
  const retire = (cause: RetireCause): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(retiring, true)) return yield* Deferred.await(retired);
      yield* closeScope(cause).pipe(Effect.withParentSpan(span));
    }).pipe(Effect.uninterruptible);

  // ---- turns ---------------------------------------------------------------

  /** Write a control request and wait for the CLI to acknowledge it. */
  const requestControl = Effect.fnUntraced(function* (lineFor: (requestId: string) => string) {
    if (!(yield* Ref.get(alive))) return false;
    const requestId = `pcc-${yield* Ref.updateAndGet(controlSequence, (n) => n + 1)}`;
    const acknowledged = yield* Deferred.make<boolean>();
    yield* Ref.update(controlWaiters, HashMap.set(requestId, acknowledged));
    yield* write(lineFor(requestId));
    return yield* Deferred.await(acknowledged).pipe(
      Effect.timeoutOption(CONTROL_TIMEOUT),
      Effect.map(Option.getOrElse(() => false)),
      Effect.ensuring(Ref.update(controlWaiters, HashMap.remove(requestId))),
    );
  });

  /** The CLI reads thinking once per user turn, so never during one. */
  const sendThinkingControl = Effect.fnUntraced(function* (request: ThinkingControl) {
    if (yield* Ref.get(turnActive)) return false;
    return yield* requestControl((requestId) => controlRequestLine(requestId, request));
  });

  /**
   * Serve `desired` from now on and tell the CLI its tools changed. The
   * change has landed only once the CLI has asked for the list again: an
   * acknowledged notification alone proves nothing (Claude Code 2.1.263
   * acknowledges it and keeps the old tools).
   */
  const changeTools = Effect.fn("ClaudeProcess.applyTools")(function* (
    desired: ReadonlyArray<McpToolDefinition>,
  ) {
    yield* Effect.annotateCurrentSpan({
      pid,
      from: (yield* Ref.get(tools)).length,
      to: desired.length,
      midTurn: yield* Ref.get(turnActive),
    });
    const relisted = yield* Deferred.make<void>();
    yield* Ref.set(tools, desired);
    yield* Ref.set(toolsRelisted, Option.some(relisted));
    const acknowledged =
      (yield* requestControl((requestId) =>
        mcpServerNotificationLine(requestId, INBAND_MCP_SERVER_NAME, MCP_TOOLS_CHANGED_METHOD),
      )) &&
      (yield* Deferred.await(relisted).pipe(
        Effect.as(true),
        Effect.timeoutOption(TOOLS_RELIST_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
      ));
    yield* Ref.set(toolsRelisted, Option.none());
    yield* Effect.annotateCurrentSpan({ acknowledged });
    return acknowledged;
  });

  const idleTimer = yield* FiberHandle.make<void>();

  const gone = new ProcessGone({
    message: "The Claude CLI process has already ended.",
  });

  /** Start a turn with a user message. */
  const writeUser = (content: ReadonlyArray<CliUserContentBlock>) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(alive))) return yield* gone;
      yield* Ref.set(turnEnded, yield* Deferred.make<void>());
      yield* Ref.set(turnActive, true);
      yield* write(userMessageLine(content));
    });

  const importHistory = Effect.fn("ClaudeProcess.importHistory")(function* (
    frames: ReadonlyArray<CliReplayFrame>,
  ) {
    yield* Effect.annotateCurrentSpan({ pid, frames: frames.length });
    const last = frames[frames.length - 1];
    let taken = last?.kind === "user";
    for (const frame of frames.slice(0, -1)) {
      if (!taken) break;
      if (!(yield* Ref.get(alive))) return yield* gone;
      if (frame.kind === "assistant") {
        // Appended as it is; the CLI answers nothing.
        yield* write(assistantReplayLine(launch.modelId, frame.content));
        continue;
      }
      const confirmed = yield* Deferred.make<boolean>();
      yield* Ref.set(heldMessage, Option.some(confirmed));
      yield* write(userMessageLine(frame.content, { hold: true }));
      taken = yield* Deferred.await(confirmed).pipe(
        Effect.timeoutOption(IMPORT_HOLD_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
        Effect.ensuring(Ref.set(heldMessage, Option.none())),
      );
    }
    yield* Effect.annotateCurrentSpan({ acknowledged: taken });
    if (taken && last?.kind === "user") yield* writeUser(last.content);
    return taken;
  });

  const process: IClaudeProcess = {
    cliSessionId: launch.cliSessionId,
    pid,
    signature: launch.signature,
    allowHandoff: launch.allowHandoff,
    span,
    inbox,
    acknowledged: yield* Ref.make(Option.none<HistoryCheckpoint>()),
    lastProcessTotals: yield* Ref.make(ZERO_TOKEN_USAGE),
    turnReported: yield* Ref.make(ZERO_TOKEN_USAGE),
    idleTimer,
    isAlive: Ref.get(alive),
    lastOutputAtMillis: Ref.get(lastOutputAt),
    isTurnActive: Ref.get(turnActive),
    thinking: Ref.get(thinking),
    rateLimit: Ref.get(rateLimit),
    writeUser,
    takesStructuredImport: Option.exists(yield* cli.version, supportsStructuredImport),
    importHistory,
    interruptTurn: Effect.gen(function* () {
      const requestId = `pcc-int-${yield* Ref.updateAndGet(controlSequence, (n) => n + 1)}`;
      yield* write(controlRequestLine(requestId, { subtype: "interrupt" }));
    }),
    applyThinking: Effect.fn("ClaudeProcess.applyThinking")(function* (desired: CliThinking) {
      const applied = yield* Ref.get(thinking);
      yield* Effect.annotateCurrentSpan({
        from: applied.kind,
        to: desired.kind,
        pid,
      });
      const controls = thinkingControls(applied, desired);
      let acknowledged = controls !== undefined;
      for (const control of controls ?? []) {
        acknowledged = yield* sendThinkingControl(control);
        if (!acknowledged) break;
      }
      if (acknowledged) yield* Ref.set(thinking, desired);
      yield* Effect.annotateCurrentSpan({
        acknowledged,
        controls: controls?.length ?? 0,
      });
      return acknowledged;
    }),
    applyTools: (desired) =>
      Effect.gen(function* () {
        const serving = yield* Ref.get(tools);
        return JSON.stringify(serving) === JSON.stringify(desired)
          ? yield* Ref.get(alive)
          : yield* changeTools(desired);
      }),
    awaitsToolCalls: (toolUseIds) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(alive)) || !(yield* Ref.get(turnActive))) return false;
        if (toolUseIds.length === 0) return false;
        const calls = yield* Ref.get(expected);
        for (const toolUseId of toolUseIds) {
          const call = HashMap.get(calls, toolUseId);
          if (Option.isNone(call)) return false;
          if (yield* Deferred.isDone(call.value.result)) return false;
        }
        return true;
      }),
    answerToolCall: (toolUseId, result) =>
      Effect.gen(function* () {
        const call = HashMap.get(yield* Ref.get(expected), toolUseId);
        if (Option.isSome(call)) yield* Deferred.succeed(call.value.result, result);
      }),
    retire,
    awaitRetired: Deferred.await(retired),
  };
  return process;
});
