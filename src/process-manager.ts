/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Spawn with the CLI flags that make pi the owner of prompt and tools, write
 * NDJSON messages to stdin, interrupt, force-kill, and capture stderr. Also
 * provides startup validation for CLI presence and authentication.
 */

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";
import {
  CliRequirementError,
  assertSupportedCliVersion,
} from "./cli-requirements.js";
import { envFlag } from "./env-flag.js";
import { thinkingSpawnArgs, type CliThinking } from "./thinking-config.js";

/** One hour: the MCP tool-call timeout handed to the CLI when unset. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000;

/**
 * Environment variables that redirect the CLI away from its subscription
 * login. Never forwarded to the Claude subprocess.
 */
export const SUBSCRIPTION_OVERRIDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

/**
 * Ceiling on captured stderr. A parked process lives for hours; its stderr is
 * only ever read to explain a failure, so the most recent output is what
 * matters and the rest must not grow without bound.
 */
export const STDERR_CAPTURE_LIMIT_CHARS = 64 * 1024;

/**
 * Where a spawn's system prompt is staged. Scoped to the CLI session so
 * concurrent turns in one pi process cannot clobber each other.
 */
function systemPromptFilePath(cliSessionId: string): string {
  // In the private 0700 runtime directory, written 0600: the prompt carries
  // pi's instructions and the project context.
  const suffix = cliSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return runtimeFile(`pi-claude-cli-sysprompt-${suffix}.txt`);
}

/**
 * Spawn a Claude CLI subprocess that serves pi: stream-json on both pipes,
 * pi's system prompt in place of Claude Code's, no native tools, and none of
 * the user's Claude Code settings, memory, skills or MCP servers.
 *
 * @param modelId - The model ID to pass via --model
 * @param systemPrompt - pi's system prompt. It REPLACES Claude Code's via
 *   --system-prompt-file. The `-file` suffix is required: the unsuffixed flag
 *   takes a literal string, so handing it a path makes the path the prompt.
 * @param options.cliSessionId - Provider-minted id for this process; keys its
 *   staged prompt file and MCP config.
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 * @throws CliRequirementError when the installed CLI or environment cannot
 *   provide the isolation this provider depends on
 */
export function spawnClaude(
  modelId: string,
  systemPrompt: string,
  options: {
    cliSessionId: string;
    cwd?: string;
    /** The thinking this process starts with; see src/thinking-config.ts. */
    thinking?: CliThinking;
    mcpConfigPath?: string;
  },
): ChildProcess {
  assertSupportedCliVersion(
    execSync("claude --version", { stdio: "pipe", timeout: 5000 }).toString(),
  );
  if (envFlag("CLAUDE_CODE_SIMPLE") || envFlag("CLAUDE_CODE_SAFE_MODE")) {
    throw new CliRequirementError(
      "Unset CLAUDE_CODE_SIMPLE/CLAUDE_CODE_SAFE_MODE: pi-claude-cli requires subscription authentication and the explicit MCP bridge.",
    );
  }

  // Staged as a file: it keeps the prompt off the command line (and avoids
  // ENAMETOOLONG on Windows).
  const promptFile = systemPromptFilePath(options.cliSessionId);
  writeFileSync(promptFile, systemPrompt, {
    encoding: "utf-8",
    mode: RUNTIME_FILE_MODE,
  });

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
    "--permission-prompt-tool",
    "stdio",
    // Only the servers from --mcp-config: the schema-only server carrying
    // pi's tools. The user's personal and project MCP servers stay out.
    "--strict-mcp-config",
    // No user/project/local settings: hooks, CLAUDE.md memory, permission
    // allowlists. Explicit host --settings and managed policy still apply.
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    // No native tools: every tool is pi's.
    "--tools",
    "",
    // The id keys this spawn's staged files; the CLI honours it without
    // writing a transcript.
    "--session-id",
    options.cliSessionId,
    // The process is a disposable cache of pi's history and is never resumed.
    "--no-session-persistence",
    "--system-prompt-file",
    promptFile,
  ];

  // Host-supplied Claude Code settings (hooks, permissions).
  const settingsPath = process.env.PI_CLAUDE_CLI_SETTINGS;
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }

  // A later turn may change these on the live process through control
  // requests (CliProcess.applyThinking), so they are the starting point, not
  // part of what makes a process reusable.
  if (options.thinking) {
    args.push(...thinkingSpawnArgs(options.thinking));
  }

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  // Do not use --bare: it disables subscription OAuth/keychain reads.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    // pi owns compaction.
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    ENABLE_TOOL_SEARCH: "false",
  };
  // An exported API key, auth token or gateway URL silently moves the CLI off
  // the subscription login this provider exists to use: turns then bill an
  // API account, or fail against a gateway that was meant for another tool.
  for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) delete env[name];
  // Proxied tool calls block inside the CLI's MCP client until pi has run the
  // tool (src/handoff-broker.ts). Long shell tools take minutes, so unless
  // the host set its own limit, give the MCP client an hour.
  if (!env.MCP_TOOL_TIMEOUT)
    env.MCP_TOOL_TIMEOUT = String(DEFAULT_MCP_TOOL_TIMEOUT_MS);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd ?? process.cwd(),
    env,
  });

  return proc as ChildProcess;
}

/**
 * Remove the system prompt file spawnClaude staged for `cliSessionId`.
 * Safe to call multiple times or when no file exists.
 */
export function cleanupSystemPromptFile(cliSessionId: string): void {
  try {
    unlinkSync(systemPromptFilePath(cliSessionId));
  } catch {
    // File doesn't exist or already deleted — ignore
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end(): stdin stays open for control responses and for
 * the session's later turns.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | any[],
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/**
 * Ask the CLI to end the current turn cleanly — the same interrupt a human
 * Esc produces. The turn then ends with a `result` of subtype
 * `error_during_execution`, which callers must treat as expected.
 */
export function sendInterrupt(proc: ChildProcess): void {
  // `exitCode != null` (loose): undefined means "has not exited" on mocks and
  // some stream wrappers, and must count as alive.
  if (proc.killed || proc.exitCode != null || !proc.stdin) return;
  const request = {
    type: "control_request",
    request_id: `int-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    request: { subtype: "interrupt" },
  };
  try {
    proc.stdin.write(JSON.stringify(request) + "\n");
  } catch {
    // stdin already closed — the force-kill fallback will handle it.
  }
}

/**
 * Force-kill a subprocess immediately via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * Keeps only the most recent STDERR_CAPTURE_LIMIT_CHARS characters.
 *
 * @returns A function that returns the captured stderr tail
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
    if (buffer.length > STDERR_CAPTURE_LIMIT_CHARS) {
      buffer = buffer.slice(-STDERR_CAPTURE_LIMIT_CHARS);
    }
  });
  return () => buffer;
}

/**
 * Validate that the Claude CLI is installed and on PATH.
 * Throws with install instructions if not found.
 */
export function validateCliPresence(): void {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate by running `claude` and using `/login`.",
    );
  }
}

/**
 * Validate that the Claude CLI is authenticated.
 * Returns false and warns if not authenticated.
 *
 * Claude Code 2.x emits machine-readable JSON on `auth status` when stdout
 * is not a TTY, e.g. `{ "loggedIn": true, "authMethod": "claude.ai", ... }`.
 * We parse it and trust `loggedIn` rather than relying solely on the exit
 * code, because some transient warnings (e.g. token-refresh notices on
 * stderr) can produce a non-zero exit even when the user is signed in.
 *
 * Older CLIs that don't emit JSON fall back to exit-code semantics.
 *
 * @returns true if authenticated, false otherwise
 */
export function validateCliAuth(): boolean {
  let stdout: string | Buffer = "";
  let exitCode: number | null = null;
  try {
    stdout = execSync("claude auth status", {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      encoding: "utf8",
    });
    exitCode = 0;
  } catch (err) {
    const e = err as { status?: number | null; stdout?: Buffer | string };
    exitCode = typeof e.status === "number" ? e.status : null;
    stdout = e.stdout ?? "";
  }

  const trimmed = (
    typeof stdout === "string" ? stdout : stdout.toString()
  ).trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: boolean };
      if (parsed.loggedIn === true) return true;
      warnUnauth();
      return false;
    } catch {
      // fall through to exit-code semantics
    }
  }

  if (exitCode === 0) return true;
  warnUnauth();
  return false;
}

function warnUnauth(): void {
  console.warn(
    "[pi-claude-cli] Claude CLI is not authenticated. " +
      "Run `claude` and use `/login` to authenticate.",
  );
}
