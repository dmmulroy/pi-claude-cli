/**
 * The provider's configuration, read once when a runtime builds.
 *
 * Users have four settings (see `provider-env.ts`): the executable, its
 * config directory, usage credits and tracing. This service holds the rest:
 * fixed values, plus the relay and wire-trace switches kept for debugging.
 * Scenarios and benchmarks change the fixed values by providing their own
 * `ProviderConfig` (`providerLayerWith`), never through the environment.
 *
 * Reading is lenient: a value that does not parse is the default. Building
 * this service never fails.
 */

import { Config, Context, Duration, Effect, Layer, Option } from "effect";

/**
 * The turn relay between the CLI and the API (`PI_CLAUDE_CLI_RELAY`, a
 * debugging switch). `rewrite`, the default, routes the CLI through the
 * relay and applies its request rewrites (`src/relay-rewrite.ts`); `shadow`
 * records each request and changes nothing; `off` lets the CLI talk to the
 * API itself.
 */
export type RelayMode = "off" | "shadow" | "rewrite";

/** How much of the CLI's stdout is recorded on the `episode` span. */
export type TraceWireDetail = "counts" | "events" | "raw";

/** Defines the provider configuration. */
export interface IProviderConfig {
  /**
   * Longest stdout silence tolerated while an episode is attached, when pi's
   * stream options carry no `timeoutMs`. Past it the episode fails with
   * `InactivityTimeout` and the process is killed.
   */
  readonly inactivityTimeout: Duration.Duration;
  /** Idle lifetime of a process parked after a turn; none parks nothing. */
  readonly keepalive: Option.Option<Duration.Duration>;
  /** Most processes parked at once across pi sessions; each holds ~500 MB. */
  readonly maxParked: number;
  /** Idle lifetime of a process parked inside a tool call. */
  readonly handoffWait: Duration.Duration;
  /** The CLI-side MCP tool-call timeout, in milliseconds, as the CLI reads it. */
  readonly mcpToolTimeoutMillis: string;
  /** True when inherited simple or safe mode would break the launch. */
  readonly restrictedMode: boolean;
  readonly traceWireDetail: TraceWireDetail;
  readonly relay: RelayMode;
  /** `PI_CLAUDE_CLI_RELAY_DUMP`: a directory for relayed request bodies (content!). */
  readonly relayDump: Option.Option<string>;
}

/** Provides the provider configuration. */
export class ProviderConfig extends Context.Service<ProviderConfig, IProviderConfig>()(
  "pi-claude-cli/ProviderConfig",
) {}

/** Five minutes, when pi sets no timeout of its own. */
const DEFAULT_INACTIVITY_TIMEOUT = Duration.minutes(5);
/**
 * One hour: Claude Code writes its prompt cache with a one-hour lifetime. A
 * process parked for less throws away a warm process that would have been
 * reused; the relay makes a fresh one cheap, not free (launch and import).
 */
const KEEPALIVE = Duration.hours(1);
const MAX_PARKED = 4;
const HANDOFF_WAIT = Duration.minutes(30);
/** One hour: tool calls block in the CLI's MCP client while pi runs the tool. */
const MCP_TOOL_TIMEOUT_MILLIS = "3600000";

/** An environment variable as text; unset, empty and unreadable are all none. */
const envText = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.map((value) => value.trim())),
    Effect.map(Option.filter((value) => value.length > 0)),
  );

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes"]);

const envFlag = (name: string) =>
  envText(name).pipe(Effect.map(Option.exists((v) => TRUTHY_FLAG_VALUES.has(v.toLowerCase()))));

const traceWireDetail = envText("PI_CLAUDE_CLI_TRACE_WIRE").pipe(
  Effect.map((text): TraceWireDetail => {
    const value = Option.getOrElse(text, () => "").toLowerCase();
    if (value === "raw") return "raw";
    return TRUTHY_FLAG_VALUES.has(value) ? "events" : "counts";
  }),
);

const relay = envText("PI_CLAUDE_CLI_RELAY").pipe(
  Effect.map((text): RelayMode => {
    const value = Option.getOrElse(text, () => "rewrite").toLowerCase();
    if (value === "shadow") return "shadow";
    return value === "off" || value === "0" || value === "false" ? "off" : "rewrite";
  }),
);

/** Constructs the provider configuration from the environment. */
export const makeProviderConfig = Effect.gen(function* () {
  const simple = yield* envFlag("CLAUDE_CODE_SIMPLE");
  const safe = yield* envFlag("CLAUDE_CODE_SAFE_MODE");
  return ProviderConfig.of({
    inactivityTimeout: DEFAULT_INACTIVITY_TIMEOUT,
    keepalive: Option.some(KEEPALIVE),
    maxParked: MAX_PARKED,
    handoffWait: HANDOFF_WAIT,
    mcpToolTimeoutMillis: MCP_TOOL_TIMEOUT_MILLIS,
    restrictedMode: simple || safe,
    traceWireDetail: yield* traceWireDetail,
    relay: yield* relay,
    relayDump: yield* envText("PI_CLAUDE_CLI_RELAY_DUMP"),
  });
});

/** Provides the provider configuration read from the process environment. */
export const providerConfigLayer = Layer.effect(ProviderConfig, makeProviderConfig);

/** Provides `makeProviderConfig` with some values replaced (scenarios, benchmarks). */
export const providerConfigLayerWith = (overrides: Partial<IProviderConfig>) =>
  Layer.effect(
    ProviderConfig,
    Effect.map(makeProviderConfig, (config) => ProviderConfig.of({ ...config, ...overrides })),
  );
