/**
 * Span sink for the provider: every Effect span and log line as NDJSON.
 *
 * Traces are how this provider is debugged and verified (`scripts/trace.ts`).
 * The sink is on by default and writes one file per day under the user's
 * state directory; `PI_CLAUDE_CLI_TRACE=<path>` redirects it and `=off`
 * disables it (see `src/trace-location.ts`). One record is appended when a
 * span starts, one for each span event, and one when the span ends.
 *
 * Records are not a transcript: they never carry prompt text, tool arguments
 * or tool results. Callers attach ids, names, sizes and counts only.
 */

import { appendFileSync } from "node:fs";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Tracer,
} from "effect";
import { nodeFileSystemLayer } from "./node-platform.ts";
import {
  dailyTraceFileName,
  resolveTraceTarget,
  TRACE_DIRECTORY_MODE,
  TRACE_FILE_MODE,
  TRACE_RETENTION_DAYS,
  type TraceTarget,
} from "./trace-location.ts";

/** How a finished span ended. */
export type TraceSpanStatus = "ok" | "error" | "interrupted";

/** A reference from one span to another, possibly in a different trace. */
export interface TraceSpanLink {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * One line of the trace file. `start` and `end` describe a span; `event`
 * is a log line or wire message recorded on a span while it was open.
 *
 * Nullish fields follow the on-disk NDJSON contract read by
 * `scripts/trace.mjs`, which has no Effect dependency.
 */
export type TraceRecord =
  | {
      readonly kind: "start";
      readonly name: string;
      readonly traceId: string;
      readonly spanId: string;
      readonly parentSpanId: string | null;
      readonly pid: number;
      readonly timeMs: number;
      readonly links: ReadonlyArray<TraceSpanLink>;
    }
  | {
      readonly kind: "event";
      readonly name: string;
      readonly traceId: string;
      readonly spanId: string;
      readonly pid: number;
      readonly timeMs: number;
      readonly attributes: Record<string, unknown>;
    }
  | {
      readonly kind: "end";
      readonly name: string;
      readonly traceId: string;
      readonly spanId: string;
      readonly parentSpanId: string | null;
      readonly pid: number;
      readonly timeMs: number;
      readonly durMs: number;
      readonly status: TraceSpanStatus;
      readonly error: string | null;
      readonly attributes: Record<string, unknown>;
      readonly links: ReadonlyArray<TraceSpanLink>;
    };

/** Longest rendered failure kept on an `end` record. */
const TRACE_ERROR_LIMIT_CHARS = 4_000;

const nanosToMillis = (nanos: bigint): number => Number(nanos) / 1_000_000;

/** JSON has no bigint; anything else unserializable is dropped by `JSON.stringify`. */
const traceJsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

const traceSpanLinks = (links: ReadonlyArray<Tracer.SpanLink>): ReadonlyArray<TraceSpanLink> =>
  links.map((link) => ({
    traceId: link.span.traceId,
    spanId: link.span.spanId,
  }));

const parentSpanIdOf = (span: Tracer.Span): string | null =>
  Option.match(span.parent, {
    onNone: () => null,
    onSome: (parent) => parent.spanId,
  });

const traceSpanStatus = (exit: Exit.Exit<unknown, unknown>): TraceSpanStatus => {
  if (Exit.isSuccess(exit)) return "ok";
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error";
};

const traceSpanError = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return null;
  return Cause.pretty(exit.cause).slice(0, TRACE_ERROR_LIMIT_CHARS);
};

/**
 * Appends records to the file `pathFor` names for each record's time. A
 * failed write turns the sink off for the rest of the runtime: tracing must
 * never be able to fail an episode.
 */
const traceRecordWriter = (
  pathFor: (timeMillis: number) => string,
): ((record: TraceRecord) => void) => {
  let writable = true;
  return (record) => {
    if (!writable) return;
    try {
      // Synchronous on purpose: a span boundary must be on disk before the
      // process can die, or a leaked span could not be told from a lost line.
      appendFileSync(pathFor(record.timeMs), JSON.stringify(record, traceJsonReplacer) + "\n", {
        mode: TRACE_FILE_MODE,
      });
    } catch {
      writable = false;
    }
  };
};

/**
 * Record an event on a span now. For events that belong to a span other than
 * the current one, which `Effect.log*` cannot address.
 */
export const recordSpanEvent = (
  span: Tracer.Span,
  name: string,
  attributes: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.clockWith((clock) =>
    Effect.sync(() => span.event(name, clock.currentTimeNanosUnsafe(), attributes)),
  );

/** A native span that also reports its start, events and end to the file. */
class FileTraceSpan extends Tracer.NativeSpan {
  private readonly writeRecord: (record: TraceRecord) => void;

  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    writeRecord: (record: TraceRecord) => void,
  ) {
    super(options);
    this.writeRecord = writeRecord;
    writeRecord({
      kind: "start",
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: parentSpanIdOf(this),
      pid: process.pid,
      timeMs: nanosToMillis(options.startTime),
      links: traceSpanLinks(this.links),
    });
  }

  override event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    super.event(name, startTime, attributes);
    this.writeRecord({
      kind: "event",
      name,
      traceId: this.traceId,
      spanId: this.spanId,
      pid: process.pid,
      timeMs: nanosToMillis(startTime),
      attributes: attributes ?? {},
    });
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    this.writeRecord({
      kind: "end",
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: parentSpanIdOf(this),
      pid: process.pid,
      timeMs: nanosToMillis(endTime),
      durMs: nanosToMillis(endTime - this.startTime),
      status: traceSpanStatus(exit),
      error: traceSpanError(exit),
      attributes: Object.fromEntries(this.attributes),
      links: traceSpanLinks(this.links),
    });
  }
}

const fileTracer = (pathFor: (timeMillis: number) => string): Tracer.Tracer => {
  const writeRecord = traceRecordWriter(pathFor);
  return Tracer.make({
    span: (options) => new FileTraceSpan(options, writeRecord),
  });
};

/**
 * Replaces Effect's console logger, which would corrupt pi's RPC protocol and
 * TUI. Every `Effect.log*` call becomes an event on the current span.
 */
const spanEventLoggerLayer = Logger.layer([Logger.tracerLogger]);

const MILLIS_PER_DAY = 86_400_000;

/** Remove trace files whose last write is older than the retention window. */
const pruneTraceDirectory = Effect.fn("Tracing.pruneTraceDirectory")(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cutoff = (yield* Clock.currentTimeMillis) - TRACE_RETENTION_DAYS * MILLIS_PER_DAY;
    const names = yield* fs.readDirectory(directory);
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const file = path.join(directory, name);
      const info = yield* fs.stat(file);
      const modified = Option.getOrElse(info.mtime, () => new Date());
      if (modified.getTime() >= cutoff) continue;
      yield* fs.remove(file);
      removed++;
    }
    yield* Effect.annotateCurrentSpan({ directory, removed });
  },
  // Pruning is housekeeping: a directory that is missing or unreadable
  // leaves old files behind and nothing else.
  Effect.catchTag("PlatformError", () => Effect.void),
);

/** Create the private daily directory and drop expired files. */
const prepareDailyTraceDirectory = Effect.fn("Tracing.prepareDailyTraceDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runs = path.join(directory, "runs");
  yield* fs.makeDirectory(runs, {
    recursive: true,
    mode: TRACE_DIRECTORY_MODE,
  });
  yield* fs.chmod(directory, TRACE_DIRECTORY_MODE);
  yield* pruneTraceDirectory(directory);
  yield* pruneTraceDirectory(runs);
});

const tracerLayerFor = (target: TraceTarget) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    switch (target._tag) {
      case "TraceDisabled":
        return Layer.empty;
      case "TraceFile":
        return Layer.succeed(
          Tracer.Tracer,
          fileTracer(() => target.path),
        );
      case "TraceDaily": {
        const prepared = yield* prepareDailyTraceDirectory(target.directory).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", () => Effect.succeed(false)),
        );
        if (!prepared) return Layer.empty;
        return Layer.succeed(
          Tracer.Tracer,
          fileTracer((timeMillis) => path.join(target.directory, dailyTraceFileName(timeMillis))),
        );
      }
    }
  });

/**
 * Logs as span events always, and spans appended to the trace file unless
 * `PI_CLAUDE_CLI_TRACE=off`. Never fails: a directory that cannot be created
 * or a file that cannot be written turns the file sink off.
 */
export const tracingLayerWithoutDependencies = Layer.unwrap(
  Effect.gen(function* () {
    const tracer = yield* tracerLayerFor(yield* resolveTraceTarget);
    return Layer.merge(spanEventLoggerLayer, tracer);
  }),
);

/** The tracing layer over Node's file system. */
export const tracingLayer = tracingLayerWithoutDependencies.pipe(
  Layer.provide(nodeFileSystemLayer),
);
