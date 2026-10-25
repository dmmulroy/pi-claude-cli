/**
 * Where span records are written, shared by the sink (`src/tracing.ts`) and
 * the trace CLI (`scripts/trace.ts`).
 *
 * The default is one file per day under the user's state directory, so any
 * session can be inspected afterwards without having been started specially.
 */

import { homedir } from "node:os";
import { Config, Effect, Option, Path } from "effect";

/** Value of `PI_CLAUDE_CLI_TRACE` that turns the file sink off. */
export const TRACE_DISABLED_VALUE = "off";

/** Trace files older than this are removed when a runtime builds. */
export const TRACE_RETENTION_DAYS = 7;

/** Owner-only directory mode for the trace directories. */
export const TRACE_DIRECTORY_MODE = 0o700;

/** Owner-only file mode for every trace file. */
export const TRACE_FILE_MODE = 0o600;

/** Where the sink writes: nowhere, one named file, or the daily default. */
export type TraceTarget =
  | { readonly _tag: "TraceDisabled" }
  | { readonly _tag: "TraceFile"; readonly path: string }
  | { readonly _tag: "TraceDaily"; readonly directory: string };

const stateHome = Config.option(Config.NonEmptyString("XDG_STATE_HOME")).pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
);

const traceOverride = Config.option(Config.NonEmptyString("PI_CLAUDE_CLI_TRACE")).pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
);

/**
 * The default trace directory: `$XDG_STATE_HOME/pi-claude-cli/traces`, or
 * `~/.local/state/pi-claude-cli/traces`.
 */
export const defaultTraceDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = Option.getOrElse(yield* stateHome, () => path.join(homedir(), ".local", "state"));
  return path.join(state, "pi-claude-cli", "traces");
});

/** Directory holding the per-run files created by `trace run`. */
export const traceRunDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* defaultTraceDirectory, "runs");
});

/** The daily trace file name for a moment in time, in UTC. */
export const dailyTraceFileName = (timeMillis: number): string =>
  `${new Date(timeMillis).toISOString().slice(0, 10)}.ndjson`;

/** What `PI_CLAUDE_CLI_TRACE` selects: unset is the daily default. */
export const resolveTraceTarget = Effect.gen(function* () {
  const path = yield* Path.Path;
  const override = yield* traceOverride;
  if (Option.isNone(override)) {
    const directory = yield* defaultTraceDirectory;
    return { _tag: "TraceDaily", directory } satisfies TraceTarget;
  }
  if (override.value.trim().toLowerCase() === TRACE_DISABLED_VALUE) {
    return { _tag: "TraceDisabled" } satisfies TraceTarget;
  }
  return {
    _tag: "TraceFile",
    path: path.resolve(override.value),
  } satisfies TraceTarget;
});
