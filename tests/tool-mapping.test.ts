import { describe, expect, it } from "vite-plus/test";
import {
  claudeToolName,
  createToolNameMap,
  CUSTOM_TOOLS_MCP_PREFIX,
  isHandoffClaudeTool,
  isWireSafeToolName,
  mcpToolName,
  mcpToolNameOfClaudeTool,
} from "../src/tool-mapping";

describe("pi tool names on the CLI side", () => {
  it("recognizes only tools under the in-band server's prefix", () => {
    expect(isHandoffClaudeTool(`${CUSTOM_TOOLS_MCP_PREFIX}bash`)).toBe(true);
    expect(isHandoffClaudeTool("Bash")).toBe(false);
    expect(isHandoffClaudeTool("mcp__other__bash")).toBe(false);
  });

  it("strips the prefix and passes other names through", () => {
    expect(mcpToolNameOfClaudeTool("mcp__custom-tools__weather")).toBe("weather");
    expect(mcpToolNameOfClaudeTool("Read")).toBe("Read");
  });

  it("keeps names the CLI and the API take as they are", () => {
    for (const name of ["bash", "read_file", "web-fetch", "A1", "x".repeat(45)]) {
      expect(isWireSafeToolName(name)).toBe(true);
      expect(mcpToolName(name)).toBe(name);
    }
  });

  it("aliases names the CLI would rewrite or the API would refuse", () => {
    for (const name of ["deploy.prod", "a b", "ünïcode", "x".repeat(46), ""]) {
      const alias = mcpToolName(name);
      expect(alias).not.toBe(name);
      expect(isWireSafeToolName(alias)).toBe(true);
      expect(claudeToolName(name).length).toBeLessThanOrEqual(64);
    }
    expect(mcpToolName("deploy.prod")).toMatch(/^deploy_prod_[0-9a-f]{8}$/);
  });

  it("derives aliases from the name alone", () => {
    expect(mcpToolName("deploy.prod")).toBe(mcpToolName("deploy.prod"));
    expect(mcpToolName("deploy.prod")).not.toBe(mcpToolName("deploy:prod"));
  });

  it("maps the model's names back to pi's", () => {
    const toPi = createToolNameMap(["bash", "deploy.prod", "x".repeat(60)]);
    expect(toPi(claudeToolName("bash"))).toBe("bash");
    expect(toPi(claudeToolName("deploy.prod"))).toBe("deploy.prod");
    expect(toPi(claudeToolName("x".repeat(60)))).toBe("x".repeat(60));
    expect(toPi(`${CUSTOM_TOOLS_MCP_PREFIX}invented`)).toBe("invented");
  });

  it("lets a safe pi name keep its name over another tool's alias", () => {
    const alias = mcpToolName("deploy.prod");
    const toPi = createToolNameMap(["deploy.prod", alias]);
    expect(toPi(claudeToolName(alias))).toBe(alias);
  });
});
