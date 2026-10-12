/**
 * Naming of pi's tools on the Claude CLI side.
 *
 * Every tool the model can call is one of pi's, advertised to the CLI through
 * the schema-only MCP server named `custom-tools`. The CLI prefixes MCP tool
 * names with the server name, so pi's `bash` reaches the model as
 * `mcp__custom-tools__bash`. Argument schemas pass through unchanged.
 */

/** MCP prefix the CLI puts on every pi tool name. */
export const CUSTOM_TOOLS_MCP_PREFIX = "mcp__custom-tools__";

/**
 * True for a tool the CLI must hand to pi for execution, i.e. one of pi's
 * tools as the model names it (`mcp__custom-tools__<piToolName>`).
 */
export function isHandoffClaudeTool(claudeToolName: string): boolean {
  return claudeToolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
}

/**
 * The pi tool name for a model-side tool name: strips the MCP prefix
 * (`mcp__custom-tools__deploy` -> `deploy`). Other names pass through.
 */
export function mapClaudeToolNameToPi(claudeToolName: string): string {
  return claudeToolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX)
    ? claudeToolName.slice(CUSTOM_TOOLS_MCP_PREFIX.length)
    : claudeToolName;
}
