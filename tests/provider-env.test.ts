import { afterEach, describe, expect, it } from "vite-plus/test";
import { providerEnv, resolveProviderSettings } from "../src/provider-env";

describe("provider settings", () => {
  afterEach(() => resolveProviderSettings({ env: async () => undefined }));

  it("keeps what pi resolves and lays it over the process environment", async () => {
    const env = await resolveProviderSettings({
      env: async (name) => (name === "PI_CLAUDE_CLI_COMMAND" ? "/opt/claude" : undefined),
    });
    expect(env).toEqual({ PI_CLAUDE_CLI_COMMAND: "/opt/claude" });
    expect(providerEnv().PI_CLAUDE_CLI_COMMAND).toBe("/opt/claude");
    expect(providerEnv().PATH).toBe(process.env.PATH);
  });

  it("asks pi only for the provider's four settings", async () => {
    const asked: string[] = [];
    await resolveProviderSettings({ env: async (name) => (asked.push(name), undefined) });
    expect(asked).toEqual([
      "PI_CLAUDE_CLI_COMMAND",
      "PI_CLAUDE_CLI_CONFIG_DIR",
      "PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS",
      "PI_CLAUDE_CLI_TRACE",
    ]);
  });
});
