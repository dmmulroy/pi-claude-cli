/**
 * Control protocol handler for Claude CLI stream-json communication.
 *
 * Processes control_request (permission) messages from Claude CLI stdout and
 * writes control_response messages to stdin.
 *
 * - pi's tools (mcp__custom-tools__*): ALLOWED when the handoff proxy is on —
 *   the schema server forwards the call to pi and the CLI keeps running;
 *   DENIED otherwise, so the turn can be interrupted and pi runs the tool.
 * - Everything else: DENIED. Nothing but pi's tools may execute.
 */

import type { ClaudeControlRequest } from "./types";
import { CUSTOM_TOOLS_MCP_PREFIX } from "./tool-mapping.js";

export const TOOL_EXECUTION_DENIED_MESSAGE =
  "Tool execution is unavailable in this environment.";

/** Prefix for MCP (Model Context Protocol) tool names. */
export const MCP_PREFIX = "mcp__";

/**
 * Claude Code 2.x control_response wire shape: `request_id` lives INSIDE
 * `response`, and allow decisions carry `updatedInput` (the tool input,
 * passed through unmodified). The 1.x shape (`request_id` at the top level)
 * is silently ignored by 2.1.x — the CLI keeps waiting for an answer and
 * the episode stalls until the inactivity timer kills it, which surfaced
 * as truncated multi-cycle turns (#3). Verified against claude 2.1.237.
 */
interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response:
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
      | { behavior: "deny"; message: string };
  };
}

/**
 * Handle a control_request from the Claude CLI.
 *
 * @param options.allowHandoff - true when the handoff proxy will route pi's
 *   tools to pi; false (default) denies them so the interrupt path runs them.
 * @returns true if the tool was allowed, false if denied
 */
export function handleControlRequest(
  msg: ClaudeControlRequest,
  stdin: NodeJS.WritableStream,
  options?: { allowHandoff?: boolean },
): boolean {
  if (!msg.request_id || !msg.request) {
    console.error(
      "[pi-claude-cli] Malformed control_request: missing request_id or request object",
      msg,
    );
    return false;
  }

  const toolName = msg.request?.tool_name ?? "";
  const isCustomTool = toolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
  const deny = isCustomTool ? !options?.allowHandoff : true;

  const response: ControlResponse = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: deny
        ? { behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE }
        : { behavior: "allow", updatedInput: msg.request?.input ?? {} },
    },
  };

  stdin.write(JSON.stringify(response) + "\n");
  return !deny;
}
