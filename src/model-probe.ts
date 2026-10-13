/**
 * Asks the Claude Code CLI which models the account offers.
 *
 * A short-lived CLI process, separate from the ones that serve model calls,
 * is sent one `initialize` control request; its response lists the account's
 * models. Nothing is sent to a model, so the probe spends no tokens. It runs
 * at most once a day per machine (pi persists the result) and never on the
 * path of a model call.
 *
 * Loaded on demand by `index.ts`, like the provider runtime: importing Effect
 * at pi start would cost every session.
 */

import {
  type Cause,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CliAccountModel } from "./account-models.ts";
import { SUBSCRIPTION_OVERRIDE_ENV_VARS } from "./claude-cli.ts";
import { nodeChildProcessSpawnerLayer } from "./node-platform.ts";
import { tracingLayer } from "./tracing.ts";

/** How long the CLI may take to start and answer. It answers in under a second. */
const PROBE_TIMEOUT = Duration.seconds(10);

const INITIALIZE_REQUEST_ID = "pcc-models";

/**
 * A print-mode process with no tools, no MCP servers, no settings and no
 * transcript: it only has to answer the handshake.
 */
const PROBE_ARGUMENTS: ReadonlyArray<string> = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-chrome",
  "--tools",
  "",
  "--no-session-persistence",
];

/**
 * The probe's child-only environment. Subscription login only, as for every
 * launch. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is deliberately absent
 * here: it turns off feature-flag fetching, and without the flags the CLI
 * reports a shorter list (4 models instead of 11 on claude 2.1.292).
 */
export const probeEnvironment = (): Record<string, string | undefined> => ({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  DISABLE_AUTOUPDATER: "1",
  ...Object.fromEntries(
    SUBSCRIPTION_OVERRIDE_ENV_VARS.map((name) => [name, undefined]),
  ),
});

const InitializeResponse = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.Literal(INITIALIZE_REQUEST_ID),
      subtype: Schema.String,
      response: Schema.optional(
        Schema.Struct({
          models: Schema.optional(
            Schema.Array(
              Schema.Struct({
                value: Schema.String,
                resolvedModel: Schema.optional(Schema.String),
                displayName: Schema.optional(Schema.String),
                supportsEffort: Schema.optional(Schema.Boolean),
                supportsAdaptiveThinking: Schema.optional(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
);
const decodeInitializeResponse = Schema.decodeOption(InitializeResponse);

/**
 * The account's models from one stdout line, when that line is the answer
 * to the probe's `initialize` request. Every other line is none.
 */
export const accountModelsFromLine = (
  line: string,
): Option.Option<ReadonlyArray<CliAccountModel>> =>
  decodeInitializeResponse(line.trim()).pipe(
    Option.map((envelope) =>
      envelope.response.subtype === "success"
        ? (envelope.response.response?.models ?? [])
        : [],
    ),
  );

/** The stdin line that asks the CLI for its handshake data. */
export const initializeRequestLine = (): string =>
  JSON.stringify({
    type: "control_request",
    request_id: INITIALIZE_REQUEST_ID,
    request: { subtype: "initialize" },
  }) + "\n";

/**
 * Launch a CLI process, ask it for the account's models and end it.
 *
 * @returns The models the CLI reported; empty when it did not answer in
 *   time, could not be started, or reported none. Never fails: the caller
 *   falls back to the list it already has.
 */
export const requestAccountModels = Effect.fn(
  "ModelProbe.requestAccountModels",
  { root: true },
)(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outbound = yield* Queue.unbounded<string, Cause.Done>();
  const answer = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make("claude", PROBE_ARGUMENTS, {
        extendEnv: true,
        env: probeEnvironment(),
        stdin: Stream.fromQueue(outbound).pipe(Stream.encodeText),
        // Its own process group, killed as one when the scope closes.
        detached: true,
        killSignal: "SIGKILL",
      }),
    );
    yield* Queue.offer(outbound, initializeRequestLine());
    return yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map(accountModelsFromLine),
      Stream.filter(Option.isSome),
      Stream.runHead,
      Effect.map(Option.flatten),
    );
  });
  const models = yield* answer.pipe(
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<CliAccountModel>>()),
    Effect.map(Option.getOrElse((): ReadonlyArray<CliAccountModel> => [])),
  );
  yield* Effect.annotateCurrentSpan({ models: models.length });
  return models;
});

const probeLayer = Layer.merge(nodeChildProcessSpawnerLayer, tracingLayer);

/**
 * The boundary with `index.ts`: no Effect types. Aborting `signal` ends the
 * probe and its process.
 */
export const probeAccountModels = (
  signal: AbortSignal,
): Promise<ReadonlyArray<CliAccountModel>> =>
  Effect.runPromise(requestAccountModels().pipe(Effect.provide(probeLayer)), {
    signal,
  });
