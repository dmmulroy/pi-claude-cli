/** Text rendering of spans for the trace CLI: trees, one-liners, tables. */

import { Option } from "effect";
import {
  traceAttributeText,
  traceSpanDurationMs,
  traceSpanStatus,
  type TraceModel,
  type TraceRecord,
  type TraceSpan,
  type TraceSpanEvent,
  type TraceSpanStatus,
} from "./trace-model.ts";

/** What a rendering includes. */
export interface TraceRenderOptions {
  readonly color: boolean;
  readonly events: boolean;
  readonly attributes: boolean;
}

const paint = (options: { readonly color: boolean }, code: string, text: string) =>
  options.color ? `\x1b[${code}m${text}\x1b[0m` : text;

const dim = (options: { readonly color: boolean }, text: string) => paint(options, "2", text);

/** `1.50ms`, `42ms` or `1.25s`. */
export const formatTraceMillis = (millis: number): string => {
  if (millis < 1) return `${millis.toFixed(2)}ms`;
  if (millis < 1000) return `${Math.round(millis)}ms`;
  return `${(millis / 1000).toFixed(2)}s`;
};

const STATUS_STYLE: Record<TraceSpanStatus, readonly [string, string]> = {
  ok: ["32", "ok"],
  error: ["31", "ERROR"],
  interrupted: ["33", "interrupted"],
  open: ["35", "OPEN"],
};

/** A status as shown in every listing; open spans are flagged `OPEN`. */
export const formatTraceStatus = (
  status: TraceSpanStatus,
  options: { readonly color: boolean },
): string => paint(options, STATUS_STYLE[status][0], STATUS_STYLE[status][1]);

const formatAttributes = (
  attributes: Readonly<Record<string, unknown>>,
  hidden: (key: string) => boolean,
): string =>
  Object.entries(attributes)
    .filter(([key]) => !hidden(key))
    .map(([key, value]) => `${key}=${traceAttributeText(value)}`)
    .join(" ");

/** Span attributes as `k=v` pairs, without Effect's source locations. */
export const formatTraceSpanAttributes = (attributes: Readonly<Record<string, unknown>>): string =>
  formatAttributes(attributes, (key) => key.startsWith("code."));

/** Event attributes as `k=v` pairs, without the fiber id and log level. */
export const formatTraceEventAttributes = (attributes: Readonly<Record<string, unknown>>): string =>
  formatAttributes(attributes, (key) => key === "effect.fiberId" || key === "effect.logLevel");

const spanSummary = (span: TraceSpan, model: TraceModel, options: TraceRenderOptions): string =>
  [
    span.name,
    dim(options, formatTraceMillis(traceSpanDurationMs(span, model))),
    formatTraceStatus(traceSpanStatus(span), options),
    options.attributes ? formatTraceSpanAttributes(span.attributes) : "",
  ]
    .filter((part) => part.length > 0)
    .join("  ");

/** One line for a span: trace id, span id, name, duration, status, attributes. */
export const formatTraceSpanLine = (
  span: TraceSpan,
  model: TraceModel,
  options: TraceRenderOptions,
): string =>
  `${span.traceId.slice(0, 8)} ${span.spanId.slice(0, 8)}  ${spanSummary(span, model, options)}`;

interface EventRun {
  readonly name: string;
  readonly attributes: string;
  readonly count: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

/** Consecutive identical events collapse to one `name ×N` line. */
const collapseEvents = (events: ReadonlyArray<TraceSpanEvent>): ReadonlyArray<EventRun> => {
  const runs: Array<EventRun> = [];
  for (const event of events) {
    const attributes = formatTraceEventAttributes(event.attributes);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.name === event.name && last.attributes === attributes) {
      runs[runs.length - 1] = {
        ...last,
        count: last.count + 1,
        lastMs: event.timeMs,
      };
    } else {
      runs.push({
        name: event.name,
        attributes,
        count: 1,
        firstMs: event.timeMs,
        lastMs: event.timeMs,
      });
    }
  }
  return runs;
};

type TimelineItem =
  | { readonly atMs: number; readonly _tag: "Events"; readonly run: EventRun }
  | { readonly atMs: number; readonly _tag: "Child"; readonly span: TraceSpan };

const renderSpanTree = (
  span: TraceSpan,
  model: TraceModel,
  options: TraceRenderOptions,
  prefix: string,
  childPrefix: string,
): ReadonlyArray<string> => {
  const lines = [prefix + spanSummary(span, model, options)];
  const error = Option.flatMap(span.end, (end) => end.error);
  if (Option.isSome(error)) {
    for (const line of error.value.split("\n").slice(0, 6))
      lines.push(childPrefix + paint(options, "31", `  ! ${line}`));
  }
  for (const link of span.links) {
    const target = model.byId.get(link.spanId);
    lines.push(
      childPrefix + dim(options, `  → links ${target?.name ?? "span"} ${link.spanId.slice(0, 8)}`),
    );
  }
  // Events and children share one timeline.
  const items: Array<TimelineItem> = [
    ...(options.events ? collapseEvents(span.events) : []).map((run): TimelineItem => ({
      atMs: run.firstMs,
      _tag: "Events",
      run,
    })),
    ...(model.childrenOf.get(span.spanId) ?? []).map((child): TimelineItem => ({
      atMs: child.startMs,
      _tag: "Child",
      span: child,
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    const branch = childPrefix + (last ? "└─ " : "├─ ");
    const nested = childPrefix + (last ? "   " : "│  ");
    if (item._tag === "Child") {
      lines.push(...renderSpanTree(item.span, model, options, branch, nested));
      return;
    }
    const { run } = item;
    const offset = `+${formatTraceMillis(run.firstMs - span.startMs)}`;
    const repeat =
      run.count > 1 ? ` ×${run.count} (to +${formatTraceMillis(run.lastMs - span.startMs)})` : "";
    lines.push(
      branch +
        dim(options, `· ${offset} `) +
        run.name +
        dim(options, repeat) +
        (run.attributes.length > 0 ? dim(options, `  ${run.attributes}`) : ""),
    );
  });
  return lines;
};

/** Indented span trees, one per root, each under a `trace <id>` heading. */
export const renderTraceTrees = (
  roots: ReadonlyArray<TraceSpan>,
  model: TraceModel,
  options: TraceRenderOptions,
): string =>
  roots
    .flatMap((root) => [
      dim(
        options,
        `trace ${root.traceId.slice(0, 8)}  pid ${root.pid}  ${new Date(root.startMs).toISOString()}`,
      ),
      ...renderSpanTree(root, model, options, "", ""),
      "",
    ])
    .join("\n");

/** Right-align every column but the first. */
export const renderTraceTable = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
};

/**
 * One line for a record as it is written, for `trace tail`. `depth` is the
 * nesting of the record's span.
 */
export const formatTraceRecordLine = (
  record: TraceRecord,
  depth: number,
  options: { readonly color: boolean },
): string => {
  const indent = "  ".repeat(depth);
  const time = dim(options, new Date(record.timeMs).toISOString().slice(11, 23));
  switch (record.kind) {
    case "start":
      return `${time} ${indent}▶ ${record.name}`;
    case "event":
      return `${time} ${indent}${dim(options, `· ${record.name} ${formatTraceEventAttributes(record.attributes)}`)}`;
    case "end": {
      const error = Option.match(record.error, {
        onNone: () => "",
        onSome: (text) => `\n${indent}    ! ${text.split("\n")[0] ?? ""}`,
      });
      return `${time} ${indent}◀ ${record.name}  ${formatTraceMillis(record.durMs)}  ${formatTraceStatus(record.status, options)}  ${formatTraceSpanAttributes(record.attributes)}${error}`;
    }
  }
};
