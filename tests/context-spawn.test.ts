import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cross-spawn", () => ({ default: vi.fn(() => ({})) }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));
import spawn from "cross-spawn";
import { spawnClaude, cleanupSystemPromptFile } from "../src/process-manager";

afterEach(() => {
  cleanupSystemPromptFile("cli-1");
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("spawnClaude and the host's own Claude environment", () => {
  it("keeps explicit host guards and account selection, and overrides the host's isolation settings only for the child", () => {
    vi.stubEnv("PI_CLAUDE_CLI_SETTINGS", "/host/guards.json");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/account/selected");
    vi.stubEnv("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "0");

    spawnClaude("claude-haiku-4-5", "PI-CONTEXT", { cliSessionId: "cli-1" });

    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    const argv = args as string[];
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/host/guards.json");
    for (const forbidden of [
      "--bare",
      "--safe-mode",
      "--autocompact",
      "--dangerously-skip-permissions",
    ])
      expect(argv).not.toContain(forbidden);
    expect(options?.env).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/account/selected",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
    // The host process keeps its own value.
    expect(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("0");
  });
});
