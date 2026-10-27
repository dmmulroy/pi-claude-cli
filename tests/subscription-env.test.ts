import { describe, expect, it } from "vite-plus/test";
import { defaultCliAuthStatusFile } from "../src/cli-auth";
import {
  claudeCommand,
  claudeConfigEnvironment,
  claudeInstallationKey,
} from "../src/subscription-env";

describe("the Claude Code installation", () => {
  it("is claude on PATH with its own config by default", () => {
    expect(claudeCommand({})).toBe("claude");
    expect(claudeConfigEnvironment({})).toEqual({});
    expect(claudeInstallationKey({})).toBeUndefined();
    expect(claudeCommand({ PI_CLAUDE_CLI_COMMAND: "  " })).toBe("claude");
  });

  it("follows PI_CLAUDE_CLI_COMMAND and PI_CLAUDE_CLI_CONFIG_DIR", () => {
    const env = { PI_CLAUDE_CLI_COMMAND: "/opt/claude", PI_CLAUDE_CLI_CONFIG_DIR: "/cfg" };
    expect(claudeCommand(env)).toBe("/opt/claude");
    expect(claudeConfigEnvironment(env)).toEqual({ CLAUDE_CONFIG_DIR: "/cfg" });
    expect(claudeInstallationKey(env)).toBeDefined();
  });

  it("keeps another installation's login status in its own file", () => {
    const state = { XDG_STATE_HOME: "/state" };
    expect(defaultCliAuthStatusFile(state)).toBe("/state/pi-claude-cli/auth-status.json");
    const other = defaultCliAuthStatusFile({ ...state, PI_CLAUDE_CLI_CONFIG_DIR: "/cfg" });
    expect(other).toMatch(/^\/state\/pi-claude-cli\/auth-status-[0-9a-f]{12}\.json$/);
    expect(defaultCliAuthStatusFile({ ...state, PI_CLAUDE_CLI_COMMAND: "/opt/claude" })).not.toBe(
      other,
    );
  });
});
