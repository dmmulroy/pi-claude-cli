/**
 * The provider's environment configuration, read once when a runtime builds.
 *
 * Reading is lenient: a value that does not parse falls back to its default,
 * as it always has, so a typo in a tuning variable can never stop pi from
 * getting a model response. Building this service never fails.
 */

import { Config, Context, Duration, Effect, Layer, Option } from "effect";

/** How much of the CLI's stdout is recorded on the `episode` span. */
export type TraceWireDetail = "counts" | "events" | "raw";

/**
 * How pi's history reaches a fresh CLI process.
 *
 * - `structured`: the messages themselves, with real tool calls, results and
 *   signed thinking; the default. Used only on a CLI known to take them (see
 *   `MIN_STRUCTURED_IMPORT_CLI_VERSION`); any other gets `flat`.
 * - `flat`: one user message of role-labelled text (`PI_CLAUDE_CLI_IMPORT=flat`).
 */
export type HistoryImport = "flat" | "structured";

/** Defines the provider configuration read from the environment. */
export interface IProviderConfig {
  /**
   * Longest stdout silence tolerated while an episode is attached
   * (`PI_CLAUDE_CLI_TIMEOUT_MS`, default five minutes). Past it the episode
   * fails with `InactivityTimeout` and the process group is killed.
   */
  readonly inactivityTimeout: Duration.Duration;
  /** Idle lifetime of a process parked after a turn; none parks nothing. */
  readonly keepalive: Option.Option<Duration.Duration>;
  /** Idle lifetime of a process parked inside a tool call. */
  readonly handoffWait: Duration.Duration;
  /** False interrupts the turn at each tool call instead of holding it open. */
  readonly handoffProxy: boolean;
  /** Host Claude Code settings file passed as `--settings`. */
  readonly settingsPath: Option.Option<string>;
  /** The CLI-side MCP tool-call timeout, in milliseconds, as the CLI reads it. */
  readonly mcpToolTimeoutMillis: string;
  /** True when inherited simple or safe mode would break the launch. */
  readonly restrictedMode: boolean;
  readonly traceWireDetail: TraceWireDetail;
  /** How a fresh process is given pi's history (`PI_CLAUDE_CLI_IMPORT`). */
  readonly historyImport: HistoryImport;
}

/** Provides the provider configuration. */
export class ProviderConfig extends Context.Service<
  ProviderConfig,
  IProviderConfig
>()("pi-claude-cli/ProviderConfig") {}

const DEFAULT_INACTIVITY_TIMEOUT_MILLIS = 300_000;
/**
 * One hour: Claude Code writes its prompt cache with a one-hour lifetime, and
 * a fresh process cannot read the warm one's cache. A process parked for less
 * throws away a cache that would still have been hit.
 */
const DEFAULT_KEEPALIVE_MILLIS = 3_600_000;
const DEFAULT_HANDOFF_WAIT_MILLIS = 1_800_000;
/** One hour: tool calls block in the CLI's MCP client while pi runs the tool. */
const DEFAULT_MCP_TOOL_TIMEOUT_MILLIS = "3600000";

/** An environment variable as text; unset, empty and unreadable are all none. */
const envText = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.map((value) => value.trim())),
    Effect.map(Option.filter((value) => value.length > 0)),
  );

const positiveMillis = (text: Option.Option<string>): Option.Option<number> =>
  text.pipe(
    Option.map(Number),
    Option.filter((value) => Number.isFinite(value) && value > 0),
  );

const millisOrDefault = (name: string, fallback: number) =>
  envText(name).pipe(
    Effect.map((text) =>
      Duration.millis(Option.getOrElse(positiveMillis(text), () => fallback)),
    ),
  );

const KEEPALIVE_OFF_VALUES = new Set(["0", "off", "false", "none"]);

/** `0`, `off`, `false` and `none` park nothing; anything unparseable is the default. */
const keepalive = envText("PI_CLAUDE_CLI_KEEPALIVE_MS").pipe(
  Effect.map((text) => {
    if (Option.exists(text, (v) => KEEPALIVE_OFF_VALUES.has(v.toLowerCase())))
      return Option.none<Duration.Duration>();
    return Option.some(
      Duration.millis(
        Option.getOrElse(positiveMillis(text), () => DEFAULT_KEEPALIVE_MILLIS),
      ),
    );
  }),
);

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes"]);

const envFlag = (name: string) =>
  envText(name).pipe(
    Effect.map(Option.exists((v) => TRUTHY_FLAG_VALUES.has(v.toLowerCase()))),
  );

const traceWireDetail = envText("PI_CLAUDE_CLI_TRACE_WIRE").pipe(
  Effect.map((text): TraceWireDetail => {
    const value = Option.getOrElse(text, () => "").toLowerCase();
    if (value === "raw") return "raw";
    return TRUTHY_FLAG_VALUES.has(value) ? "events" : "counts";
  }),
);

const historyImport = envText("PI_CLAUDE_CLI_IMPORT").pipe(
  Effect.map((text): HistoryImport =>
    Option.exists(text, (value) => value.toLowerCase() === "flat")
      ? "flat"
      : "structured",
  ),
);

/** Constructs the provider configuration from the environment. */
export const makeProviderConfig = Effect.gen(function* () {
  const simple = yield* envFlag("CLAUDE_CODE_SIMPLE");
  const safe = yield* envFlag("CLAUDE_CODE_SAFE_MODE");
  return ProviderConfig.of({
    inactivityTimeout: yield* millisOrDefault(
      "PI_CLAUDE_CLI_TIMEOUT_MS",
      DEFAULT_INACTIVITY_TIMEOUT_MILLIS,
    ),
    keepalive: yield* keepalive,
    handoffWait: yield* millisOrDefault(
      "PI_CLAUDE_CLI_HANDOFF_WAIT_MS",
      DEFAULT_HANDOFF_WAIT_MILLIS,
    ),
    handoffProxy:
      Option.getOrElse(
        yield* envText("PI_CLAUDE_CLI_HANDOFF_PROXY"),
        () => "1",
      ) !== "0",
    settingsPath: yield* envText("PI_CLAUDE_CLI_SETTINGS"),
    mcpToolTimeoutMillis: Option.getOrElse(
      yield* envText("MCP_TOOL_TIMEOUT"),
      () => DEFAULT_MCP_TOOL_TIMEOUT_MILLIS,
    ),
    restrictedMode: simple || safe,
    traceWireDetail: yield* traceWireDetail,
    historyImport: yield* historyImport,
  });
});

/** Provides the provider configuration; it has no dependencies to select. */
export const providerConfigLayerWithoutDependencies = Layer.effect(
  ProviderConfig,
  makeProviderConfig,
);

/** Provides the provider configuration read from the process environment. */
export const providerConfigLayer = providerConfigLayerWithoutDependencies;
