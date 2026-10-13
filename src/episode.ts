/**
 * One pi model call, served by a Claude CLI process: an "episode".
 *
 * pi owns the system prompt, the tools, the conversation and compaction; the
 * CLI contributes subscription authentication and model access and is a
 * disposable cache of pi's history. An episode:
 *
 * 1. takes the pi session's parked process when this call continues the
 *    history that process acknowledged, and otherwise launches one and
 *    imports pi's whole history as one user message;
 * 2. streams prose, thinking and tool calls to pi through the event bridge;
 * 3. at a tool call, ends with `toolUse` while the CLI stays blocked on the
 *    in-band `tools/call`; pi runs the tool and its next call answers it on
 *    the same process;
 * 4. at `result`, parks the process for the session's next call.
 *
 * The episode never ends pi's stream itself. It succeeds, fails or is
 * interrupted, and the boundary (`src/provider-runtime.ts`) turns that one
 * exit into exactly one of `done`, `error` or `aborted`.
 */

import type {
  Api,
  Message,
  Model,
  SimpleStreamOptions,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  Cause,
  Clock,
  Crypto,
  Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Ref,
} from "effect";
import { ClaudeProcessPool } from "./claude-process-pool.ts";
import type { IClaudeProcess, RetireCause } from "./claude-process.ts";
import { cliMessageLabel, type ClaudeResultMessage } from "./cli-protocol.ts";
import {
  decideEpisodeMode,
  deltaMessages,
  type EpisodeMode,
  type LaunchSignature,
  type SpawnReason,
} from "./episode-mode.ts";
import {
  CliResultError,
  type EpisodeError,
  InactivityTimeout,
} from "./errors.ts";
import type { EventBridge } from "./event-bridge.ts";
import { mcpToolDefinitions, mcpToolResultFromPi } from "./mcp-inband.ts";
import {
  historyHash,
  piContext,
  piSystemPrompt,
  replayPiMessages,
  structuredReplay,
} from "./pi-context.ts";
import { ProviderConfig } from "./provider-config.ts";
import { RuntimeDirectory } from "./runtime-directory.ts";
import { resolveCliThinking } from "./thinking-config.ts";
import { isHandoffClaudeTool } from "./tool-mapping.ts";
import { recordSpanEvent } from "./tracing.ts";
import {
  addTokenUsage,
  maxTokenUsage,
  subtractTokenUsage,
  tokenUsageFromClaudeUsage,
  tokenUsageFromModelUsage,
  tokenUsageFromPiUsage,
  ZERO_TOKEN_USAGE,
} from "./usage.ts";

/** pi's stream options, plus the working directory a host may pin. */
export type EpisodeOptions = SimpleStreamOptions & {
  /** Working directory of the CLI process; pi's own when absent. */
  readonly cwd?: string;
};

/** One pi model call. */
export interface EpisodeInput {
  readonly model: Model<Api>;
  /** pi's legacy `Context` or its system-message `TranscriptContext`. */
  readonly context: Parameters<typeof piContext>[0];
  readonly options: Option.Option<EpisodeOptions>;
  /** Accumulates the assistant message and pushes pi's stream events. */
  readonly bridge: EventBridge;
}

/** How a successful episode stopped. */
export interface EpisodeEnd {
  readonly stopReason: "stop" | "length" | "toolUse";
}

/** How the CLI's turn left the episode. */
type TurnEnd =
  /** A tool call: the CLI is blocked on it and pi runs the tool. */
  | { readonly _tag: "HandedOff" }
  /** The `result` envelope arrived. */
  | { readonly _tag: "TurnEnded"; readonly interrupted: boolean };

const retireCauseForSpawn = (reason: SpawnReason): RetireCause => {
  if (reason === "thinking" || reason === "tools") return reason;
  return reason.startsWith("signature.") ? "signature" : "history";
};

const retireCauseForFailure = (
  cause: Cause.Cause<EpisodeError>,
): RetireCause => {
  if (Cause.hasInterruptsOnly(cause)) return "abort";
  return Option.exists(
    Cause.findErrorOption(cause),
    (error) => error._tag === "InactivityTimeout",
  )
    ? "timeout"
    : "failure";
};

/** The error text of a failed `result`, as specific as the CLI was. */
const resultErrorMessage = (
  result: ClaudeResultMessage,
): Option.Option<string> => {
  const errors = (result.errors ?? []).map(String);
  const failed =
    result.subtype !== "success" ||
    result.is_error === true ||
    typeof result.error === "string" ||
    errors.length > 0;
  if (!failed) return Option.none();
  if (typeof result.error === "string") return Option.some(result.error);
  if (typeof result.result === "string" && result.is_error === true)
    return Option.some(result.result);
  if (errors.length > 0) return Option.some(errors.join("; "));
  return Option.some(
    `Claude CLI returned ${result.subtype ?? "non-success result"}`,
  );
};

const isToolResult = (message: Message): message is ToolResultMessage =>
  message.role === "toolResult";

/**
 * Serve one pi model call.
 *
 * @returns How the turn stopped, or the `EpisodeError` that ended it. On any
 *   failure or interruption the process it was using is retired in the
 *   background, never parked.
 */
export const runEpisode = Effect.fn("episode", { root: true })(function* (
  input: EpisodeInput,
) {
  const config = yield* ProviderConfig;
  const pool = yield* ClaudeProcessPool;
  const directory = yield* RuntimeDirectory;
  const crypto = yield* Crypto.Crypto;
  const episodeSpan = yield* Effect.currentSpan.pipe(Effect.option);

  const { model, bridge } = input;
  const options: EpisodeOptions = Option.getOrElse(input.options, () => ({}));
  const request = piContext(input.context);
  const messages = request.messages;
  const piSessionId = Option.filter(
    Option.fromUndefinedOr(options.sessionId),
    (id) => id.length > 0,
  );
  const cwd = options.cwd ?? process.cwd();
  const thinking = resolveCliThinking(
    model,
    options.reasoning,
    options.thinkingBudgets,
  );
  // Holding a tool call open needs a pi session to route the answer back to.
  const allowHandoff = config.handoffProxy && Option.isSome(piSessionId);
  const tools = mcpToolDefinitions(request.tools);
  const signature: LaunchSignature = {
    model: model.id,
    prompt: request.systemPrompt,
    cwd,
    handoff: allowHandoff,
    settings: Option.getOrElse(config.settingsPath, () => ""),
  };
  yield* Effect.annotateCurrentSpan({
    piSession: Option.getOrElse(piSessionId, () => "none"),
    model: model.id,
    messages: messages.length,
    tools: tools.length,
  });

  /** The process this episode holds and has not yet parked or retired. */
  const borrowed = yield* Ref.make(Option.none<IClaudeProcess>());

  // ---- 1. Reuse the session's parked process, or launch a fresh one ---------

  /** Launch a process for this call; the episode holds it from then on. */
  const launchProcess = Effect.gen(function* () {
    // A provider-minted id, never pi's: forks reuse pi session ids.
    const cliSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const systemPromptFile = yield* directory.stageSystemPrompt(
      cliSessionId,
      piSystemPrompt(request.systemPrompt),
    );
    // Uninterruptible: a launched process must be known to the episode
    // before an abort can end it.
    return yield* pool
      .launch({
        cliSessionId,
        modelId: model.id,
        systemPromptFile,
        cwd,
        thinking,
        signature,
        allowHandoff,
        tools,
        traceRawWire: config.traceWireDetail === "raw",
      })
      .pipe(
        Effect.tap((launched) => Ref.set(borrowed, Option.some(launched))),
        Effect.uninterruptible,
      );
  });

  const acquireProcess = Effect.gen(function* () {
    // Taking and recording are one step: an abort between them would leave
    // a process that is neither parked nor known to this episode.
    const parked = Option.isSome(piSessionId)
      ? yield* pool.take(piSessionId.value).pipe(
          Effect.tap((taken) => Ref.set(borrowed, taken)),
          Effect.uninterruptible,
        )
      : Option.none<IClaudeProcess>();

    let decision: EpisodeMode = { mode: "spawn", reason: "noSession" };
    if (Option.isSome(piSessionId)) {
      const facts = Option.isNone(parked)
        ? Option.none()
        : Option.some({
            signature: parked.value.signature,
            acknowledged: yield* Ref.get(parked.value.acknowledged),
            turnActive: yield* parked.value.isTurnActive,
            awaitsToolResults: yield* parked.value.awaitsToolCalls(
              deltaMessages(messages)
                .filter(isToolResult)
                .map((message) => message.toolCallId),
            ),
          });
      decision = decideEpisodeMode(facts, {
        signature,
        messages,
        historyHashOfPrefix: (length) => historyHash(messages.slice(0, length)),
      });
    }
    // pi owns the active tools: the process offers the model this call's
    // tools from its next request on, which on a handoff is the one that
    // follows the tool results.
    if (
      decision.mode !== "spawn" &&
      Option.isSome(parked) &&
      !(yield* parked.value.applyTools(tools))
    )
      decision = { mode: "spawn", reason: "tools" };
    // A new user turn runs at the level pi asks for now. A handoff keeps the
    // turn it is continuing: the CLI reads thinking once per user turn.
    if (
      decision.mode === "turn" &&
      Option.isSome(parked) &&
      !(yield* parked.value.applyThinking(thinking))
    )
      decision = { mode: "spawn", reason: "thinking" };

    if (decision.mode !== "spawn" && Option.isSome(parked)) {
      yield* Effect.annotateCurrentSpan({ mode: decision.mode });
      return { process: parked.value, mode: decision.mode };
    }

    const reason = decision.mode === "spawn" ? decision.reason : "noParked";
    yield* Effect.annotateCurrentSpan({ mode: "spawn", spawnReason: reason });
    if (Option.isSome(parked)) {
      yield* Ref.set(borrowed, Option.none());
      yield* pool.retireInBackground(parked.value, retireCauseForSpawn(reason));
    }
    // The history as the messages themselves, when asked for and possible.
    const frames =
      config.historyImport === "structured"
        ? Option.fromUndefinedOr(structuredReplay(messages, model.id))
        : Option.none();
    const first = yield* launchProcess;
    if (Option.isNone(frames) || !first.takesStructuredImport) {
      yield* Effect.annotateCurrentSpan({ import: "flat" });
      yield* first.writeUser(replayPiMessages(messages));
      return { process: first, mode: "spawn" as const };
    }
    if (yield* first.importHistory(frames.value)) {
      yield* Effect.annotateCurrentSpan({
        import: "structured",
        importFrames: frames.value.length,
      });
      return { process: first, mode: "spawn" as const };
    }
    // The CLI did not take the history as sent, so what it holds now is
    // unknown: a fresh process gets it as labelled text instead.
    yield* Ref.set(borrowed, Option.none());
    yield* pool.retireInBackground(first, "import");
    const process = yield* launchProcess;
    yield* Effect.annotateCurrentSpan({ import: "flat", importRefused: true });
    yield* process.writeUser(replayPiMessages(messages));
    return { process, mode: "spawn" as const };
  });

  // ---- 2. Read the CLI's turn ----------------------------------------------

  const readTurn = Effect.fnUntraced(function* (process: IClaudeProcess) {
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const turnReportedBefore = yield* Ref.get(process.turnReported);
    const wireCounts = new Map<string, number>();
    let firstTokenMillis = Option.none<number>();
    // A tool_use block streamed in the current assistant message.
    let sawToolCall = false;
    // We asked the CLI to end the turn (handoff proxy off): stream content
    // is frozen and only the result envelope is awaited.
    let selfInterrupted = false;

    const annotateWire = Effect.suspend(() =>
      Effect.annotateCurrentSpan({
        ...Object.fromEntries(
          [...wireCounts].map(([label, count]) => [`wire.${label}`, count]),
        ),
        ...Option.match(firstTokenMillis, {
          onNone: () => ({}),
          onSome: (millis) => ({ ttftMs: millis }),
        }),
      }),
    );

    /**
     * The next message for this episode, or `InactivityTimeout` once the CLI
     * has written nothing to stdout for the idle timeout. Idleness is the
     * process's, not the inbox's: control traffic the reader answers itself
     * never reaches the inbox and still proves the CLI is alive.
     */
    const takeMessage = Effect.gen(function* () {
      const limitMillis = Duration.toMillis(config.inactivityTimeout);
      while (true) {
        const quietSince = Math.max(
          startedAtMillis,
          yield* process.lastOutputAtMillis,
        );
        const remainingMillis =
          limitMillis - ((yield* Clock.currentTimeMillis) - quietSince);
        if (remainingMillis <= 0)
          return yield* new InactivityTimeout({
            seconds: Duration.toSeconds(config.inactivityTimeout),
          });
        const taken = yield* Queue.take(process.inbox).pipe(
          Effect.timeoutOption(Duration.millis(remainingMillis)),
        );
        if (Option.isSome(taken)) return taken.value;
      }
    });

    const read = Effect.gen(function* () {
      while (true) {
        const message = yield* takeMessage;
        const label = cliMessageLabel(message);
        wireCounts.set(label, (wireCounts.get(label) ?? 0) + 1);
        if (config.traceWireDetail !== "counts" && Option.isSome(episodeSpan))
          yield* recordSpanEvent(episodeSpan.value, `wire ${label}`, {
            ...(message._tag === "StreamEvent"
              ? { event: message.event.type }
              : {}),
          });

        if (message._tag === "StreamEvent") {
          const event = message.event;
          if (Option.isNone(firstTokenMillis))
            firstTokenMillis = Option.some(
              (yield* Clock.currentTimeMillis) - startedAtMillis,
            );
          if (!selfInterrupted)
            yield* Effect.sync(() => bridge.handleEvent(event));
          if (
            event.type === "content_block_start" &&
            event.content_block?.type === "tool_use" &&
            isHandoffClaudeTool(event.content_block.name ?? "")
          )
            sawToolCall = true;
          if (
            event.type === "message_stop" &&
            sawToolCall &&
            !selfInterrupted
          ) {
            // Held open: pi executes the tool while the CLI blocks on
            // `tools/call`. Nothing is written to the CLI, so its cached
            // prefix stays intact.
            if (process.allowHandoff)
              return { _tag: "HandedOff" } satisfies TurnEnd;
            // Not held open: ask the CLI to end the turn and wait for the
            // result. pi runs the tool; the next call imports pi's history,
            // tool result included, into a fresh process.
            selfInterrupted = true;
            yield* process.interruptTurn;
          }
          continue;
        }
        if (message._tag !== "Result") continue;

        const result = message.result;
        const failure = resultErrorMessage(result);
        // After a self-interrupt the result is `error_during_execution` by
        // design: the toolCall is already accumulated and usage still applies.
        if (Option.isSome(failure) && !selfInterrupted)
          return yield* new CliResultError({ message: failure.value });

        // `modelUsage` is cumulative for the process; per-turn spend is the
        // difference against the previous result. `usage` is per turn.
        const processTotals = tokenUsageFromModelUsage(result.modelUsage);
        const turnTotals = Option.isSome(processTotals)
          ? subtractTokenUsage(
              processTotals.value,
              yield* Ref.getAndSet(
                process.lastProcessTotals,
                processTotals.value,
              ),
            )
          : tokenUsageFromClaudeUsage(result.usage);
        // Net of what earlier episodes of this turn already handed to pi.
        const billed = maxTokenUsage(
          subtractTokenUsage(turnTotals, turnReportedBefore),
          tokenUsageFromPiUsage(bridge.getOutput().usage),
        );
        yield* Effect.sync(() =>
          bridge.applyResult({
            ...result,
            modelUsage: undefined,
            usage: billed,
          }),
        );
        return {
          _tag: "TurnEnded",
          interrupted: selfInterrupted,
        } satisfies TurnEnd;
      }
    });
    const end = yield* read.pipe(Effect.ensuring(annotateWire));
    return { end, turnReportedBefore };
  });

  // ---- 3. Park the process for the next call, or end it ---------------------

  const release = Effect.fnUntraced(function* (
    process: IClaudeProcess,
    end: TurnEnd,
    turnReportedBefore: typeof ZERO_TOKEN_USAGE,
  ) {
    const output = bridge.getOutput();
    // What the process has now acknowledged of pi's history; the next call
    // may reuse it only if its history extends exactly this.
    const acknowledged = [...messages, output];
    const checkpoint = Option.some({
      length: acknowledged.length,
      hash: historyHash(acknowledged),
    });
    yield* Ref.set(borrowed, Option.none());

    if (end._tag === "HandedOff" && Option.isSome(piSessionId)) {
      yield* Ref.set(
        process.turnReported,
        addTokenUsage(turnReportedBefore, tokenUsageFromPiUsage(output.usage)),
      );
      yield* Ref.set(process.acknowledged, checkpoint);
      return yield* pool.park(piSessionId.value, process, config.handoffWait);
    }
    yield* Ref.set(process.turnReported, ZERO_TOKEN_USAGE);
    // An interrupted turn ends on a rejected tool that only pi's history
    // can continue.
    if (end._tag === "TurnEnded" && end.interrupted)
      return yield* pool.retireInBackground(process, "interrupted");
    if (Option.isSome(piSessionId) && Option.isSome(config.keepalive)) {
      yield* Ref.set(process.acknowledged, checkpoint);
      return yield* pool.park(
        piSessionId.value,
        process,
        config.keepalive.value,
      );
    }
    return yield* pool.retireInBackground(process, "unparked");
  });

  const serve = Effect.gen(function* () {
    const { process, mode } = yield* acquireProcess;
    yield* Effect.annotateCurrentSpan({
      pid: process.pid,
      cliSession: process.cliSessionId,
    });
    if (Option.isSome(episodeSpan))
      episodeSpan.value.addLinks([{ span: process.span, attributes: {} }]);

    const delta = deltaMessages(messages);
    if (mode === "handoff") {
      for (const message of delta.filter(isToolResult))
        yield* process.answerToolCall(
          message.toolCallId,
          mcpToolResultFromPi(message),
        );
    } else if (mode === "turn") {
      yield* process.writeUser(replayPiMessages(delta));
    }

    const { end, turnReportedBefore } = yield* readTurn(process);
    // Parked before the fiber exits: `done` is pushed after the exit, so the
    // process is already there when pi issues its next call.
    yield* Effect.uninterruptible(release(process, end, turnReportedBefore));

    const output = bridge.getOutput();
    // `toolUse` with no toolCall block would send pi looking for a tool that
    // is not there.
    const hasToolCall = output.content.some(
      (block) => block.type === "toolCall",
    );
    const stopReason: EpisodeEnd["stopReason"] =
      output.stopReason === "toolUse" && hasToolCall
        ? "toolUse"
        : output.stopReason === "length"
          ? "length"
          : "stop";
    yield* Effect.annotateCurrentSpan({
      outcome: stopReason === "toolUse" ? "toolUse" : "done",
      stopReason,
      "usage.input": output.usage.input,
      "usage.output": output.usage.output,
      "usage.cacheRead": output.usage.cacheRead,
      "usage.cacheWrite": output.usage.cacheWrite,
    });
    return { stopReason } satisfies EpisodeEnd;
  });

  return yield* serve.pipe(
    // The episode scope: the staged system prompt file is removed here.
    Effect.scoped,
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) return;
        const aborted = Cause.hasInterruptsOnly(exit.cause);
        yield* Effect.annotateCurrentSpan({
          outcome: aborted ? "aborted" : "error",
        });
        // Never awaited: retiring can take seconds, and pi must get its
        // `error` or `aborted` now.
        const process = yield* Ref.getAndSet(borrowed, Option.none());
        if (Option.isSome(process))
          yield* pool.retireInBackground(
            process.value,
            retireCauseForFailure(exit.cause),
          );
      }),
    ),
  );
});
