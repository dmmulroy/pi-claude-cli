/**
 * Naming of pi's tools on the Claude CLI side.
 *
 * Every tool the model can call is one of pi's, advertised to the CLI through
 * the in-band MCP server named `custom-tools`. The CLI prefixes MCP tool
 * names with the server name, so pi's `bash` reaches the model as
 * `mcp__custom-tools__bash`. Argument schemas pass through unchanged.
 *
 * The Anthropic API accepts tool names of `^[a-zA-Z0-9_-]{1,64}$`, prefix
 * included, and the CLI silently turns every other character of an MCP tool
 * name into `_` (Claude Code 2.1.299). A pi name that would not survive that
 * as it is (`deploy.prod`, or longer than the prefix leaves room for) is sent
 * under a stable alias derived from it, and the model's calls are mapped back
 * to pi's name. pi's own names never change.
 *
 * Pure apart from hashing: imported eagerly through `event-bridge`.
 */

import { createHash } from "node:crypto";

/** MCP prefix the CLI puts on every pi tool name. */
export const CUSTOM_TOOLS_MCP_PREFIX = "mcp__custom-tools__";

/** Longest tool name the Anthropic API accepts, prefix included. */
const CLAUDE_TOOL_NAME_LIMIT = 64;
/** Longest MCP-side name that still fits under the prefix. */
const MCP_TOOL_NAME_LIMIT = CLAUDE_TOOL_NAME_LIMIT - CUSTOM_TOOLS_MCP_PREFIX.length;
const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
/** Hex digits of the pi name's SHA-256 kept in an alias. */
const ALIAS_HASH_LENGTH = 8;

/** True when the CLI and the API take pi's tool name as it is. */
export const isWireSafeToolName = (piName: string): boolean =>
  piName.length > 0 && piName.length <= MCP_TOOL_NAME_LIMIT && MCP_TOOL_NAME.test(piName);

/**
 * The name pi's tool has on the in-band MCP server: pi's own when it is safe,
 * otherwise `<sanitized stem>_<hash>`. Depends only on the pi name, so tools
 * and history map the same way in every request and process.
 */
export const mcpToolName = (piName: string): string => {
  if (isWireSafeToolName(piName)) return piName;
  const hash = createHash("sha256").update(piName).digest("hex").slice(0, ALIAS_HASH_LENGTH);
  const stem = piName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, MCP_TOOL_NAME_LIMIT - ALIAS_HASH_LENGTH - 1);
  return `${stem || "tool"}_${hash}`;
};

/** The name the model sees for pi's tool. */
export const claudeToolName = (piName: string): string =>
  `${CUSTOM_TOOLS_MCP_PREFIX}${mcpToolName(piName)}`;

/**
 * True for a tool the CLI must hand to pi for execution, i.e. one of pi's
 * tools as the model names it (`mcp__custom-tools__<name>`).
 */
export function isHandoffClaudeTool(claudeToolName: string): boolean {
  return claudeToolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
}

/** The MCP-side name of a model-side name; other names pass through. */
export const mcpToolNameOfClaudeTool = (claudeToolName: string): string =>
  claudeToolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX)
    ? claudeToolName.slice(CUSTOM_TOOLS_MCP_PREFIX.length)
    : claudeToolName;

/** Maps the names the model uses back to pi's, for one request's tools. */
export type ToolNameMap = (claudeToolName: string) => string;

/**
 * The reverse of `claudeToolName` over pi's tools: an alias of one of them
 * becomes its pi name; any other name only loses the MCP prefix.
 */
export function createToolNameMap(piNames: Iterable<string>): ToolNameMap {
  const toPi = new Map<string, string>();
  for (const name of piNames) {
    const alias = mcpToolName(name);
    // A pi name that is itself safe keeps priority over another's alias.
    if (!toPi.has(alias) || alias === name) toPi.set(alias, name);
  }
  return (claudeName) => {
    const mcpName = mcpToolNameOfClaudeTool(claudeName);
    return toPi.get(mcpName) ?? mcpName;
  };
}
