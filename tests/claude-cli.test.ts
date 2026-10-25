import { describe, expect, it } from "vite-plus/test";
import { launchEnvironment } from "../src/claude-cli";
import {
  SUBSCRIPTION_OVERRIDE_ENV_VARS,
  withoutSubscriptionOverrides,
} from "../src/subscription-env";

describe("the CLI's child-only environment", () => {
  const env = launchEnvironment("3600000");

  it("leaves retries to pi", () => {
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("0");
    // Present and undefined: the spawner removes an inherited value.
    expect("CLAUDE_CODE_RETRY_WATCHDOG" in env).toBe(true);
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
  });

  it("leaves compaction to pi", () => {
    expect(env.DISABLE_AUTO_COMPACT).toBe("1");
    expect(env.DISABLE_COMPACT).toBe("1");
  });

  it("turns off the CLI's non-essential traffic", () => {
    // Read as set-or-unset by the CLI: any non-empty value disables.
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("removes every variable that would move the CLI off the subscription", () => {
    expect(SUBSCRIPTION_OVERRIDE_ENV_VARS).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
      "ANTHROPIC_AWS_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    ]);
    for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) {
      expect(name in env).toBe(true);
      expect(env[name]).toBeUndefined();
    }
  });

  it("removes the same variables from an environment it is given", () => {
    const kept = withoutSubscriptionOverrides({
      ANTHROPIC_API_KEY: "sk",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/bin",
    });
    expect(kept).toEqual({ PATH: "/bin" });
  });

  it("keeps the CLI's own additions out of pi's requests", () => {
    expect(env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER).toBe("off");
    expect("CLAUDE_CODE_EXTRA_BODY" in env).toBe(true);
    expect(env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
  });

  it("passes the MCP tool timeout through and keeps the isolation switches", () => {
    expect(env.MCP_TOOL_TIMEOUT).toBe("3600000");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
  });
});
