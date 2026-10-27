/**
 * The turn relay: a loopback HTTP route between one CLI process and the
 * Anthropic API (`PI_CLAUDE_CLI_RELAY`).
 *
 * The CLI is launched with `ANTHROPIC_BASE_URL` pointing at
 * `http://127.0.0.1:<port>/relay/<random>`, and the relay forwards what it
 * receives to the official API origin, and nothing else. The CLI keeps its
 * own subscription login: the relay forwards its authorization header as it
 * came and never stores, logs or traces it.
 *
 * In `shadow` mode the relay changes nothing on the wire. It records each
 * request as content-free facts (status, timings, usage, and a layout of
 * hashes showing where requests share a prefix) so the prompt cache can be
 * explained from a trace. `PI_CLAUDE_CLI_RELAY_DUMP=<dir>` also writes each
 * request body to a 0600 file there: conversation content, for debugging
 * only.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect, Queue, Schema, type Scope } from "effect";
import { canonicalSessionContext, type RewriteOutcome } from "./relay-rewrite.ts";

/** The only origin the relay forwards to. */
const UPSTREAM = new URL("https://api.anthropic.com");

/** Largest request body the relay accepts from the CLI. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** Longest wait for upstream response headers. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;
/** Longest upstream silence once a response is streaming. */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
  "keep-alive",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "content-length",
]);

/** One request the CLI made through the relay, without its content. */
export interface RelayRequestRecord {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Set when the request failed in the relay or upstream. */
  readonly failure?: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly ttfbMs: number;
  readonly durationMs: number;
  readonly requestId?: string;
  readonly layout?: RequestLayout;
  readonly usage?: RelayUsage;
  readonly stopReason?: string;
  readonly streamError?: string;
  /** What the rewrites did, when they are on. */
  readonly rewrite?: RewriteOutcome;
}

/** Usage as the API reported it for one response. */
export interface RelayUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
}

/**
 * The shape of a Messages request as hashes: equal hashes at the same
 * position mean the same bytes, so two requests share a cacheable prefix up
 * to their first difference.
 */
export interface RequestLayout {
  readonly model: string;
  readonly maxTokens?: number;
  readonly thinking: string;
  readonly betas: string;
  /** One 8-hex hash per system block. */
  readonly system: ReadonlyArray<string>;
  /** One hash over every tool definition, in order. */
  readonly tools: string;
  readonly toolCount: number;
  /** One hash per message, role-prefixed (`u:`, `a:`). */
  readonly messages: ReadonlyArray<string>;
  /** Where the cache breakpoints are: `s<i>`, `t<i>`, `m<i>.<j>`, with ttl. */
  readonly cacheMarkers: ReadonlyArray<string>;
}

/** A relay in front of one CLI process. */
export interface TurnRelay {
  /** The `ANTHROPIC_BASE_URL` for the CLI. */
  readonly baseUrl: string;
  /** Every finished request, in order. */
  readonly records: Queue.Dequeue<RelayRequestRecord>;
}

// ---- request layout ----------------------------------------------------------

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const MessagesRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  max_tokens: Schema.optional(Schema.Number),
  thinking: Schema.optional(UnknownRecord),
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(UnknownRecord)])),
  tools: Schema.optional(Schema.Array(UnknownRecord)),
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.Union([Schema.String, Schema.Array(UnknownRecord)]),
      }),
    ),
  ),
});
const decodeMessagesRequest = Schema.decodeUnknownOption(Schema.fromJsonString(MessagesRequest));

/** A value's hash with its `cache_control` left out, so markers do not change it. */
const shortHash = (value: unknown): string =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (key, inner: unknown) => (key === "cache_control" ? undefined : inner)),
    )
    .digest("hex")
    .slice(0, 8);

const cacheMarker = (block: Record<string, unknown>): string | undefined => {
  const control = block["cache_control"];
  if (typeof control !== "object" || control === null) return undefined;
  const ttl = (control as Record<string, unknown>)["ttl"];
  return typeof ttl === "string" ? ttl : "5m";
};

/** The layout of a Messages request body, or none if it is not one. */
export const requestLayout = (body: string, betas: string): RequestLayout | undefined => {
  const decoded = decodeMessagesRequest(body);
  if (decoded._tag === "None") return undefined;
  const request = decoded.value;
  const markers: string[] = [];
  const systemBlocks =
    typeof request.system === "string"
      ? [{ type: "text", text: request.system }]
      : (request.system ?? []);
  systemBlocks.forEach((block, index) => {
    const ttl = cacheMarker(block);
    if (ttl !== undefined) markers.push(`s${index}:${ttl}`);
  });
  const tools = request.tools ?? [];
  tools.forEach((tool, index) => {
    const ttl = cacheMarker(tool);
    if (ttl !== undefined) markers.push(`t${index}:${ttl}`);
  });
  const messages = request.messages ?? [];
  messages.forEach((message, index) => {
    if (typeof message.content === "string") return;
    message.content.forEach((block, inner) => {
      const ttl = cacheMarker(block);
      if (ttl !== undefined) markers.push(`m${index}.${inner}:${ttl}`);
    });
  });
  return {
    model: request.model ?? "",
    ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
    thinking: typeof request.thinking?.["type"] === "string" ? request.thinking["type"] : "none",
    betas,
    system: systemBlocks.map(shortHash),
    tools: shortHash(tools),
    toolCount: tools.length,
    messages: messages.map(
      (message) => `${message.role.slice(0, 1)}:${shortHash(message.content)}`,
    ),
    cacheMarkers: markers,
  };
};

// ---- response capture --------------------------------------------------------

const UsageFields = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ ephemeral_1h_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)) }),
    ),
  ),
});
const SseEvent = Schema.Struct({
  type: Schema.String,
  message: Schema.optional(Schema.Struct({ usage: Schema.optional(UsageFields) })),
  usage: Schema.optional(UsageFields),
  delta: Schema.optional(
    Schema.Struct({ stop_reason: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
  error: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
});
const decodeSseEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SseEvent));

/** Reads usage and the stop reason from an SSE stream as it passes. */
const sseCapture = () => {
  const decoder = new TextDecoder();
  let pending = "";
  let usage: RelayUsage | undefined;
  let stopReason: string | undefined;
  let streamError: string | undefined;

  const merge = (fields: typeof UsageFields.Type) => {
    const previous = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    usage = {
      input: fields.input_tokens ?? previous.input,
      output: fields.output_tokens ?? previous.output,
      cacheRead: fields.cache_read_input_tokens ?? previous.cacheRead,
      cacheWrite: fields.cache_creation_input_tokens ?? previous.cacheWrite,
      cacheWrite1h: fields.cache_creation?.ephemeral_1h_input_tokens ?? previous.cacheWrite1h,
    };
  };

  const consume = () => {
    while (true) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (match === null) return;
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length === 0) continue;
      const event = decodeSseEvent(data);
      if (event._tag === "None") continue;
      const { type } = event.value;
      if (type === "message_start" && event.value.message?.usage !== undefined)
        merge(event.value.message.usage);
      else if (type === "message_delta") {
        if (event.value.usage !== undefined) merge(event.value.usage);
        if (typeof event.value.delta?.stop_reason === "string")
          stopReason = event.value.delta.stop_reason;
      } else if (type === "error") streamError = event.value.error?.type ?? "error";
    }
  };

  return {
    feed: (chunk: Buffer) => {
      pending += decoder.decode(chunk, { stream: true });
      consume();
    },
    finish: () => {
      pending += decoder.decode();
      consume();
      return { usage, stopReason, streamError };
    },
  };
};

// ---- the server --------------------------------------------------------------

/** Where this relay dumps request bodies, under the dump root if one is set. */
const dumpDirectory = (root: string | undefined, label: string): string | undefined => {
  if (root === undefined) return undefined;
  const directory = join(root, label);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
};

const readBody = (request: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("RequestTooLarge"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });

const headerText = (value: string | ReadonlyArray<string> | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : value.join(",");

export interface TurnRelayOptions {
  /** Names the dump directory, when dumping is on. */
  readonly label: string;
  /** `PI_CLAUDE_CLI_RELAY_DUMP`: where request bodies are written. */
  readonly dumpRoot: string | undefined;
  /** Apply the request rewrites of `src/relay-rewrite.ts`. */
  readonly rewrite: boolean;
}

/**
 * Start a relay for one CLI process, closed with the scope: open sockets are
 * destroyed and the port released.
 */
export const startTurnRelay = ({
  label,
  dumpRoot,
  rewrite,
}: TurnRelayOptions): Effect.Effect<TurnRelay, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const records = yield* Queue.unbounded<RelayRequestRecord>();
    const route = `/relay/${randomBytes(24).toString("base64url")}`;
    const sockets = new Set<{ destroy: () => void }>();
    const dump = dumpDirectory(dumpRoot, label);
    let sequence = 0;

    const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
      const startedAt = Date.now();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      // Only the CLI, on the secret route; never a browser.
      if (!url.pathname.startsWith(`${route}/`) || request.headers.origin !== undefined) {
        response.writeHead(404).end();
        return;
      }
      const path = url.pathname.slice(route.length);
      const number = ++sequence;
      const base = { sequence: number, method: request.method ?? "GET", path };
      let requestBytes = 0;
      let responseBytes = 0;
      let ttfbMs = 0;
      let layout: RequestLayout | undefined;
      let upstream: http.ClientRequest | undefined;
      let rewriteOutcome: RewriteOutcome | undefined;
      try {
        let body = await readBody(request);
        if (rewrite && path === "/v1/messages") {
          const rewritten = canonicalSessionContext(body.toString("utf8"));
          rewriteOutcome = rewritten.outcome;
          if (rewritten.outcome === "moved") body = Buffer.from(rewritten.body, "utf8");
        }
        requestBytes = body.length;
        if (path === "/v1/messages")
          layout = requestLayout(
            body.toString("utf8"),
            headerText(request.headers["anthropic-beta"]),
          );
        if (dump !== undefined)
          writeFileSync(
            join(dump, `${String(number).padStart(4, "0")}${path.replaceAll("/", "_")}.json`),
            body,
            {
              mode: 0o600,
            },
          );

        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(request.headers))
          if (value !== undefined && !STRIPPED_REQUEST_HEADERS.has(name.toLowerCase()))
            headers[name] = value;
        headers["accept-encoding"] = "identity";
        headers["content-length"] = body.length;

        const outgoing = https.request({
          protocol: UPSTREAM.protocol,
          hostname: UPSTREAM.hostname,
          method: request.method,
          path: `${path}${url.search}`,
          headers,
        });
        upstream = outgoing;
        sockets.add(outgoing);
        const headersTimer = setTimeout(
          () => outgoing.destroy(new Error("UpstreamHeadersTimeout")),
          UPSTREAM_HEADERS_TIMEOUT_MS,
        );
        const upstreamResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
          outgoing.once("response", resolve);
          outgoing.once("error", reject);
          outgoing.end(body);
        }).finally(() => clearTimeout(headersTimer));
        sockets.add(upstreamResponse);
        ttfbMs = Date.now() - startedAt;
        outgoing.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () =>
          outgoing.destroy(new Error("UpstreamIdleTimeout")),
        );

        const status = upstreamResponse.statusCode ?? 502;
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers))
          if (value !== undefined && !STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
            responseHeaders[name] = value;
        response.writeHead(status, responseHeaders);
        const streaming = headerText(upstreamResponse.headers["content-type"]).includes(
          "text/event-stream",
        );
        const capture = sseCapture();
        for await (const raw of upstreamResponse) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          responseBytes += chunk.length;
          if (streaming) capture.feed(chunk);
          if (!response.write(chunk))
            await new Promise<void>((resolve, reject) => {
              response.once("drain", resolve);
              response.once("close", () => reject(new Error("DownstreamClosed")));
            });
        }
        response.end();
        const captured = streaming ? capture.finish() : {};
        const requestId = headerText(upstreamResponse.headers["request-id"]);
        Queue.offerUnsafe(records, {
          ...base,
          status,
          requestBytes,
          responseBytes,
          ttfbMs,
          durationMs: Date.now() - startedAt,
          ...(requestId.length > 0 ? { requestId } : {}),
          ...(layout !== undefined ? { layout } : {}),
          ...(rewriteOutcome !== undefined ? { rewrite: rewriteOutcome } : {}),
          ...captured,
        });
      } catch (error) {
        const failure = error instanceof Error ? error.message || error.name : "UnknownError";
        if (!response.headersSent) response.writeHead(502).end();
        else response.destroy();
        Queue.offerUnsafe(records, {
          ...base,
          status: 502,
          failure,
          requestBytes,
          responseBytes,
          ttfbMs,
          durationMs: Date.now() - startedAt,
          ...(layout !== undefined ? { layout } : {}),
        });
      } finally {
        if (upstream !== undefined) sockets.delete(upstream);
      }
    };

    const server = yield* Effect.acquireRelease(
      Effect.callback<http.Server, Error>((resume) => {
        const created = http.createServer((request, response) => {
          sockets.add(request.socket);
          request.socket.once("close", () => sockets.delete(request.socket));
          void handle(request, response);
        });
        created.once("error", (error) => resume(Effect.fail(error)));
        created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
      }),
      (created) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          created.close(() => resume(Effect.void));
        }),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}${route}`, records };
  });
