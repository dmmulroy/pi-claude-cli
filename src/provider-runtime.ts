/**
 * The provider's Effect runtime and its boundary with pi.
 *
 * One runtime belongs to one extension instance. It is built on the first
 * model call, because pi needs its stream back synchronously and loading
 * Effect costs every pi start about 135 ms otherwise, and it is disposed on
 * `session_shutdown`, which ends every CLI process and lets print mode exit.
 *
 * `startEpisode` is the only place a pi stream is ended. The episode runs as
 * one fiber; pi's abort signal interrupts it; and its single exit becomes
 * exactly one of `done`, `error` or `aborted`. That holds when the runtime
 * itself fails to build, in which case the episode never starts.
 */

import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { Cause, type Crypto, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { ClaudeProcessPool, claudeProcessPoolLayer } from "./claude-process-pool.ts";
import { type EpisodeEnd, type EpisodeInput, type EpisodeOptions, runEpisode } from "./episode.ts";
import { createEventBridge, type EventBridge } from "./event-bridge.ts";
import { nodeCryptoLayer } from "./node-platform.ts";
import { piContext } from "./pi-context.ts";
import { ProviderConfig, providerConfigLayer } from "./provider-config.ts";
import { RuntimeDirectory, runtimeDirectoryLayer } from "./runtime-directory.ts";
import { endStreamWithDone, endStreamWithError } from "./terminal-event.ts";
import { createToolNameMap } from "./tool-mapping.ts";
import { tracingLayer } from "./tracing.ts";
import { describeUsageCreditsRejection } from "./usage-credits.ts";

/** The services an episode runs on. */
export type ProviderServices =
  | ProviderConfig
  | RuntimeDirectory
  | ClaudeProcessPool
  | Crypto.Crypto;

/** The provider as pi's extension entry point sees it: no Effect types. */
export interface ProviderRuntime {
  /**
   * Serve one pi model call on `piStream`, which receives the streamed
   * events and exactly one terminal event.
   */
  readonly startEpisode: (
    piStream: AssistantMessageEventStream,
    model: Model<Api>,
    context: EpisodeInput["context"],
    options: EpisodeOptions | undefined,
  ) => void;
  /** Retire every parked CLI process; pi's history was replaced or rewritten. */
  readonly retireParkedProcesses: () => Promise<void>;
  /**
   * Retire the process parked for one pi session, which pi has disposed;
   * every parked process when pi names no session.
   */
  readonly retireSession: (piSessionId: string | undefined) => Promise<void>;
  /** End every CLI process and release the runtime. It cannot be used again. */
  readonly dispose: () => Promise<void>;
}

/** Records that a runtime came up, and with what. */
const buildSpanLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const directory = yield* RuntimeDirectory;
    const config = yield* ProviderConfig;
    yield* Effect.annotateCurrentSpan({
      runtimeDirectory: directory.available ? "ready" : "unavailable",
      toolBridge: "inband",
      handoffProxy: config.handoffProxy,
      traceWire: config.traceWireDetail,
    });
  }).pipe(Effect.withSpan("ProviderRuntime.build", { root: true })),
);

const servicesLayer = Layer.mergeAll(
  providerConfigLayer,
  runtimeDirectoryLayer,
  claudeProcessPoolLayer,
  nodeCryptoLayer,
);

/** Every provider service over the real CLI, file system and environment. */
export const providerLayer = Layer.merge(
  servicesLayer,
  buildSpanLayer.pipe(Layer.provide(servicesLayer)),
).pipe(Layer.provideMerge(tracingLayer));

/** The error text of a failed episode, as the failure states it. */
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    const value = error.value;
    if (value instanceof Error && value.message.length > 0) return value.message;
  }
  return Cause.pretty(cause);
};

/**
 * The message pi shows for a failed episode. Anthropic's refusal to serve a
 * request on plan limits is rewritten into a billing error pi does not retry.
 */
const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const message = causeMessage(cause);
  return describeUsageCreditsRejection(message) ?? message;
};

/** Turn an episode's exit into the stream's one terminal event. */
const pushTerminalEvent = (
  piStream: AssistantMessageEventStream,
  bridge: EventBridge,
  exit: Exit.Exit<EpisodeEnd, unknown>,
): void => {
  const output = bridge.getOutput();
  if (Exit.isSuccess(exit)) return endStreamWithDone(piStream, output, exit.value.stopReason);
  if (Cause.hasInterruptsOnly(exit.cause))
    return endStreamWithError(piStream, output, "aborted", "Request aborted");
  return endStreamWithError(piStream, output, "error", failureMessage(exit.cause));
};

/**
 * Start a runtime over `layer`. The layer is built on the first episode; if
 * it fails, every episode ends with that failure as its `error` event.
 */
export const startProviderRuntime = <E>(
  layer: Layer.Layer<ProviderServices, E> = providerLayer,
): ProviderRuntime => {
  const runtime = ManagedRuntime.make(layer);
  const retireParked = Effect.gen(function* () {
    const pool = yield* ClaudeProcessPool;
    yield* pool.retireAll("shutdown");
  });
  const retireParkedSession = (piSessionId: string) =>
    Effect.gen(function* () {
      const pool = yield* ClaudeProcessPool;
      yield* pool.retireSession(piSessionId, "shutdown");
    });
  return {
    startEpisode: (piStream, model, context, options) => {
      const bridge = createEventBridge(
        piStream,
        model,
        createToolNameMap(piContext(context).tools.map((tool) => tool.name)),
      );
      runtime.runCallback(
        runEpisode({
          model,
          context,
          options: Option.fromUndefinedOr(options),
          bridge,
        }),
        {
          // pi's abort is the fiber's interruption.
          signal: options?.signal,
          onExit: (exit) => pushTerminalEvent(piStream, bridge, exit),
        },
      );
    },
    retireParkedProcesses: () => runtime.runPromise(retireParked).catch(() => undefined),
    retireSession: (piSessionId) =>
      runtime
        .runPromise(piSessionId === undefined ? retireParked : retireParkedSession(piSessionId))
        .catch(() => undefined),
    dispose: async () => {
      await runtime
        .runPromise(retireParked.pipe(Effect.withSpan("ProviderRuntime.dispose", { root: true })))
        .catch(() => undefined);
      await runtime.dispose();
    },
  };
};
