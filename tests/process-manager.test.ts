import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock cross-spawn before importing process-manager
vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    proc.pid = 12345;
    return proc;
  }),
}));

// Mock child_process.execSync for validation tests
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  spawnClaude,
  sendInterrupt,
  writeUserMessage,
  captureStderr,
  validateCliPresence,
  validateCliAuth,
  forceKillProcess,
  registerProcess,
  killAllProcesses,
  cleanupSystemPromptFile,
  STDERR_CAPTURE_LIMIT_CHARS,
  SUBSCRIPTION_OVERRIDE_ENV_VARS,
} from "../src/process-manager";
import { CliRequirementError } from "../src/cli-requirements";

/** A supported `claude --version` answer for the spawn-time check. */
const SUPPORTED_CLI_VERSION = "2.1.292 (Claude Code)";

// spawnClaude checks the CLI version before every spawn. Restored before each
// test because the validation suites leave their own execSync behaviour set.
beforeEach(() => {
  (execSync as any).mockReset();
  (execSync as any).mockReturnValue(Buffer.from(SUPPORTED_CLI_VERSION));
});

describe("thinking flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const argsOf = () => (spawn as any).mock.calls[0][1] as string[];
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("starts an enabled level with its budget, effort and display", () => {
    spawnClaude("claude-sonnet-5", "pi prompt", {
      cliSessionId: "cli-1",
      thinking: {
        kind: "enabled",
        budgetTokens: 8192,
        effort: "medium",
        display: "summarized",
      },
    });
    const args = argsOf();
    expect(after(args, "--max-thinking-tokens")).toBe("8192");
    expect(after(args, "--effort")).toBe("medium");
    expect(after(args, "--thinking-display")).toBe("summarized");
    expect(args).not.toContain("--thinking");
  });

  it("starts pi's off with thinking disabled and no budget or effort", () => {
    spawnClaude("claude-haiku-4-5", "pi prompt", {
      cliSessionId: "cli-1",
      thinking: { kind: "disabled" },
    });
    const args = argsOf();
    expect(after(args, "--thinking")).toBe("disabled");
    expect(args).not.toContain("--max-thinking-tokens");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--thinking-display");
  });

  it("passes no thinking flags for the CLI default or when none is given", () => {
    spawnClaude("claude-opus-5", "pi prompt", {
      cliSessionId: "cli-1",
      thinking: { kind: "default" },
    });
    spawnClaude("claude-opus-5", "pi prompt", {
      cliSessionId: "cli-2",
      cwd: "/path",
    });
    for (const call of (spawn as any).mock.calls) {
      const args = call[1] as string[];
      for (const flag of [
        "--thinking",
        "--max-thinking-tokens",
        "--effort",
        "--thinking-display",
      ])
        expect(args).not.toContain(flag);
    }
  });
});

describe("writeUserMessage", () => {
  it("writes correct NDJSON user message to stdin", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "Hello Claude");

    expect(mockStdin.write).toHaveBeenCalledTimes(1);
    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello Claude");
  });

  it("appends newline to the JSON", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    const written = mockStdin.write.mock.calls[0][0] as string;
    expect(written.endsWith("\n")).toBe(true);
  });

  it("does NOT call stdin.end()", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    expect(mockStdin.end).not.toHaveBeenCalled();
  });

  it("sends string content in NDJSON when given string", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "hello");

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(typeof parsed.message.content).toBe("string");
    expect(parsed.message.content).toBe("hello");
  });

  it("sends array content in NDJSON when given ContentBlock[]", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ];
    writeUserMessage(proc, blocks as any);

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toEqual(blocks);
  });
});

describe("captureStderr", () => {
  it("returns a function that accumulates stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);

    stderr.emit("data", Buffer.from("error line 1\n"));
    stderr.emit("data", Buffer.from("error line 2\n"));

    expect(getStderr()).toBe("error line 1\nerror line 2\n");
  });

  it("returns empty string when no stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);
    expect(getStderr()).toBe("");
  });

  it("keeps only the most recent output of a long-lived process", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);
    stderr.emit("data", Buffer.from("x".repeat(STDERR_CAPTURE_LIMIT_CHARS)));
    stderr.emit("data", Buffer.from("the failure that matters"));

    expect(getStderr()).toHaveLength(STDERR_CAPTURE_LIMIT_CHARS);
    expect(getStderr().endsWith("the failure that matters")).toBe(true);
  });
});

describe("spawnClaude environment", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.clearAllMocks();
    (execSync as any).mockReturnValue(Buffer.from("2.1.292 (Claude Code)"));
    for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) {
      saved[name] = process.env[name];
    }
  });
  afterEach(() => {
    for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("never forwards variables that move the CLI off the subscription login", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "token";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example";

    spawnClaude("claude-sonnet-4-5-20250929", "pi prompt", {
      cliSessionId: "cli-1",
    });

    const { env } = (spawn as any).mock.calls[0][2];
    for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) {
      expect(env).not.toHaveProperty(name);
    }
    // The host process keeps its own environment untouched.
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });
});

describe("validateCliPresence", () => {
  it("does not throw when claude --version succeeds", () => {
    (execSync as any).mockReturnValue(Buffer.from("1.0.0"));
    expect(() => validateCliPresence()).not.toThrow();
  });

  it("throws with install instructions when claude --version fails", () => {
    (execSync as any).mockImplementation(() => {
      throw new Error("command not found");
    });

    expect(() => validateCliPresence()).toThrow();
    try {
      validateCliPresence();
    } catch (e: any) {
      expect(e.message).toContain("Claude Code CLI not found");
      expect(e.message).toContain("npm install");
    }
  });
});

describe("validateCliAuth", () => {
  it("returns true when claude auth status succeeds with non-JSON output", () => {
    (execSync as any).mockReturnValue("Logged in");
    expect(validateCliAuth()).toBe(true);
  });

  it("returns true when JSON output reports loggedIn:true even if exit is non-zero", () => {
    // Simulate a transient warning that flips the exit code but still
    // produces valid JSON on stdout.
    (execSync as any).mockImplementation(() => {
      const err: any = new Error("warning on stderr");
      err.status = 1;
      err.stdout = '{"loggedIn":true,"authMethod":"claude.ai"}';
      throw err;
    });
    expect(validateCliAuth()).toBe(true);
  });

  it("returns false and warns when JSON output reports loggedIn:false", () => {
    (execSync as any).mockReturnValue('{"loggedIn":false}');
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validateCliAuth()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });

  it("returns false and warns when claude auth status fails with no JSON", () => {
    (execSync as any).mockImplementation(() => {
      throw new Error("not authenticated");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(validateCliAuth()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });
});

describe("forceKillProcess", () => {
  it("calls proc.kill('SIGKILL') on live process", () => {
    const proc = {
      killed: false,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("no-ops when proc.killed is true", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("no-ops when proc.exitCode is not null", () => {
    const proc = {
      killed: false,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("process registry", () => {
  beforeEach(() => {
    // Clear registry between tests
    killAllProcesses();
    vi.clearAllMocks();
  });

  it("registerProcess adds proc and killAllProcesses kills it", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);
    killAllProcesses();

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("proc exit event removes from registry", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);

    // Simulate natural exit
    proc.exitCode = 0;
    proc.emit("exit", 0, null);

    // Clear mock to check killAllProcesses doesn't call kill again
    proc.kill.mockClear();
    proc.killed = false;
    proc.exitCode = null;

    killAllProcesses();

    // Should NOT have been killed since it was removed on exit
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("killAllProcesses clears set and handles already-dead processes", () => {
    const EventEmitter = require("node:events");
    const proc1 = new EventEmitter();
    proc1.killed = true; // already dead
    proc1.exitCode = null;
    proc1.kill = vi.fn();

    const proc2 = new EventEmitter();
    proc2.killed = false;
    proc2.exitCode = 1; // already exited
    proc2.kill = vi.fn();

    const proc3 = new EventEmitter();
    proc3.killed = false;
    proc3.exitCode = null; // alive
    proc3.kill = vi.fn(() => {
      proc3.killed = true;
    });

    registerProcess(proc1 as unknown as ChildProcess);
    registerProcess(proc2 as unknown as ChildProcess);
    registerProcess(proc3 as unknown as ChildProcess);

    killAllProcesses();

    // Already dead -- forceKillProcess should no-op
    expect(proc1.kill).not.toHaveBeenCalled();
    expect(proc2.kill).not.toHaveBeenCalled();
    // Live process should be killed
    expect(proc3.kill).toHaveBeenCalledWith("SIGKILL");

    // Calling again should not kill anything (set was cleared)
    proc3.kill.mockClear();
    proc3.killed = false;
    proc3.exitCode = null;
    killAllProcesses();
    expect(proc3.kill).not.toHaveBeenCalled();
  });
});

describe("PI_CLAUDE_CLI_SETTINGS passthrough", () => {
  const original = process.env.PI_CLAUDE_CLI_SETTINGS;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PI_CLAUDE_CLI_SETTINGS;
    else process.env.PI_CLAUDE_CLI_SETTINGS = original;
    vi.clearAllMocks();
  });

  it("passes --settings when the env var is set (hook injection point)", () => {
    process.env.PI_CLAUDE_CLI_SETTINGS = "/etc/host/claude-settings.json";
    spawnClaude("claude-haiku-4-5", "pi prompt", { cliSessionId: "cli-1" });
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe(
      "/etc/host/claude-settings.json",
    );
  });

  it("omits --settings when unset", () => {
    delete process.env.PI_CLAUDE_CLI_SETTINGS;
    spawnClaude("claude-haiku-4-5", "pi prompt", { cliSessionId: "cli-1" });
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--settings");
  });
});

describe("sendInterrupt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an interrupt control_request to stdin", () => {
    const proc = spawnClaude("claude-haiku-4-5", "pi prompt", {
      cliSessionId: "cli-1",
    });
    sendInterrupt(proc);
    const written = (proc.stdin!.write as any).mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    const line = written.trim().split("\n").pop()!;
    const msg = JSON.parse(line);
    expect(msg.type).toBe("control_request");
    expect(msg.request.subtype).toBe("interrupt");
    expect(msg.request_id).toBeTruthy();
  });

  it("no-ops on a dead process", () => {
    const proc = spawnClaude("claude-haiku-4-5", "pi prompt", {
      cliSessionId: "cli-1",
    });
    (proc as any).killed = true;
    sendInterrupt(proc);
    expect((proc.stdin!.write as any).mock.calls).toHaveLength(0);
  });

  it("mints distinct request ids", () => {
    const proc = spawnClaude("claude-haiku-4-5", "pi prompt", {
      cliSessionId: "cli-1",
    });
    sendInterrupt(proc);
    sendInterrupt(proc);
    const ids = (proc.stdin!.write as any).mock.calls.map(
      (c: any) => JSON.parse(String(c[0])).request_id,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("spawnClaude", () => {
  beforeEach(() => {
    (spawn as any).mockClear();
  });

  const spawnDefault = () =>
    spawnClaude("claude-sonnet-4-5-20250929", "pi system prompt", {
      cliSessionId: "cli-session-1",
    });
  const argsOf = () => (spawn as any).mock.calls[0][1] as string[];
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("spawns claude in stream-json print mode with piped stdio", () => {
    const proc = spawnDefault();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = (spawn as any).mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(after(args, "--input-format")).toBe("stream-json");
    expect(after(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(after(args, "--model")).toBe("claude-sonnet-4-5-20250929");
    expect(after(args, "--permission-prompt-tool")).toBe("stdio");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(proc).toBe((spawn as any).mock.results[0].value);
  });

  it("gives the CLI no native tools and none of the user's Claude Code environment", () => {
    spawnDefault();

    const args = argsOf();
    expect(after(args, "--tools")).toBe("");
    expect(after(args, "--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-chrome");
    const { env } = (spawn as any).mock.calls[0][2];
    expect(env).toMatchObject({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
  });

  it("never resumes and never persists a Claude transcript", () => {
    spawnDefault();

    const args = argsOf();
    expect(after(args, "--session-id")).toBe("cli-session-1");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    // --bare would disable subscription OAuth.
    expect(args).not.toContain("--bare");
  });

  it("replaces Claude Code's system prompt with pi's, staged as an owner-only file", () => {
    spawnDefault();

    const args = argsOf();
    const promptFile = after(args, "--system-prompt-file");
    expect(readFileSync(promptFile, "utf-8")).toBe("pi system prompt");
    expect(statSync(promptFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(promptFile)).mode & 0o777).toBe(0o700);
    // The unsuffixed flags take a literal string: a path there becomes the prompt.
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("stages one prompt file per CLI session so concurrent spawns cannot clobber each other", () => {
    spawnClaude("claude-haiku-4-5", "first", { cliSessionId: "cli-a" });
    spawnClaude("claude-haiku-4-5", "second", { cliSessionId: "cli-b" });

    const [a, b] = (spawn as any).mock.calls.map((call: any[]) =>
      after(call[1], "--system-prompt-file"),
    );
    expect(a).not.toBe(b);
    expect(readFileSync(a, "utf-8")).toBe("first");
    expect(readFileSync(b, "utf-8")).toBe("second");
  });

  it("passes cwd and --mcp-config from options", () => {
    spawnClaude("claude-haiku-4-5", "pi prompt", {
      cliSessionId: "cli-1",
      cwd: "/custom/path",
      mcpConfigPath: "/tmp/mcp-config.json",
    });

    expect(after(argsOf(), "--mcp-config")).toBe("/tmp/mcp-config.json");
    expect((spawn as any).mock.calls[0][2].cwd).toBe("/custom/path");
  });

  it("omits --mcp-config when no config is given", () => {
    spawnDefault();
    expect(argsOf()).not.toContain("--mcp-config");
  });

  it("gives proxied tool calls an hour unless the host set its own limit", () => {
    const original = process.env.MCP_TOOL_TIMEOUT;
    try {
      delete process.env.MCP_TOOL_TIMEOUT;
      spawnDefault();
      process.env.MCP_TOOL_TIMEOUT = "5000";
      spawnDefault();
    } finally {
      if (original === undefined) delete process.env.MCP_TOOL_TIMEOUT;
      else process.env.MCP_TOOL_TIMEOUT = original;
    }
    const [unset, hostSet] = (spawn as any).mock.calls.map(
      (call: any[]) => call[2].env.MCP_TOOL_TIMEOUT,
    );
    expect(unset).toBe("3600000");
    expect(hostSet).toBe("5000");
  });

  it("refuses a CLI older than the tested isolation controls", () => {
    (execSync as any).mockReturnValue(Buffer.from("2.1.262 (Claude Code)"));
    expect(spawnDefault).toThrow(CliRequirementError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to run under CLAUDE_CODE_SIMPLE or CLAUDE_CODE_SAFE_MODE", () => {
    for (const name of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"]) {
      const original = process.env[name];
      process.env[name] = "1";
      try {
        expect(spawnDefault).toThrow(CliRequirementError);
      } finally {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      }
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("cleanupSystemPromptFile", () => {
  beforeEach(() => {
    (spawn as any).mockClear();
  });

  it("deletes the prompt file staged for that CLI session", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "test prompt", {
      cliSessionId: "cli-cleanup",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];
    const promptFile = args[args.indexOf("--system-prompt-file") + 1];
    expect(existsSync(promptFile)).toBe(true);

    cleanupSystemPromptFile("cli-cleanup");
    expect(existsSync(promptFile)).toBe(false);
  });

  it("does not throw when the file does not exist", () => {
    expect(() => cleanupSystemPromptFile("never-spawned")).not.toThrow();
  });
});
