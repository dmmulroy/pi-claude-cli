/**
 * The Claude Code CLI's stream-json wire format: decoding of stdout lines and
 * construction of stdin lines.
 *
 * The format is undocumented and changes between CLI versions, so decoding is
 * lenient everywhere: a line that is not JSON, an envelope of an unknown type
 * and an envelope whose body no longer matches all degrade to "nothing to do"
 * and never fail an episode.
 */

import { Option, Schema } from "effect";
import type { ThinkingControl } from "./thinking-config.ts";

// ---- stdout: model stream ---------------------------------------------------

const TokenCount = Schema.optional(Schema.NullOr(Schema.Number));

const ClaudeUsage = Schema.Struct({
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  cache_read_input_tokens: TokenCount,
  cache_creation_input_tokens: TokenCount,
});

/** Token counts of one API call or one turn, as the Anthropic API names them. */
export type ClaudeUsage = typeof ClaudeUsage.Type;

const ClaudeModelUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadInputTokens: TokenCount,
  cacheCreationInputTokens: TokenCount,
});

/**
 * Per-model spend, keyed by model id in `result.modelUsage`. The only place
 * the CLI accounts for work outside the main agent's transcript (sub-agents,
 * helper models); cumulative for the process.
 */
export type ClaudeModelUsage = typeof ClaudeModelUsage.Type;

const ClaudeApiEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  message: Schema.optional(
    Schema.Struct({ usage: Schema.optional(Schema.NullOr(ClaudeUsage)) }),
  ),
  content_block: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
  delta: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      partial_json: Schema.optional(Schema.String),
      thinking: Schema.optional(Schema.String),
      signature: Schema.optional(Schema.String),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  usage: Schema.optional(Schema.NullOr(ClaudeUsage)),
});

/**
 * One Anthropic streaming event (`message_start`, `content_block_delta`, …).
 * Only the fields the event bridge reads are described; event and delta types
 * it does not know pass through and are ignored there.
 */
export type ClaudeApiEvent = typeof ClaudeApiEvent.Type;

const ClaudeResultMessage = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
  /** Usage of the MAIN agent for the turn. */
  usage: Schema.optional(Schema.NullOr(ClaudeUsage)),
  /** Per-model spend for the process so far, sub-agents included. */
  modelUsage: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, ClaudeModelUsage)),
  ),
});

/** The `result` envelope that ends a turn. */
export type ClaudeResultMessage = typeof ClaudeResultMessage.Type;

// ---- stdout: control channel ------------------------------------------------

const JsonRpcId = Schema.Union([Schema.String, Schema.Number]);

/** A JSON-RPC request id, as MCP uses it. */
export type JsonRpcId = typeof JsonRpcId.Type;

const McpMessage = Schema.Struct({
  id: Schema.optional(JsonRpcId),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
});

/** One JSON-RPC message the CLI's MCP client sent to the in-band server. */
export type McpMessage = typeof McpMessage.Type;

const ToolPermissionRequestBody = Schema.Struct({
  request_id: Schema.String,
  request: Schema.Struct({
    subtype: Schema.Literal("can_use_tool"),
    tool_name: Schema.String,
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});

const McpRequestBody = Schema.Struct({
  request_id: Schema.String,
  request: Schema.Struct({
    subtype: Schema.Literal("mcp_message"),
    server_name: Schema.String,
    message: McpMessage,
  }),
});

const ControlResponseBody = Schema.Struct({
  response: Schema.Struct({
    subtype: Schema.String,
    request_id: Schema.String,
  }),
});

const Envelope = Schema.Struct({ type: Schema.String });
const StreamEventBody = Schema.Struct({ event: ClaudeApiEvent });

/** One decoded stdout line of the CLI. */
export type CliMessage =
  | { readonly _tag: "StreamEvent"; readonly event: ClaudeApiEvent }
  | { readonly _tag: "Result"; readonly result: ClaudeResultMessage }
  | {
      /** The CLI asks whether the model may call a tool. */
      readonly _tag: "ToolPermissionRequest";
      readonly requestId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      /** The CLI's MCP client talking to an in-band (`"type": "sdk"`) server. */
      readonly _tag: "McpRequest";
      readonly requestId: string;
      readonly serverName: string;
      readonly message: McpMessage;
    }
  | {
      /** The CLI's answer to a control request this provider sent. */
      readonly _tag: "ControlResponse";
      readonly requestId: string;
      readonly success: boolean;
    }
  | {
      /**
       * An envelope with nothing for pi's stream (`assistant`, `user`,
       * `system`, `rate_limit_event`, anything new). It still counts as
       * output for the inactivity timeout.
       */
      readonly _tag: "Other";
      readonly type: string;
    };

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodeStreamEvent = Schema.decodeUnknownOption(StreamEventBody);
const decodeResult = Schema.decodeUnknownOption(ClaudeResultMessage);
const decodeToolPermissionRequest = Schema.decodeUnknownOption(
  ToolPermissionRequestBody,
);
const decodeMcpRequest = Schema.decodeUnknownOption(McpRequestBody);
const decodeControlResponse = Schema.decodeUnknownOption(ControlResponseBody);

const decodeEnvelopeBody = (
  type: string,
  json: unknown,
): Option.Option<CliMessage> => {
  switch (type) {
    case "stream_event":
      return Option.map(decodeStreamEvent(json), ({ event }): CliMessage => ({
        _tag: "StreamEvent",
        event,
      }));
    case "result":
      return Option.map(decodeResult(json), (result): CliMessage => ({
        _tag: "Result",
        result,
      }));
    case "control_request":
      return Option.orElse(
        Option.map(decodeToolPermissionRequest(json), (body): CliMessage => ({
          _tag: "ToolPermissionRequest",
          requestId: body.request_id,
          toolName: body.request.tool_name,
          input: body.request.input ?? {},
        })),
        () =>
          Option.map(decodeMcpRequest(json), (body): CliMessage => ({
            _tag: "McpRequest",
            requestId: body.request_id,
            serverName: body.request.server_name,
            message: body.request.message,
          })),
      );
    case "control_response":
      return Option.map(decodeControlResponse(json), (body): CliMessage => ({
        _tag: "ControlResponse",
        requestId: body.response.request_id,
        success: body.response.subtype === "success",
      }));
    default:
      return Option.none();
  }
};

/**
 * Decode one stdout line. None for anything that is not a JSON envelope (the
 * CLI prints debug lines); an envelope that is unknown or malformed decodes
 * to `Other` so it still counts as output.
 */
export const decodeCliLine = (line: string): Option.Option<CliMessage> => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return Option.none();
  return decodeJson(trimmed).pipe(
    Option.flatMap((json) =>
      Option.map(decodeEnvelope(json), ({ type }) =>
        Option.getOrElse(decodeEnvelopeBody(type, json), (): CliMessage => ({
          _tag: "Other",
          type,
        })),
      ),
    ),
  );
};

/** The label a wire message is counted under in traces. */
export const cliMessageLabel = (message: CliMessage): string => {
  switch (message._tag) {
    case "StreamEvent":
      return "stream_event";
    case "Result":
      return "result";
    case "ToolPermissionRequest":
    case "McpRequest":
      return "control_request";
    case "ControlResponse":
      return "control_response";
    case "Other":
      return message.type;
  }
};

const McpToolCallParams = Schema.Struct({
  name: Schema.String,
  _meta: Schema.optional(
    Schema.Struct({
      "claudecode/toolUseId": Schema.optional(Schema.String),
    }),
  ),
});

const decodeMcpToolCallParams = Schema.decodeUnknownOption(McpToolCallParams);

/** What identifies an MCP `tools/call`: the tool and the block that asked. */
export interface McpToolCall {
  /** The pi tool name, without the MCP server prefix. */
  readonly name: string;
  /** The assistant `tool_use` block this call executes, when the CLI tags it. */
  readonly toolUseId: Option.Option<string>;
}

/** Read a `tools/call` request's params. Arguments stay with pi's own toolCall. */
export const decodeMcpToolCall = (
  params: unknown,
): Option.Option<McpToolCall> =>
  Option.map(decodeMcpToolCallParams(params), (decoded) => ({
    name: decoded.name,
    toolUseId: Option.fromUndefinedOr(decoded._meta?.["claudecode/toolUseId"]),
  }));

const McpCancelledParams = Schema.Struct({ requestId: JsonRpcId });
const decodeMcpCancelledParams = Schema.decodeUnknownOption(McpCancelledParams);

/** The request id a `notifications/cancelled` abandons. */
export const decodeMcpCancelledRequestId = (
  params: unknown,
): Option.Option<JsonRpcId> =>
  Option.map(decodeMcpCancelledParams(params), (decoded) => decoded.requestId);

// ---- stdin ------------------------------------------------------------------

/** One content block of a user message, in the Anthropic API's encoding. */
export type CliUserContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

/** A JSON-RPC response for the CLI's MCP client. */
export type McpResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: { readonly code: number; readonly message: string };
    };

const line = (value: unknown): string => JSON.stringify(value) + "\n";

/** A user turn. */
export const userMessageLine = (
  content: ReadonlyArray<CliUserContentBlock>,
): string => line({ type: "user", message: { role: "user", content } });

/**
 * A control request of ours. `interrupt` ends the running turn the way Esc
 * does; the turn then ends with an `error_during_execution` result.
 */
export const controlRequestLine = (
  requestId: string,
  request: ThinkingControl | { readonly subtype: "interrupt" },
): string => line({ type: "control_request", request_id: requestId, request });

/**
 * The answer to a tool permission request. Claude Code 2.x nests
 * `request_id` inside `response`, and an allow must echo the tool input.
 */
export const toolPermissionResponseLine = (
  requestId: string,
  decision:
    | {
        readonly behavior: "allow";
        readonly updatedInput: Readonly<Record<string, unknown>>;
      }
    | { readonly behavior: "deny"; readonly message: string },
): string =>
  line({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: decision },
  });

/** The answer to an in-band MCP request. */
export const mcpResponseLine = (
  requestId: string,
  response: McpResponse,
): string =>
  line({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { mcp_response: response },
    },
  });

/**
 * The acknowledgement of an in-band MCP notification. The CLI's control
 * channel wants a response for every request, so a notification gets an
 * empty result.
 */
export const mcpNotificationAckLine = (requestId: string): string =>
  mcpResponseLine(requestId, { jsonrpc: "2.0", id: 0, result: {} });
