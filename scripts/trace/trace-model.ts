/**
 * The trace file as spans: decoding of the NDJSON records written by
 * `src/tracing.ts`, folding them into spans, and span selectors.
 */

import { Array as Arr, Option, Schema } from "effect";

const TraceSpanLink = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
});

const TraceAttributes = Schema.Record(Schema.String, Schema.Unknown);

const TraceRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    name: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.OptionFromNullOr(Schema.String),
    pid: Schema.Number,
    timeMs: Schema.Number,
    links: Schema.Array(TraceSpanLink),
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    name: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    pid: Schema.Number,
    timeMs: Schema.Number,
    attributes: TraceAttributes,
  }),
  Schema.Struct({
    kind: Schema.Literal("end"),
    name: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.OptionFromNullOr(Schema.String),
    pid: Schema.Number,
    timeMs: Schema.Number,
    durMs: Schema.Number,
    status: Schema.Literals(["ok", "error", "interrupted"]),
    error: Schema.OptionFromNullOr(Schema.String),
    attributes: TraceAttributes,
    links: Schema.Array(TraceSpanLink),
  }),
]);

/** One decoded line of a trace file. */
export type TraceRecord = typeof TraceRecord.Type;

const decodeTraceRecordLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(TraceRecord),
);

/**
 * Decode the lines of a trace file. Lines that are not records are skipped:
 * the last line may be torn while the writer is still running.
 */
export const parseTraceRecords = (text: string): ReadonlyArray<TraceRecord> =>
  Arr.getSomes(
    text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => decodeTraceRecordLine(line)),
  );

/** How a span ended; `open` means it started and no end was recorded. */
export type TraceSpanStatus = "ok" | "error" | "interrupted" | "open";

/** A log line or wire message recorded on a span. */
export interface TraceSpanEvent {
  readonly name: string;
  readonly timeMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** The outcome of a span that ended. */
export interface TraceSpanEnd {
  readonly endMs: number;
  readonly durMs: number;
  readonly status: "ok" | "error" | "interrupted";
  readonly error: Option.Option<string>;
}

/** One span, assembled from its start, event and end records. */
export interface TraceSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: Option.Option<string>;
  readonly pid: number;
  readonly startMs: number;
  /** None while the span is open. */
  readonly end: Option.Option<TraceSpanEnd>;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<TraceSpanEvent>;
  readonly links: ReadonlyArray<typeof TraceSpanLink.Type>;
}

/** Every span of a trace file, with the lookups the commands need. */
export interface TraceModel {
  /** All spans, by start time. */
  readonly spans: ReadonlyArray<TraceSpan>;
  /** Spans with no recorded parent, by start time. */
  readonly roots: ReadonlyArray<TraceSpan>;
  readonly byId: ReadonlyMap<string, TraceSpan>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<TraceSpan>>;
  /** Time of the newest record: the "now" an open span is measured against. */
  readonly lastMs: number;
}

/** Fold records into spans. Events of a span with no start record are dropped. */
export const foldTraceRecords = (
  records: ReadonlyArray<TraceRecord>,
): TraceModel => {
  const byId = new Map<string, TraceSpan>();
  let lastMs = 0;
  for (const record of records) {
    lastMs = Math.max(lastMs, record.timeMs);
    const existing = Option.fromUndefinedOr(byId.get(record.spanId));
    switch (record.kind) {
      case "start":
        byId.set(record.spanId, {
          name: record.name,
          traceId: record.traceId,
          spanId: record.spanId,
          parentSpanId: record.parentSpanId,
          pid: record.pid,
          startMs: record.timeMs,
          end: Option.none(),
          attributes: {},
          events: [],
          links: record.links,
        });
        break;
      case "event":
        if (Option.isSome(existing)) {
          byId.set(record.spanId, {
            ...existing.value,
            events: [
              ...existing.value.events,
              {
                name: record.name,
                timeMs: record.timeMs,
                attributes: record.attributes,
              },
            ],
          });
        }
        break;
      case "end":
        byId.set(record.spanId, {
          name: record.name,
          traceId: record.traceId,
          spanId: record.spanId,
          parentSpanId: record.parentSpanId,
          pid: record.pid,
          startMs: Option.match(existing, {
            onNone: () => record.timeMs - record.durMs,
            onSome: (span) => span.startMs,
          }),
          end: Option.some({
            endMs: record.timeMs,
            durMs: record.durMs,
            status: record.status,
            error: record.error,
          }),
          attributes: record.attributes,
          events: Option.match(existing, {
            onNone: () => [],
            onSome: (span) => span.events,
          }),
          links: record.links,
        });
        break;
    }
  }
  const spans = [...byId.values()].sort((a, b) => a.startMs - b.startMs);
  const childrenOf = new Map<string, Array<TraceSpan>>();
  const roots: Array<TraceSpan> = [];
  for (const span of spans) {
    const parent = Option.filter(span.parentSpanId, (id) => byId.has(id));
    if (Option.isNone(parent)) {
      roots.push(span);
      continue;
    }
    const siblings = childrenOf.get(parent.value) ?? [];
    siblings.push(span);
    childrenOf.set(parent.value, siblings);
  }
  return { spans, roots, byId, childrenOf, lastMs };
};

/** `ok`, `error`, `interrupted`, or `open` for a span that never ended. */
export const traceSpanStatus = (span: TraceSpan): TraceSpanStatus =>
  Option.match(span.end, {
    onNone: () => "open" as const,
    onSome: (end) => end.status,
  });

/** A span's duration; an open span is measured up to the newest record. */
export const traceSpanDurationMs = (
  span: TraceSpan,
  model: TraceModel,
): number =>
  Option.match(span.end, {
    onNone: () => model.lastMs - span.startMs,
    onSome: (end) => end.durMs,
  });

/** A span and everything below it, depth first. */
export const traceSpanDescendants = (
  span: TraceSpan,
  model: TraceModel,
): ReadonlyArray<TraceSpan> => [
  span,
  ...(model.childrenOf.get(span.spanId) ?? []).flatMap((child) =>
    traceSpanDescendants(child, model),
  ),
];

/** Render an attribute value the way selectors compare it. */
export const traceAttributeText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * Read an attribute as text. `pid` falls back to the pi process that wrote
 * the span when the span carries no `pid` attribute of its own.
 */
export const readTraceAttribute = (
  span: TraceSpan,
  key: string,
): Option.Option<string> => {
  if (key in span.attributes)
    return Option.some(traceAttributeText(span.attributes[key]));
  return key === "pid" ? Option.some(String(span.pid)) : Option.none();
};

/** A test over spans. */
export type TraceSpanPredicate = (span: TraceSpan) => boolean;

const globPattern = (glob: string): RegExp =>
  new RegExp(
    `^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );

/** Span name test; `*` matches any run of characters. */
export const traceNamePredicate = (glob: string): TraceSpanPredicate => {
  const pattern = globPattern(glob);
  return (span) => pattern.test(span.name);
};

/** Test for a span carrying an event whose name matches the glob. */
export const traceEventPredicate = (glob: string): TraceSpanPredicate => {
  const pattern = globPattern(glob);
  return (span) => span.events.some((event) => pattern.test(event.name));
};

/**
 * Attribute test from `k=v`, `k!=v`, `k~regex`, bare `k` (present) or `!k`
 * (absent).
 */
export const traceAttributePredicate = (
  expression: string,
): TraceSpanPredicate => {
  if (expression.startsWith("!")) {
    const key = expression.slice(1);
    return (span) => Option.isNone(readTraceAttribute(span, key));
  }
  const match = /^([^=!~]+)(!=|=|~)(.*)$/s.exec(expression);
  if (match === null)
    return (span) => Option.isSome(readTraceAttribute(span, expression));
  const [, key = "", operator, value = ""] = match;
  if (operator === "=")
    return (span) => Option.contains(readTraceAttribute(span, key), value);
  if (operator === "!=")
    return (span) => !Option.contains(readTraceAttribute(span, key), value);
  const pattern = new RegExp(value);
  return (span) =>
    Option.exists(readTraceAttribute(span, key), (actual) =>
      pattern.test(actual),
    );
};

/** A parsed `name[k=v,...]` selector, optionally ordered by `:end`. */
export interface TraceSelector {
  readonly text: string;
  readonly orderBy: "start" | "end";
  readonly matches: TraceSpanPredicate;
}

/** Parse `name[k=v,k2=v2]`, optionally suffixed `:start` or `:end`. */
export const parseTraceSelector = (text: string): TraceSelector => {
  const suffix = /:(start|end)$/.exec(text);
  const body = suffix === null ? text : text.slice(0, suffix.index);
  const bracket = /^([^[]*)(?:\[(.*)\])?$/s.exec(body);
  const name = bracket?.[1] ?? "";
  const attributes = (bracket?.[2] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(traceAttributePredicate);
  const nameMatches = name === "" ? () => true : traceNamePredicate(name);
  return {
    text,
    orderBy: suffix?.[1] === "end" ? "end" : "start",
    matches: (span) =>
      nameMatches(span) && attributes.every((test) => test(span)),
  };
};

/** Split a comma-separated selector list on commas outside `[...]`. */
export const splitTraceSelectors = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
};

/** Test for a span that has an ancestor matching the selector. */
export const traceAncestorPredicate = (
  selector: TraceSelector,
  model: TraceModel,
): TraceSpanPredicate => {
  const hasAncestor = (span: TraceSpan): boolean =>
    Option.match(
      Option.flatMap(span.parentSpanId, (id) =>
        Option.fromUndefinedOr(model.byId.get(id)),
      ),
      {
        onNone: () => false,
        onSome: (parent) => selector.matches(parent) || hasAncestor(parent),
      },
    );
  return hasAncestor;
};
