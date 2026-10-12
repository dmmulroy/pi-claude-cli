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
  cleanupProcess,
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

describe("spawnClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns claude with all required CLI flags", () => {
    spawnClaude("claude-sonnet-4-5-20250929");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawn as any).mock.calls[0];

    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5-20250929");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    // No TUI under -p, so an AskUserQuestion call can only ever come back
    // "The user did not answer the questions."
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
  });

  it("passes stream-json for both input-format and output-format", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    const inputFormatIdx = args.indexOf("--input-format");
    expect(args[inputFormatIdx + 1]).toBe("stream-json");

    const outputFormatIdx = args.indexOf("--output-format");
    expect(args[outputFormatIdx + 1]).toBe("stream-json");
  });

  it("sets stdio to pipe for stdin, stdout, and stderr", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const options = (spawn as any).mock.calls[0][2];
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("passes cwd from options when provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      cwd: "/custom/path",
    });
    const options = (spawn as any).mock.calls[0][2];
    expect(options.cwd).toBe("/custom/path");
  });

  it("writes system prompt to temp file and passes path via --append-system-prompt-file", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt-file");
    const idx = args.indexOf("--append-system-prompt-file");
    expect(args[idx + 1]).toContain("pi-claude-cli-sysprompt");
  });

  it("stages the system prompt owner-only in the private runtime directory", () => {
    if (process.platform === "win32") return;
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const file = args[args.indexOf("--append-system-prompt-file") + 1];

    // It used to be a pid-named file straight in a world-readable /tmp, and
    // it carries pi's instructions plus the host's project context.
    expect(file).toMatch(/pi-claude-[^/]+\/pi-claude-cli-sysprompt[^/]*\.txt$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("never passes a path to the STRING form of either flag", () => {
    // `--system-prompt` / `--append-system-prompt` take literal text. Handing
    // one a path makes the path itself the system prompt: pi's instructions
    // never reach the model, and the session silently runs on Claude Code's
    // defaults. There is no error and no warning, so only this assertion and
    // the live codename check stand between that bug and a release.
    for (const mode of ["pi", "claude"] as const) {
      (spawn as any).mockClear();
      spawnClaude(
        "claude-sonnet-4-5-20250929",
        "You are a helpful assistant.",
        {
          systemPromptMode: mode,
        },
      );
      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).not.toContain("--system-prompt");
      expect(args).not.toContain("--append-system-prompt");
      const flag =
        mode === "pi" ? "--system-prompt-file" : "--append-system-prompt-file";
      expect(args).toContain(flag);
      // The value must be a real, readable file, not prompt text.
      expect(readFileSync(args[args.indexOf(flag) + 1], "utf-8")).toBe(
        "You are a helpful assistant.",
      );
    }
  });

  it("temp file contains the system prompt text", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const tmpFile = args[args.indexOf("--append-system-prompt-file") + 1];
    expect(existsSync(tmpFile)).toBe(true);
    expect(readFileSync(tmpFile, "utf-8")).toBe("You are a helpful assistant.");
  });

  it("does not include --append-system-prompt when no system prompt", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("returns the spawned ChildProcess", () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    expect(proc).toBeDefined();
    expect(proc.pid).toBe(12345);
  });
});

describe("thinking flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const argsOf = () => (spawn as any).mock.calls[0][1] as string[];
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("starts an enabled level with its budget, effort and display", () => {
    spawnClaude("claude-sonnet-5", undefined, {
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
    spawnClaude("claude-haiku-4-5", undefined, {
      thinking: { kind: "disabled" },
    });
    const args = argsOf();
    expect(after(args, "--thinking")).toBe("disabled");
    expect(args).not.toContain("--max-thinking-tokens");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--thinking-display");
  });

  it("passes no thinking flags for the CLI default or when none is given", () => {
    spawnClaude("claude-opus-5", undefined, { thinking: { kind: "default" } });
    spawnClaude("claude-opus-5", "system prompt", { cwd: "/path" });
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

describe("cleanupProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the process with SIGKILL after 500ms grace period", () => {
    const mockProc: any = {
      killed: false,
      exitCode: null,
      kill: vi.fn(() => {
        mockProc.killed = true;
      }),
    };

    cleanupProcess(mockProc as ChildProcess);

    // Not killed immediately
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Not killed at 400ms
    vi.advanceTimersByTime(400);
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Killed after 500ms grace period
    vi.advanceTimersByTime(100);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill if process is already killed", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    cleanupProcess(proc);
    vi.advanceTimersByTime(500);

    expect(proc.kill).not.toHaveBeenCalled();
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

    spawnClaude("claude-sonnet-4-5-20250929");

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

describe("CLI flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude does NOT include --permission-mode or dontAsk in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("dontAsk");
  });

  it("spawnClaude includes --permission-prompt-tool followed by stdio in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--permission-prompt-tool");
    const idx = args.indexOf("--permission-prompt-tool");
    expect(args[idx + 1]).toBe("stdio");
  });
});

describe("mcp-config flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude with mcpConfigPath includes --mcp-config followed by the path", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--mcp-config");
    const idx = args.indexOf("--mcp-config");
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json");
  });

  it("spawnClaude without mcpConfigPath does NOT include --mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--mcp-config");
  });

  it("spawnClaude NEVER includes --strict-mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--strict-mcp-config");
  });

  it("backward compatibility - existing calls with only thinking/cwd still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "system prompt", {
      cwd: "/path",
      thinking: {
        kind: "enabled",
        budgetTokens: 16384,
        effort: "high",
        display: "summarized",
      },
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("--effort");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--permission-prompt-tool");
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

describe("resume session flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --resume followed by session ID when resumeSessionId is provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc-123",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    const idx = args.indexOf("--resume");
    expect(args[idx + 1]).toBe("session-abc-123");
  });

  it("does NOT include --resume when resumeSessionId is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--resume");
  });

  it("includes both --resume and --effort when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      thinking: {
        kind: "enabled",
        budgetTokens: 16384,
        effort: "high",
        display: "summarized",
      },
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--effort");
  });

  it("includes both --resume and --mcp-config when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      mcpConfigPath: "/tmp/mcp.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--mcp-config");
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
    process.env.PI_CLAUDE_CLI_SETTINGS = "/etc/phosphor/claude-settings.json";
    spawnClaude("claude-haiku-4-5");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe(
      "/etc/phosphor/claude-settings.json",
    );
  });

  it("omits --settings when unset", () => {
    delete process.env.PI_CLAUDE_CLI_SETTINGS;
    spawnClaude("claude-haiku-4-5");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--settings");
  });
});

describe("sendInterrupt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an interrupt control_request to stdin", () => {
    const proc = spawnClaude("claude-haiku-4-5");
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
    const proc = spawnClaude("claude-haiku-4-5");
    (proc as any).killed = true;
    sendInterrupt(proc);
    expect((proc.stdin!.write as any).mock.calls).toHaveLength(0);
  });

  it("mints distinct request ids", () => {
    const proc = spawnClaude("claude-haiku-4-5");
    sendInterrupt(proc);
    sendInterrupt(proc);
    const ids = (proc.stdin!.write as any).mock.calls.map(
      (c: any) => JSON.parse(String(c[0])).request_id,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("cleanupSystemPromptFile", () => {
  it("deletes the temp file when it exists", () => {
    // Create the file by spawning with a system prompt
    (spawn as any).mockClear();
    spawnClaude("claude-sonnet-4-5-20250929", "test prompt");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const tmpFile = args[args.indexOf("--append-system-prompt-file") + 1];
    expect(existsSync(tmpFile)).toBe(true);

    cleanupSystemPromptFile();
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("does not throw when file does not exist", () => {
    // Ensure file doesn't exist
    cleanupSystemPromptFile();
    // Call again — should not throw
    expect(() => cleanupSystemPromptFile()).not.toThrow();
  });
});

describe("strict MCP mode", () => {
  const originalStrict = process.env.PI_CLAUDE_CLI_STRICT_MCP;
  const originalHermetic = process.env.PI_CLAUDE_CLI_HERMETIC;

  afterEach(() => {
    if (originalStrict === undefined)
      delete process.env.PI_CLAUDE_CLI_STRICT_MCP;
    else process.env.PI_CLAUDE_CLI_STRICT_MCP = originalStrict;
    if (originalHermetic === undefined)
      delete process.env.PI_CLAUDE_CLI_HERMETIC;
    else process.env.PI_CLAUDE_CLI_HERMETIC = originalHermetic;
  });

  it("adds --strict-mcp-config WITHOUT touching --setting-sources", () => {
    process.env.PI_CLAUDE_CLI_STRICT_MCP = "1";
    delete process.env.PI_CLAUDE_CLI_HERMETIC;

    spawnClaude("claude-haiku-4-5", undefined, {});
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];

    expect(args).toContain("--strict-mcp-config");
    // The whole point of the split: CLAUDE.md auto-memory stays loaded.
    expect(args).not.toContain("--setting-sources");
  });

  it("does not double up when hermetic mode is also enabled", () => {
    process.env.PI_CLAUDE_CLI_STRICT_MCP = "1";
    process.env.PI_CLAUDE_CLI_HERMETIC = "1";

    spawnClaude("claude-haiku-4-5", undefined, {});
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];

    expect(args.filter((a) => a === "--strict-mcp-config")).toHaveLength(1);
    expect(args).toContain("--setting-sources");
  });

  it("stays off when unset or falsy", () => {
    delete process.env.PI_CLAUDE_CLI_STRICT_MCP;
    delete process.env.PI_CLAUDE_CLI_HERMETIC;
    spawnClaude("claude-haiku-4-5", undefined, {});
    let args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).not.toContain("--strict-mcp-config");

    process.env.PI_CLAUDE_CLI_STRICT_MCP = "0";
    spawnClaude("claude-haiku-4-5", undefined, {});
    args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).not.toContain("--strict-mcp-config");
  });
});

describe("hermetic mode (issue #5)", () => {
  const originalEnv = process.env.PI_CLAUDE_CLI_HERMETIC;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_CLAUDE_CLI_HERMETIC;
    else process.env.PI_CLAUDE_CLI_HERMETIC = originalEnv;
  });

  it("adds --strict-mcp-config and empty --setting-sources when enabled", () => {
    process.env.PI_CLAUDE_CLI_HERMETIC = "1";
    spawnClaude("claude-haiku-4-5", undefined, {});
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).toContain("--strict-mcp-config");
    const idx = args.indexOf("--setting-sources");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("");
  });

  it("keeps the default environment when disabled or unset", () => {
    delete process.env.PI_CLAUDE_CLI_HERMETIC;
    spawnClaude("claude-haiku-4-5", undefined, {});
    let args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--setting-sources");

    process.env.PI_CLAUDE_CLI_HERMETIC = "0";
    spawnClaude("claude-haiku-4-5", undefined, {});
    args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).not.toContain("--strict-mcp-config");
  });
});

describe("ephemeral mode (PI_CLAUDE_CLI_EPHEMERAL)", () => {
  const originalEnv = process.env.PI_CLAUDE_CLI_EPHEMERAL;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_CLAUDE_CLI_EPHEMERAL;
    else process.env.PI_CLAUDE_CLI_EPHEMERAL = originalEnv;
  });

  it.each(["1", "true", "YES"])(
    "adds --no-session-persistence when set to %s",
    (value) => {
      process.env.PI_CLAUDE_CLI_EPHEMERAL = value;
      spawnClaude("claude-haiku-4-5", undefined, {});
      const args = (spawn as any).mock.calls.at(-1)[1] as string[];
      expect(args.filter((a) => a === "--no-session-persistence")).toHaveLength(
        1,
      );
    },
  );

  it("keeps --session-id alongside it, so the spawn stays keyed", () => {
    // The id still names the staged prompt file and the MCP config; the CLI
    // honours it without writing a transcript (verified on 2.1.280).
    process.env.PI_CLAUDE_CLI_EPHEMERAL = "1";
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "eph-1" });
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args[args.indexOf("--session-id") + 1]).toBe("eph-1");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
  });

  it("stays off when unset or falsy: the default argv is unchanged", () => {
    delete process.env.PI_CLAUDE_CLI_EPHEMERAL;
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "s-1" });
    const unset = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(unset).not.toContain("--no-session-persistence");

    process.env.PI_CLAUDE_CLI_EPHEMERAL = "0";
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "s-1" });
    const falsy = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(falsy).toEqual(unset);
  });
});

describe("auto-compact window (PI_CLAUDE_CLI_AUTOCOMPACT)", () => {
  const originalEnv = process.env.PI_CLAUDE_CLI_AUTOCOMPACT;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_CLAUDE_CLI_AUTOCOMPACT;
    else process.env.PI_CLAUDE_CLI_AUTOCOMPACT = originalEnv;
  });

  function lastAutocompactValue(): string | undefined {
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];
    const idx = args.indexOf("--autocompact");
    return idx === -1 ? undefined : args[idx + 1];
  }

  it("caps the window at 200k by default", () => {
    delete process.env.PI_CLAUDE_CLI_AUTOCOMPACT;
    spawnClaude("claude-haiku-4-5", undefined, {});
    expect(lastAutocompactValue()).toBe("200000");
  });

  it("honours a configured window, normalized to plain tokens", () => {
    process.env.PI_CLAUDE_CLI_AUTOCOMPACT = "400k";
    spawnClaude("claude-haiku-4-5", undefined, {});
    expect(lastAutocompactValue()).toBe("400000");
  });

  it("passes auto through for the CLI's own default", () => {
    process.env.PI_CLAUDE_CLI_AUTOCOMPACT = "auto";
    spawnClaude("claude-haiku-4-5", undefined, {});
    expect(lastAutocompactValue()).toBe("auto");
  });

  it("omits the flag entirely when off (older CLIs reject unknown flags)", () => {
    process.env.PI_CLAUDE_CLI_AUTOCOMPACT = "off";
    spawnClaude("claude-haiku-4-5", undefined, {});
    expect(lastAutocompactValue()).toBeUndefined();
  });

  it("rides resumed spawns too — the CLI keeps no flags across --resume", () => {
    delete process.env.PI_CLAUDE_CLI_AUTOCOMPACT;
    spawnClaude("claude-haiku-4-5", undefined, {
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args).toContain("--resume");
    expect(lastAutocompactValue()).toBe("200000");
  });

  it("never lets an invalid value reach the CLI (it would refuse to start)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PI_CLAUDE_CLI_AUTOCOMPACT = "50k";
    spawnClaude("claude-haiku-4-5", undefined, {});
    expect(lastAutocompactValue()).toBe("200000");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
