/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";
import {
  DEFAULT_SYSTEM_PROMPT_MODE,
  type SystemPromptMode,
} from "./system-prompt-mode.js";
import { resolveAutocompact } from "./autocompact.js";
import {
  usesPiContext,
  ContextPolicyError,
  assertContextCliVersion,
} from "./context-policy.js";
import { envFlag, isEphemeral } from "./env-flag.js";
import { thinkingSpawnArgs, type CliThinking } from "./thinking-config.js";

/**
 * Spawn a Claude CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Optional system prompt. In `claude` mode it is appended
 *   to Claude Code's own via --append-system-prompt-file; in `pi` mode it
 *   replaces it via --system-prompt-file. The `-file` suffix is required: the
 *   unsuffixed flags take a literal string. See src/system-prompt-mode.ts.
 * @param options - Optional cwd, AbortSignal, thinking and prompt mode
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
/** Truthy PI_CLAUDE_CLI_HERMETIC opts in to hermetic mode (see README). */
function isHermetic(): boolean {
  return envFlag("PI_CLAUDE_CLI_HERMETIC");
}

/**
 * Truthy PI_CLAUDE_CLI_STRICT_MCP restricts the CLI to this extension's own
 * schema-only server WITHOUT hermetic mode's settings blackout (see README).
 */
function isStrictMcp(): boolean {
  return envFlag("PI_CLAUDE_CLI_STRICT_MCP");
}

/**
 * Where a spawn's system prompt is staged. Scoped to the CLI session so
 * concurrent turns in one pi process cannot clobber each other.
 */
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

function systemPromptFilePath(sessionKey?: string): string {
  // In the private 0700 runtime directory, written 0600: the prompt carries
  // pi's instructions and the host's project context, which used to sit in a
  // world-readable /tmp file under a pid-derived name.
  const suffix = sessionKey
    ? `-${sessionKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)}`
    : "";
  return runtimeFile(`pi-claude-cli-sysprompt${suffix}.txt`);
}

export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    /** The thinking this process starts with; see src/thinking-config.ts. */
    thinking?: CliThinking;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
    systemPromptMode?: SystemPromptMode;
  },
): ChildProcess {
  const piContext = usesPiContext();
  if (piContext) {
    assertContextCliVersion(
      execSync("claude --version", { stdio: "pipe", timeout: 5000 }).toString(),
    );
  }
  if (
    piContext &&
    (envFlag("CLAUDE_CODE_SIMPLE") || envFlag("CLAUDE_CODE_SAFE_MODE"))
  ) {
    throw new ContextPolicyError(
      "Unset CLAUDE_CODE_SIMPLE/CLAUDE_CODE_SAFE_MODE: pi context requires subscription authentication and the explicit MCP bridge.",
    );
  }
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
    // `AskUserQuestion` renders a picker in the CLI's own TUI, and `-p` has
    // no TUI. The call therefore cannot be answered by anyone: it returns
    // "The user did not answer the questions." after a full round trip, and
    // the model reads that as a person who declined and falls back to asking
    // in prose. Captured 2026-08-28 on claude-sonnet-5, which then wrote
    // "happy to discuss in plain text instead". Take the tool away so the
    // model asks in prose the first time — the host's UI shows prose, and
    // the user can answer it.
    "--disallowedTools",
    "AskUserQuestion",
  ];

  // Two independent ways to keep the user's Claude Code environment out of pi
  // turns. Both flags verified accepted on claude 2.1.237.
  //
  // --strict-mcp-config loads ONLY the servers from --mcp-config (our
  // schema-only custom-tools server survives; the user's personal and project
  // MCP servers do not). A host wants this on its own: MCP servers the host
  // did not configure are invisible to it, bypass its tool guards, and are
  // never counted by pi-side status or context accounting.
  if (piContext || isHermetic() || isStrictMcp()) {
    args.push("--strict-mcp-config");
  }

  // An empty --setting-sources skips user/project/local settings — hooks,
  // CLAUDE.md auto-memory, permission allowlists. Kept separate from the MCP
  // flag on purpose: a host that already suppresses pi's own copy of
  // CLAUDE.md relies on the CLI loading it, and bundling the two would leave
  // the model with no project instructions from either side.
  if (piContext || isHermetic()) {
    args.push("--setting-sources", "");
  }
  if (piContext) {
    args.push("--disable-slash-commands", "--no-chrome", "--tools", "");
  }

  if (!piContext && options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  }

  // Nothing the CLI would write here is ever read back, for one of two
  // reasons. Under pi context the process is a disposable cache of pi's
  // history and is never resumed. PI_CLAUDE_CLI_EPHEMERAL (src/env-flag.ts)
  // marks a legacy one-shot with no next turn, so its transcript under
  // ~/.claude/projects would be pure disk debris (~60 KB per call).
  // --session-id stays: the id still keys this spawn's staged prompt and MCP
  // config, and the CLI honours it without writing anything. Verified on
  // claude 2.1.280 with exactly this flag set (stream-json + --session-id): no
  // transcript written, the result envelope carried the requested session_id.
  // A legacy pi session that only ever runs ephemeral never reaches --resume
  // either: session-map.ts records no pairing for it to resume from.
  if (piContext || isEphemeral()) {
    args.push("--no-session-persistence");
  }

  if (systemPrompt || piContext) {
    // Write the system prompt to a temp file and pass the FILE flags.
    //
    // `--system-prompt` / `--append-system-prompt` take a literal string, NOT
    // a path: handing them a path makes the path itself the system prompt, so
    // pi's instructions never reach the model and the session silently runs on
    // Claude Code's defaults. Verified on claude 2.1.231 — with a path the
    // model denied having the codename its prompt assigned; with
    // `--system-prompt-file` it answered correctly. The file variants also keep
    // the prompt off the command line, which is what avoids ENAMETOOLONG on
    // Windows.
    //
    // Keyed by CLI session, not just pid: the prompt goes on every spawn
    // (see provider.ts), and pi can run two turns of one process at once —
    // its own sub-agents do. A shared per-pid path would let one turn
    // overwrite the prompt another turn is about to read.
    const tmpFile = systemPromptFilePath(
      options?.resumeSessionId ?? options?.newSessionId,
    );
    writeFileSync(tmpFile, systemPrompt ?? "", {
      encoding: "utf-8",
      mode: RUNTIME_FILE_MODE,
    });
    // `pi` mode replaces Claude Code's prompt outright; `claude` mode layers
    // pi's on top of it. See src/system-prompt-mode.ts for the trade-off.
    const mode = piContext
      ? "pi"
      : (options?.systemPromptMode ?? DEFAULT_SYSTEM_PROMPT_MODE);
    args.push(
      mode === "pi" ? "--system-prompt-file" : "--append-system-prompt-file",
      tmpFile,
    );
  }

  // Host-supplied Claude Code settings (hooks, permissions). This is how a
  // host injects PreToolUse guards — e.g. Phosphor's worktree-paths guard —
  // without pi intercepting the CLI's native tool execution.
  const settingsPath = process.env.PI_CLAUDE_CLI_SETTINGS;
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }

  // A later turn may change these on the live process through control
  // requests (CliProcess.applyThinking), so they are the starting point, not
  // part of what makes a process reusable.
  if (options?.thinking) {
    args.push(...thinkingSpawnArgs(options.thinking));
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  // Auto-compact window (PI_CLAUDE_CLI_AUTOCOMPACT, default 200k — see
  // src/autocompact.ts). The CLI does not keep flags across --resume, so
  // like the system prompt this goes on every spawn. Resolved per spawn so
  // a host can change the setting without restarting pi; the flag is
  // config, not context, so changing it never invalidates the prompt cache.
  const autocompact = resolveAutocompact();
  if (!piContext && autocompact !== undefined) {
    args.push("--autocompact", autocompact);
  }

  // Proxied custom tools block inside the CLI's MCP client until pi has run
  // the tool (src/handoff-broker.ts). Sub-agents and long shell tools take
  // minutes, so unless the host set its own limit, give the MCP client an
  // hour before it gives up on a call. Config, not context: it never touches
  // the prompt cache.
  const env = { ...process.env };
  if (piContext) {
    // Do not use --bare: it disables subscription OAuth/keychain reads.
    // Empty setting sources drop user/project/local hooks, but explicit
    // host --settings (including safety guards) and managed policy survive.
    Object.assign(env, {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
  }
  // An exported API key, auth token or gateway URL silently moves the CLI off
  // the subscription login this provider exists to use: turns then bill an
  // API account, or fail against a gateway that was meant for another tool.
  for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) delete env[name];
  if (!env.MCP_TOOL_TIMEOUT)
    env.MCP_TOOL_TIMEOUT = String(DEFAULT_MCP_TOOL_TIMEOUT_MS);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
    env,
  });

  return proc as ChildProcess;
}

/**
 * Clean up the temp system prompt file created by spawnClaude.
 * Safe to call multiple times or when no file exists.
 *
 * Pass the same CLI session key the spawn used; omitting it cleans the
 * unscoped path, which is all a spawn without a session id creates.
 */
export function cleanupSystemPromptFile(sessionKey?: string): void {
  try {
    unlinkSync(systemPromptFilePath(sessionKey));
  } catch {
    // File doesn't exist or already deleted — ignore
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end() -- stdin stays open for control_response in Phase 2.
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
 * Esc produces. Unlike SIGKILL this lets the CLI persist the turn, so the
 * session stays resumable without transcript corruption. The turn then ends
 * with a `result` of subtype `error_during_execution`, which callers must
 * treat as expected.
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
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
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
