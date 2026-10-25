import { describe, expect, it } from "vite-plus/test";
import {
  CUSTOM_TOOLS_MCP_PREFIX,
  isHandoffClaudeTool,
  mapClaudeToolNameToPi,
} from "../src/tool-mapping";

describe("pi tool names on the CLI side", () => {
  it("recognizes only tools under the in-band server's prefix", () => {
    expect(isHandoffClaudeTool(`${CUSTOM_TOOLS_MCP_PREFIX}bash`)).toBe(true);
    expect(isHandoffClaudeTool("Bash")).toBe(false);
    expect(isHandoffClaudeTool("mcp__other__bash")).toBe(false);
  });

  it("strips the prefix and passes other names through", () => {
    expect(mapClaudeToolNameToPi("mcp__custom-tools__weather")).toBe("weather");
    expect(mapClaudeToolNameToPi("Read")).toBe("Read");
  });
});
