/**
 * The in-band MCP server that advertises pi's tools to the Claude CLI.
 *
 * The CLI is launched with an `"type": "sdk"` MCP server named
 * `custom-tools`. It has no process and no socket: the CLI's MCP client
 * sends each JSON-RPC message as a `control_request` on stdout and reads the
 * answer from stdin. This module is the server's protocol, as pure functions;
 * `src/claude-process.ts` owns the conversation and holds a `tools/call`
 * open until pi has run the tool.
 */

import type { ImageContent, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Option } from "effect";
import {
  decodeMcpCancelledRequestId,
  decodeMcpToolCall,
  type JsonRpcId,
  type McpMessage,
  type McpResponse,
  type McpToolCall,
} from "./cli-protocol.ts";
import { mcpToolName } from "./tool-mapping.ts";

/** Name of the in-band server; the CLI prefixes tool names with it. */
export const INBAND_MCP_SERVER_NAME = "custom-tools";

/** The `--mcp-config` value that declares the in-band server. */
export const INBAND_MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    [INBAND_MCP_SERVER_NAME]: { type: "sdk", name: INBAND_MCP_SERVER_NAME },
  },
});

/** Tells the CLI's MCP client to ask for `tools/list` again. */
export const MCP_TOOLS_CHANGED_METHOD = "notifications/tools/list_changed";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** One of pi's tools as MCP `tools/list` returns it. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Tool["parameters"];
}

/**
 * pi's tools for the request, with argument schemas unchanged, under names
 * the CLI and the API take as they are. A second tool of the same name is
 * left out: the model could not tell them apart.
 */
export const mcpToolDefinitions = (tools: ReadonlyArray<Tool>): ReadonlyArray<McpToolDefinition> =>
  tools
    .filter((tool, index) => tools.findIndex((other) => other.name === tool.name) === index)
    .map((tool) => ({
      name: mcpToolName(tool.name),
      description: tool.description,
      inputSchema: tool.parameters,
    }));

/** The MCP tool result the CLI hands to the model. */
export interface McpToolResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }
  >;
  readonly isError: boolean;
}

/** An error result carrying one line of text for the model. */
export const mcpToolErrorResult = (message: string): McpToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const mcpContentBlock = (block: TextContent | ImageContent): McpToolResult["content"][number] =>
  block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mimeType: block.mimeType };

/** pi's complete tool result, errors and images included, as an MCP result. */
export const mcpToolResultFromPi = (message: ToolResultMessage): McpToolResult => {
  const content = message.content.map(mcpContentBlock);
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    isError: message.isError,
  };
};

/** What the server does with one message from the CLI's MCP client. */
export type McpServerAction =
  | { readonly _tag: "Respond"; readonly response: McpResponse }
  /** A `tools/list`: answered with the tools the process is serving now. */
  | { readonly _tag: "ListTools"; readonly response: McpResponse }
  /** A notification: acknowledged on the control channel, nothing else. */
  | { readonly _tag: "Acknowledge" }
  /** A `tools/call`: answered once pi has run the tool. */
  | {
      readonly _tag: "CallTool";
      readonly id: JsonRpcId;
      readonly call: Option.Option<McpToolCall>;
    }
  /** The CLI gave up on a `tools/call` (interrupt or its own timeout). */
  | { readonly _tag: "CancelCall"; readonly id: JsonRpcId };

/** Decide the server's reaction to one MCP message. */
export const mcpServerAction = (
  message: McpMessage,
  tools: ReadonlyArray<McpToolDefinition>,
): McpServerAction => {
  if (message.method === "notifications/cancelled") {
    return Option.match(decodeMcpCancelledRequestId(message.params), {
      onNone: (): McpServerAction => ({ _tag: "Acknowledge" }),
      onSome: (id): McpServerAction => ({ _tag: "CancelCall", id }),
    });
  }
  if (message.id === undefined) return { _tag: "Acknowledge" };
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return {
        _tag: "Respond",
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: INBAND_MCP_SERVER_NAME, version: "1.0.0" },
          },
        },
      };
    case "tools/list":
      return {
        _tag: "ListTools",
        response: { jsonrpc: "2.0", id, result: { tools } },
      };
    case "tools/call":
      return { _tag: "CallTool", id, call: decodeMcpToolCall(message.params) };
    default:
      // ping, prompts/list, resources/list: answer so the client never waits.
      return {
        _tag: "Respond",
        response: {
          jsonrpc: "2.0",
          id,
          error: {
            code: JSON_RPC_METHOD_NOT_FOUND,
            message: `Method not supported: ${message.method ?? "(none)"}`,
          },
        },
      };
  }
};

/** The JSON-RPC answer to a `tools/call`. */
export const mcpToolCallResponse = (id: JsonRpcId, result: McpToolResult): McpResponse => ({
  jsonrpc: "2.0",
  id,
  result: result.isError ? { content: result.content, isError: true } : { content: result.content },
});
