/**
 * Trace CLI for pi-claude-cli: reads the span records `src/tracing.ts`
 * writes, and is the feedback loop for every provider scenario.
 *
 *   node scripts/trace.ts --help
 *
 * With no `--file` a command reads `PI_CLAUDE_CLI_TRACE` when it names a
 * file, otherwise the newest daily file in the default trace directory, so
 * `trace tree --last` works straight after any pi session. `--run` reads the
 * file of the most recent `trace run` instead.
 */

import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import {
  Clock,
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Runtime,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { crossSpawnSpawnerLayer } from "../src/cross-spawn-spawner.ts";
import { nodeFileSystemLayer } from "../src/node-platform.ts";
import {
  defaultTraceDirectory,
  resolveTraceTarget,
  TRACE_DIRECTORY_MODE,
  traceRunDirectory,
} from "../src/trace-location.ts";
import {
  foldTraceRecords,
  parseTraceRecords,
  parseTraceSelector,
  readTraceAttribute,
  splitTraceSelectors,
  traceAncestorPredicate,
  traceAttributePredicate,
  traceEventPredicate,
  traceNamePredicate,
  traceSpanDescendants,
  traceSpanDurationMs,
  traceSpanStatus,
  type TraceModel,
  type TraceSpan,
  type TraceSpanPredicate,
} from "./trace/trace-model.ts";
import {
  formatTraceMillis,
  formatTraceRecordLine,
  formatTraceSpanAttributes,
  formatTraceSpanLine,
  formatTraceStatus,
  renderTraceTable,
  renderTraceTrees,
} from "./trace/trace-render.ts";

// ---- errors -----------------------------------------------------------------

/** The trace could not be read or the request made no sense. Exit code 2. */
class TraceUsageError extends Data.TaggedError("TraceUsageError")<{
  readonly message: string;
}> {
  readonly [Runtime.errorExitCode] = 2;
}

/** `trace assert` or `trace open` found the trace wanting. Exit code 1. */
class TraceCheckFailed extends Data.TaggedError("TraceCheckFailed")<{
  readonly failures: ReadonlyArray<string>;
  readonly file: string;
}> {
  readonly [Runtime.errorExitCode] = 1;
}

/** The command under `trace run` exited non-zero; its status becomes ours. */
class TracedCommandFailed extends Data.TaggedError("TracedCommandFailed")<{
  readonly exitCode: number;
}> {
  readonly [Runtime.errorExitCode] = this.exitCode;
}

// ---- which file -------------------------------------------------------------

const sourceFlags = {
  file: Flag.String("file").pipe(
    Flag.withDescription("Trace file to read"),
    Flag.optional,
  ),
  run: Flag.Boolean("run").pipe(
    Flag.withDescription("Read the file of the most recent `trace run`"),
    Flag.withDefault(false),
  ),
};

interface TraceSource {
  readonly file: Option.Option<string>;
  readonly run: boolean;
}

/** The most recently written `.ndjson` file in a directory. */
const newestTraceFile = Effect.fn("TraceCli.newestTraceFile")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));
  let newest = Option.none<{ readonly file: string; readonly at: number }>();
  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    const file = path.join(directory, name);
    const info = yield* fs.stat(file);
    const at = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    if (Option.isNone(newest) || at > newest.value.at)
      newest = Option.some({ file, at });
  }
  if (Option.isNone(newest))
    return yield* new TraceUsageError({
      message: `no trace files in ${directory}`,
    });
  return newest.value.file;
});

const resolveTraceFile = Effect.fn("TraceCli.resolveTraceFile")(function* (
  source: TraceSource,
) {
  const path = yield* Path.Path;
  if (Option.isSome(source.file)) return path.resolve(source.file.value);
  if (source.run) return yield* newestTraceFile(yield* traceRunDirectory);
  const target = yield* resolveTraceTarget;
  if (target._tag === "TraceFile") return target.path;
  return yield* newestTraceFile(yield* defaultTraceDirectory);
});

const loadTraceFile = Effect.fn("TraceCli.loadTraceFile")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new TraceUsageError({
          message: `cannot read trace file ${file}: ${error.message}`,
        }),
      ),
    ),
  );
  return foldTraceRecords(parseTraceRecords(text));
});

const loadTrace = Effect.fn("TraceCli.loadTrace")(function* (
  source: TraceSource,
) {
  const file = yield* resolveTraceFile(source);
  return { file, model: yield* loadTraceFile(file) };
});

/** Color only for a terminal, and never when `NO_COLOR` is set. */
const colorEnabled = Effect.gen(function* () {
  const noColor = yield* Config.option(Config.String("NO_COLOR")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const terminal = yield* Effect.sync(() => process.stdout.isTTY === true);
  return terminal && Option.isNone(noColor);
});

// ---- selectors --------------------------------------------------------------

const selectorFlags = {
  name: Flag.String("name").pipe(
    Flag.withDescription("Span name; * matches any run of characters"),
    Flag.optional,
  ),
  status: Flag.Literals("status", ["ok", "error", "interrupted", "open"]).pipe(
    Flag.withDescription("How the span ended"),
    Flag.optional,
  ),
  attr: Flag.String("attr").pipe(
    Flag.withDescription(
      "Attribute test, repeatable: k=v, k!=v, k~regex, k (present), !k (absent)",
    ),
    Flag.atLeast(0),
  ),
  event: Flag.String("event").pipe(
    Flag.withDescription("Span carries an event with this name (glob)"),
    Flag.atLeast(0),
  ),
  under: Flag.String("under").pipe(
    Flag.withDescription("Span has an ancestor matching name[k=v,...]"),
    Flag.optional,
  ),
  trace: Flag.String("trace").pipe(
    Flag.withDescription("Only spans of the trace with this id prefix"),
    Flag.optional,
  ),
};

interface SelectorInput {
  readonly name: Option.Option<string>;
  readonly status: Option.Option<"ok" | "error" | "interrupted" | "open">;
  readonly attr: ReadonlyArray<string>;
  readonly event: ReadonlyArray<string>;
  readonly under: Option.Option<string>;
  readonly trace: Option.Option<string>;
}

const selectorPredicate = (
  input: SelectorInput,
  model: TraceModel,
): TraceSpanPredicate => {
  const tests: ReadonlyArray<TraceSpanPredicate> = [
    ...Option.toArray(input.name).map(traceNamePredicate),
    ...Option.toArray(input.status).map(
      (status): TraceSpanPredicate =>
        (span) =>
          traceSpanStatus(span) === status,
    ),
    ...input.attr.map(traceAttributePredicate),
    ...input.event.map(traceEventPredicate),
    ...Option.toArray(input.under).map((text) =>
      traceAncestorPredicate(parseTraceSelector(text), model),
    ),
    ...Option.toArray(input.trace).map(
      (prefix): TraceSpanPredicate =>
        (span) =>
          span.traceId.startsWith(prefix),
    ),
  ];
  return (span) => tests.every((test) => test(span));
};

const describeSelector = (input: SelectorInput): string => {
  const parts = [
    ...Option.toArray(input.name).map((name) => `name=${name}`),
    ...Option.toArray(input.status).map((status) => `status=${status}`),
    ...input.attr.map((attr) => `attr ${attr}`),
    ...input.event.map((event) => `event ${event}`),
    ...Option.toArray(input.under).map((under) => `under ${under}`),
    ...Option.toArray(input.trace).map((trace) => `trace ${trace}`),
  ];
  return parts.length > 0 ? parts.join(", ") : "any span";
};

const selectsSomething = (input: SelectorInput): boolean =>
  Option.isSome(input.name) ||
  Option.isSome(input.status) ||
  input.attr.length > 0 ||
  input.event.length > 0 ||
  Option.isSome(input.under) ||
  Option.isSome(input.trace);

// ---- tree, ls, spans, open, stats ---------------------------------------------

const treeCommand = Command.make(
  "tree",
  {
    ...sourceFlags,
    traceId: Argument.String("traceId").pipe(
      Argument.withDescription("Only the trace with this id prefix"),
      Argument.optional,
    ),
    last: Flag.Boolean("last").pipe(
      Flag.withDescription("Only the most recent trace"),
      Flag.withDefault(false),
    ),
    events: Flag.Boolean("events").pipe(
      Flag.withDescription("Show span events (--no-events hides them)"),
      Flag.withDefault(true),
    ),
    attrs: Flag.Boolean("attrs").pipe(
      Flag.withDescription("Show span attributes (--no-attrs hides them)"),
      Flag.withDefault(true),
    ),
  },
  Effect.fn("TraceCli.tree")(function* (input) {
    const { model } = yield* loadTrace(input);
    const roots = input.last
      ? model.roots.slice(-1)
      : Option.match(input.traceId, {
          onNone: () => model.roots,
          onSome: (prefix) =>
            model.roots.filter((root) => root.traceId.startsWith(prefix)),
        });
    if (roots.length === 0)
      return yield* new TraceUsageError({ message: "no matching trace" });
    yield* Console.log(
      renderTraceTrees(roots, model, {
        color: yield* colorEnabled,
        events: input.events,
        attributes: input.attrs,
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Indented span tree with duration, status, attributes and inline events; open spans are flagged OPEN",
  ),
);

const lsCommand = Command.make(
  "ls",
  sourceFlags,
  Effect.fn("TraceCli.ls")(function* (input) {
    const { model } = yield* loadTrace(input);
    const color = { color: yield* colorEnabled };
    for (const root of model.roots) {
      const all = traceSpanDescendants(root, model);
      const open = all.filter((span) => traceSpanStatus(span) === "open");
      const failed = all.some((span) => traceSpanStatus(span) === "error");
      yield* Console.log(
        [
          root.traceId.slice(0, 8),
          new Date(root.startMs).toISOString(),
          formatTraceMillis(traceSpanDurationMs(root, model)).padStart(8),
          formatTraceStatus(failed ? "error" : traceSpanStatus(root), color),
          root.name,
          `${all.length} spans${open.length > 0 ? `, ${open.length} open` : ""}`,
          formatTraceSpanAttributes(root.attributes),
        ].join("  "),
      );
    }
  }),
).pipe(
  Command.withDescription(
    "One line per trace: root span, start, duration, status",
  ),
);

/** The on-disk form of a span, for `spans --json`. */
const traceSpanJson = (span: TraceSpan) => ({
  name: span.name,
  traceId: span.traceId,
  spanId: span.spanId,
  parentSpanId: Option.getOrNull(span.parentSpanId),
  pid: span.pid,
  startMs: span.startMs,
  endMs: Option.getOrNull(Option.map(span.end, (end) => end.endMs)),
  durMs: Option.getOrNull(Option.map(span.end, (end) => end.durMs)),
  status: traceSpanStatus(span),
  error: Option.getOrNull(Option.flatMap(span.end, (end) => end.error)),
  attributes: span.attributes,
  events: span.events,
  links: span.links,
});

const spansCommand = Command.make(
  "spans",
  {
    ...sourceFlags,
    ...selectorFlags,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("One JSON object per span, for piping"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("TraceCli.spans")(function* (input) {
    const { model } = yield* loadTrace(input);
    const matched = model.spans.filter(selectorPredicate(input, model));
    const options = {
      color: yield* colorEnabled,
      events: false,
      attributes: true,
    };
    for (const span of matched)
      yield* Console.log(
        input.json
          ? JSON.stringify(traceSpanJson(span))
          : formatTraceSpanLine(span, model, options),
      );
  }),
).pipe(Command.withDescription("Matching spans, one per line"));

const openCommand = Command.make(
  "open",
  sourceFlags,
  Effect.fn("TraceCli.open")(function* (input) {
    const { file, model } = yield* loadTrace(input);
    const open = model.spans.filter((span) => traceSpanStatus(span) === "open");
    if (open.length === 0) return yield* Console.log("no open spans");
    const options = {
      color: yield* colorEnabled,
      events: false,
      attributes: true,
    };
    return yield* new TraceCheckFailed({
      file,
      failures: open.map(
        (span) => `open span: ${formatTraceSpanLine(span, model, options)}`,
      ),
    });
  }),
).pipe(
  Command.withDescription(
    "Spans that started and never ended; exits 1 when there are any",
  ),
);

const statsCommand = Command.make(
  "stats",
  sourceFlags,
  Effect.fn("TraceCli.stats")(function* (input) {
    const { model } = yield* loadTrace(input);
    const names = [...new Set(model.spans.map((span) => span.name))].sort();
    const rows = names.map((name) => {
      const spans = model.spans.filter((span) => span.name === name);
      const count = (status: string) =>
        String(spans.filter((span) => traceSpanStatus(span) === status).length);
      const durations = spans
        .flatMap((span) => Option.toArray(span.end))
        .map((end) => end.durMs)
        .sort((a, b) => a - b);
      const at = (index: number) =>
        Option.match(Option.fromUndefinedOr(durations[index]), {
          onNone: () => "-",
          onSome: formatTraceMillis,
        });
      return [
        name,
        String(spans.length),
        at(Math.floor((durations.length - 1) / 2)),
        at(durations.length - 1),
        count("error"),
        count("interrupted"),
        count("open"),
      ];
    });
    yield* Console.log(
      renderTraceTable([
        ["name", "count", "p50", "max", "error", "intr", "open"],
        ...rows,
      ]),
    );
  }),
).pipe(Command.withDescription("Count, p50 and max duration by span name"));

// ---- assert -----------------------------------------------------------------

interface AssertChecks {
  readonly count: Option.Option<number>;
  readonly minCount: Option.Option<number>;
  readonly maxCount: Option.Option<number>;
  readonly maxMs: Option.Option<number>;
  readonly minMs: Option.Option<number>;
  readonly same: Option.Option<string>;
  readonly distinct: Option.Option<string>;
}

/** Failures of the count, duration and attribute checks over the matched spans. */
const matchedSpanFailures = (
  matched: ReadonlyArray<TraceSpan>,
  what: string,
  checks: AssertChecks,
  model: TraceModel,
): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  const hasCountCheck =
    Option.isSome(checks.count) ||
    Option.isSome(checks.minCount) ||
    Option.isSome(checks.maxCount);
  if (!hasCountCheck && matched.length === 0)
    failures.push(`expected a span with ${what}, found none`);
  if (Option.isSome(checks.count) && matched.length !== checks.count.value)
    failures.push(
      `expected exactly ${checks.count.value} span(s) with ${what}, found ${matched.length}`,
    );
  if (Option.isSome(checks.minCount) && matched.length < checks.minCount.value)
    failures.push(
      `expected at least ${checks.minCount.value} span(s) with ${what}, found ${matched.length}`,
    );
  if (Option.isSome(checks.maxCount) && matched.length > checks.maxCount.value)
    failures.push(
      `expected at most ${checks.maxCount.value} span(s) with ${what}, found ${matched.length}`,
    );
  for (const span of matched) {
    const duration = traceSpanDurationMs(span, model);
    const label = `${span.name} ${span.spanId.slice(0, 8)} took ${formatTraceMillis(duration)}`;
    if (Option.isSome(checks.maxMs) && duration > checks.maxMs.value)
      failures.push(`${label}, over --max-ms ${checks.maxMs.value}`);
    if (Option.isSome(checks.minMs) && duration < checks.minMs.value)
      failures.push(`${label}, under --min-ms ${checks.minMs.value}`);
  }
  const valuesOf = (key: string) =>
    matched.map((span) => readTraceAttribute(span, key));
  const show = (values: ReadonlyArray<Option.Option<string>>) =>
    JSON.stringify(values.map(Option.getOrNull));
  if (Option.isSome(checks.same)) {
    const values = valuesOf(checks.same.value);
    const distinct = new Set(values.map(Option.getOrNull));
    if (values.some(Option.isNone) || distinct.size > 1)
      failures.push(
        `expected one shared ${checks.same.value} across ${what}, found ${show(values)}`,
      );
  }
  if (Option.isSome(checks.distinct)) {
    const values = valuesOf(checks.distinct.value);
    const distinct = new Set(values.map(Option.getOrNull));
    if (values.some(Option.isNone) || distinct.size !== values.length)
      failures.push(
        `expected distinct ${checks.distinct.value} across ${what}, found ${show(values)}`,
      );
  }
  return failures;
};

/** Failures of `--order`: each selector must match at or after the one before. */
const orderFailures = (
  order: string,
  model: TraceModel,
): ReadonlyArray<string> => {
  let after = Number.NEGATIVE_INFINITY;
  let previous = "the start of the trace";
  for (const selector of splitTraceSelectors(order).map(parseTraceSelector)) {
    const timed = model.spans
      .filter(selector.matches)
      .flatMap((span) =>
        selector.orderBy === "start"
          ? [span.startMs]
          : Option.toArray(span.end).map((end) => end.endMs),
      )
      .sort((a, b) => a - b);
    const next = Option.fromUndefinedOr(timed.find((time) => time >= after));
    if (Option.isNone(next))
      return [
        timed.length === 0
          ? `--order: no span matches ${selector.text}`
          : `--order: no ${selector.text} at or after ${previous}`,
      ];
    after = next.value;
    previous = selector.text;
  }
  return [];
};

const assertCommand = Command.make(
  "assert",
  {
    ...sourceFlags,
    ...selectorFlags,
    count: Flag.Int("count").pipe(
      Flag.withDescription("Exactly N matching spans (default: at least 1)"),
      Flag.optional,
    ),
    minCount: Flag.Int("min-count").pipe(Flag.optional),
    maxCount: Flag.Int("max-count").pipe(Flag.optional),
    maxMs: Flag.Finite("max-ms").pipe(
      Flag.withDescription("Every matching span took at most this long"),
      Flag.optional,
    ),
    minMs: Flag.Finite("min-ms").pipe(
      Flag.withDescription("Every matching span took at least this long"),
      Flag.optional,
    ),
    same: Flag.String("same").pipe(
      Flag.withDescription("All matching spans share one value of attribute k"),
      Flag.optional,
    ),
    distinct: Flag.String("distinct").pipe(
      Flag.withDescription("All matching spans differ in attribute k"),
      Flag.optional,
    ),
    open: Flag.Boolean("open").pipe(
      Flag.withDescription("--no-open fails if any span in the file is open"),
      Flag.withDefault(true),
    ),
    order: Flag.String("order").pipe(
      Flag.withDescription(
        "Comma-separated selectors name[k=v,...] that must occur in this order; suffix :end orders by end time",
      ),
      Flag.optional,
    ),
    quiet: Flag.Boolean("quiet").pipe(Flag.withDefault(false)),
  },
  Effect.fn("TraceCli.assert")(function* (input) {
    const { file, model } = yield* loadTrace(input);
    const checksSpans =
      selectsSomething(input) ||
      Option.isSome(input.count) ||
      Option.isSome(input.minCount) ||
      Option.isSome(input.maxCount);
    const failures = [
      ...(checksSpans
        ? matchedSpanFailures(
            model.spans.filter(selectorPredicate(input, model)),
            describeSelector(input),
            input,
            model,
          )
        : []),
      ...(input.open
        ? []
        : model.spans
            .filter((span) => traceSpanStatus(span) === "open")
            .map(
              (span) =>
                `open span: ${span.name} ${span.spanId.slice(0, 8)} (started ${new Date(span.startMs).toISOString()})`,
            )),
      ...Option.match(input.order, {
        onNone: () => [],
        onSome: (order) => orderFailures(order, model),
      }),
    ];
    if (failures.length > 0)
      return yield* new TraceCheckFailed({ failures, file });
    if (!input.quiet) yield* Console.log("trace assert ok");
  }),
).pipe(Command.withDescription("Exit non-zero unless the trace matches"));

// ---- tail -------------------------------------------------------------------

const TAIL_POLL_INTERVAL = "200 millis";

const tailCommand = Command.make(
  "tail",
  sourceFlags,
  Effect.fn("TraceCli.tail")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* resolveTraceFile(input);
    const color = { color: yield* colorEnabled };
    const offset = yield* Ref.make(0);
    const carry = yield* Ref.make("");
    const depths = new Map<string, number>();
    const drain = Effect.gen(function* () {
      const size = Number((yield* fs.stat(file)).size);
      const from = yield* Ref.get(offset);
      if (size <= from) return;
      const bytes = yield* fs
        .stream(file, { offset: from, bytesToRead: size - from })
        .pipe(Stream.decodeText(), Stream.mkString);
      yield* Ref.set(offset, size);
      const lines = ((yield* Ref.get(carry)) + bytes).split("\n");
      yield* Ref.set(carry, lines.pop() ?? "");
      for (const record of parseTraceRecords(lines.join("\n"))) {
        if (record.kind === "start") {
          const parentDepth = Option.flatMap(record.parentSpanId, (id) =>
            Option.fromUndefinedOr(depths.get(id)),
          );
          depths.set(
            record.spanId,
            Option.match(parentDepth, {
              onNone: () => 0,
              onSome: (depth) => depth + 1,
            }),
          );
        }
        yield* Console.log(
          formatTraceRecordLine(record, depths.get(record.spanId) ?? 0, color),
        );
      }
    }).pipe(Effect.catchTag("PlatformError", () => Effect.void));
    yield* Effect.forever(
      drain.pipe(Effect.andThen(Effect.sleep(TAIL_POLL_INTERVAL))),
    );
  }),
).pipe(Command.withDescription("Follow the trace file live"));

// ---- run --------------------------------------------------------------------

const runCommand = Command.make(
  "run",
  {
    file: Flag.String("file").pipe(
      Flag.withDescription("Trace file to write (default: a fresh run file)"),
      Flag.optional,
    ),
    append: Flag.Boolean("append").pipe(
      Flag.withDescription("Keep what the file already holds"),
      Flag.withDefault(false),
    ),
    quiet: Flag.Boolean("quiet").pipe(
      Flag.withDescription("Do not print the tree afterwards"),
      Flag.withDefault(false),
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The command and its arguments, after --"),
      Argument.variadic({ min: 1 }),
    ),
  },
  Effect.fn("TraceCli.run")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = yield* Option.match(input.file, {
      onSome: (given) => Effect.succeed(path.resolve(given)),
      onNone: () =>
        Effect.gen(function* () {
          const stamp = new Date(yield* Clock.currentTimeMillis)
            .toISOString()
            .replace(/[:.]/g, "-");
          return path.join(
            yield* traceRunDirectory,
            `${stamp}-${process.pid}.ndjson`,
          );
        }),
    });
    yield* fs.makeDirectory(path.dirname(file), {
      recursive: true,
      mode: TRACE_DIRECTORY_MODE,
    });
    if (!input.append || !(yield* fs.exists(file)))
      yield* fs.writeFileString(file, "", { mode: 0o600 });

    const [program = "", ...args] = input.command;
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(program, args, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          extendEnv: true,
          env: { PI_CLAUDE_CLI_TRACE: file },
          // Same process group, so Ctrl-C reaches the traced command.
          detached: false,
        }),
      )
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new TraceUsageError({
              message: `cannot run ${program}: ${error.message}`,
            }),
          ),
        ),
      );

    if (!input.quiet) {
      const model = yield* loadTraceFile(file);
      yield* Console.error(`\n--- trace ${file} ---`);
      yield* Console.error(
        model.spans.length === 0
          ? "(no spans recorded)"
          : renderTraceTrees(model.roots, model, {
              color: false,
              events: true,
              attributes: true,
            }),
      );
    }
    if (exitCode !== 0)
      return yield* new TracedCommandFailed({ exitCode: Number(exitCode) });
  }),
).pipe(
  Command.withDescription(
    "Create a fresh trace file, set PI_CLAUDE_CLI_TRACE, run the command, print the tree, exit with the command's status",
  ),
);

// ---- main -------------------------------------------------------------------

const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect and assert on pi-claude-cli span traces"),
  Command.withSubcommands([
    runCommand,
    treeCommand,
    lsCommand,
    spansCommand,
    openCommand,
    tailCommand,
    statsCommand,
    assertCommand,
  ]),
);

const traceCliLayer = Layer.mergeAll(
  nodeFileSystemLayer,
  NodeStdio.layer,
  NodeTerminal.layer,
  crossSpawnSpawnerLayer,
);

const main = Command.run(traceCommand, { version: "1" }).pipe(
  Effect.tapErrorTag("TraceUsageError", (error) =>
    Console.error(`trace: ${error.message}`),
  ),
  Effect.tapErrorTag("TraceCheckFailed", (error) =>
    Console.error(
      [
        ...error.failures.map((failure) => `trace FAILED: ${failure}`),
        `  file: ${error.file}`,
      ].join("\n"),
    ),
  ),
  Effect.provide(traceCliLayer),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
