/**
 * Provider orchestration: one pi model call, served by a Claude CLI process.
 *
 * pi owns the system prompt, the tools, the conversation and compaction. The
 * Claude CLI contributes subscription authentication and model access, and is
 * treated as a disposable cache of pi's history. streamViaCli:
 * 1. Reuses the pi session's parked CLI process when this call continues the
 *    history that process has acknowledged; otherwise spawns `claude -p` and
 *    imports pi's full history as one user message (src/pi-context.ts)
 * 2. Streams prose and thinking to pi verbatim, and every tool call as a real
 *    pi toolCall block: all tools are pi's, advertised to the CLI through the
 *    schema-only MCP server (src/mcp-schema-server.cjs)
 * 3. On a tool call at message_stop: ends pi's stream with stopReason=toolUse
 *    so pi executes the tool, while the CLI blocks on the proxied `tools/call`;
 *    the next pi call answers it on the SAME process (src/handoff-broker.ts,
 *    src/cli-process.ts). Without the proxy (no pi session id, or
 *    PI_CLAUDE_CLI_HANDOFF_PROXY=0) the turn is interrupted instead and the
 *    next call starts a fresh process from pi's history
 * 4. After `result`: parks the process for the session's next call (idle
 *    timer) instead of killing it
 * 5. Hardened lifecycle: inactivity timeout, exit handler, streamEnded guard,
 *    abort retires the process, process registry
 */

import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  spawnClaude,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  sendInterrupt,
} from "./process-manager.js";
import { createEventBridge } from "./event-bridge.js";
import type { ClaudeModelUsage, ClaudeUsage } from "./types.js";
import { resolveCliThinking } from "./thinking-config.js";
import { isHandoffClaudeTool, mapClaudeToolNameToPi } from "./tool-mapping.js";
import { writeSessionMcpConfig, removeSessionMcpConfig } from "./mcp-config.js";
import {
  CliProcess,
  parkCliProcess,
  takeParkedCliProcess,
  addUsage,
  subUsage,
  maxUsage,
  ZERO_USAGE,
  type Usage4,
  type EpisodeSink,
} from "./cli-process.js";
import type { HandoffResult } from "./handoff-broker.js";
import { handoffSecretFile } from "./handoff-broker.js";
import { randomUUID } from "node:crypto";
import {
  piContext as normalizePiContext,
  piSystemPrompt,
  historyHash,
  replayPiMessages,
} from "./pi-context.js";

/**
 * Inactivity timeout: the longest the CLI may stay silent on stdout while an
 * episode is attached. Tool execution does not count against it (pi runs
 * tools between episodes). Overridable via PI_CLAUDE_CLI_TIMEOUT_MS.
 */
const INACTIVITY_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS)
    : 300_000;

/**
 * How long a parked CLI process waits for the next turn before it is retired
 * (PI_CLAUDE_CLI_KEEPALIVE_MS; `0`/`off` parks nothing — the process ends at
 * `result`, and only handoffs keep it alive). The default is ten minutes:
 * long enough to span a user reading an answer, short enough that an
 * abandoned session does not hold ~200 MB for an afternoon. The next turn
 * after a retire imports pi's history into a fresh process.
 */
const DEFAULT_KEEPALIVE_MS = 600_000;

function keepaliveMs(): number {
  const raw = (process.env.PI_CLAUDE_CLI_KEEPALIVE_MS ?? "")
    .trim()
    .toLowerCase();
  if (raw === "") return DEFAULT_KEEPALIVE_MS;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "none")
    return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEPALIVE_MS;
}

/**
 * Ceiling on a process blocked in a proxied handoff with no pi call coming
 * back (pi aborted the tool, crashed, or moved on). Sub-agent handoffs run
 * for a long time legitimately, so this is generous; the process is
 * interrupted and retired when it fires.
 */
const HANDOFF_WAIT_MS =
  Number(process.env.PI_CLAUDE_CLI_HANDOFF_WAIT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_HANDOFF_WAIT_MS)
    : 1_800_000;

/** Kill switch for the proxied handoff (falls back to interrupt-and-reimport). */
function handoffProxyAllowed(): boolean {
  return process.env.PI_CLAUDE_CLI_HANDOFF_PROXY !== "0";
}

/** Extended stream options: pi's SimpleStreamOptions plus host plumbing. */
type StreamViaCliOptions = SimpleStreamOptions & {
  cwd?: string;
  /** Pre-built `--mcp-config` file used verbatim (tests). */
  mcpConfigPath?: string;
  /**
   * The staged tool schema and the handoff socket. The provider writes one
   * config file per CLI process from these so the schema server can route
   * proxied tool calls back to that process.
   */
  mcpConfig?: {
    schemaPath: string;
    /** Identifies the tool surface staged at `schemaPath`. */
    version: number;
    /** Handoff socket path, or a promise of one (the broker starts lazily). */
    handoffSocket?: string | Promise<string | undefined>;
  };
};

/**
 * A parked process is stale when pi's history moved on without it: the most
 * recent assistant turn came from another provider (model switch), so the
 * process never saw that exchange. Continuing it would answer from a
 * conversation missing turns, so reimport instead.
 */
function cliSessionIsStale(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return !(m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli");
  }
  return false; // no assistant turns at all: nothing to be behind
}

/** Messages after the last assistant turn: what this call adds. */
function deltaMessages(messages: any[]): any[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  return messages.slice(lastAssistantIdx + 1);
}

/** pi toolResult content → MCP tool result the CLI understands. */
export function toHandoffResult(msg: any): HandoffResult {
  const content: HandoffResult["content"] = [];
  const raw = msg?.content;
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw });
  } else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        content.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      } else {
        try {
          content.push({ type: "text", text: JSON.stringify(block) });
        } catch {
          /* unserializable block — skip */
        }
      }
    }
  } else if (raw != null) {
    try {
      content.push({ type: "text", text: JSON.stringify(raw) });
    } catch {
      /* skip */
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return msg?.isError ? { content, isError: true } : { content };
}

function usage4(u: ClaudeUsage | undefined): Usage4 {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function sumModelUsage(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
): Usage4 | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  let total = ZERO_USAGE;
  for (const e of entries) {
    total = addUsage(total, {
      input_tokens: e.inputTokens ?? 0,
      output_tokens: e.outputTokens ?? 0,
      cache_read_input_tokens: e.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: e.cacheCreationInputTokens ?? 0,
    });
  }
  return total;
}

function bridgeUsage4(output: any): Usage4 {
  const u = output?.usage ?? {};
  return {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
  };
}

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the subprocess lifecycle for one pi model call: reuse the
 * session's parked process or spawn one from pi's history, write the prompt or
 * answer the pending tool calls, parse NDJSON, bridge events, handle the
 * result, park or retire.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - pi's conversation: messages, system prompt and tools
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and MCP plumbing
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  options?: StreamViaCliOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  // pi 0.86+ sends its prompt and tools as system messages and leaves
  // systemPrompt empty. Read the current ones from there.
  const piRequest = normalizePiContext(context);

  /** End the stream with an error before any episode has attached. */
  function failRequest(error: string, reason: "error" | "aborted" = "error") {
    const message = createEventBridge(stream, model).getOutput();
    stream.push({
      type: "error",
      reason,
      error: { ...message, stopReason: reason, errorMessage: error },
    } as any);
    stream.end();
  }
  if (options?.signal?.aborted) {
    failRequest("Request aborted", "aborted");
    return stream;
  }

  async function runEpisode(): Promise<void> {
    let cli: CliProcess | undefined;
    let abortHandler: (() => void) | undefined;
    // A tool_use block streamed in the current assistant message: the episode
    // ends at message_stop so pi can execute it.
    let sawToolCall = false;
    // Set once we have asked the CLI to end the turn (interrupt fallback):
    // stream content is frozen and only the result envelope is awaited.
    let selfInterrupted = false;
    // Set on pi-initiated abort.
    let aborted = false;
    // CLI session this call staged its system prompt under, so the finally
    // below can remove the right file. Only set when this call spawned.
    let promptFileKey: string | undefined;
    // The pi session, for parking.
    const piSessionId = options?.sessionId;

    try {
      const cwd = options?.cwd ?? process.cwd();
      const messages = piRequest.messages as any[];
      const stale = cliSessionIsStale(messages);
      const delta = deltaMessages(messages);
      const thinking = resolveCliThinking(
        model,
        options?.reasoning,
        options?.thinkingBudgets,
      );
      const handoffSocketPath = options?.mcpConfig?.handoffSocket
        ? await options.mcpConfig.handoffSocket
        : undefined;
      // The proxy needs a pi session to route the continuation back to.
      const allowHandoff =
        handoffProxyAllowed() && !!piSessionId && !!handoffSocketPath;
      // Everything a process was spawned with that a later call cannot change
      // in place. Thinking is deliberately absent: a live process takes a new
      // level through control requests (step 1), so changing it mid-session
      // does not cost a respawn and a full-history replay.
      const signature = JSON.stringify([
        model.id,
        piRequest.systemPrompt,
        cwd,
        options?.mcpConfigPath ?? null,
        options?.mcpConfig?.schemaPath ?? null,
        options?.mcpConfig?.version ?? null,
        handoffSocketPath ?? null,
        allowHandoff,
        process.env.PI_CLAUDE_CLI_SETTINGS ?? null,
      ]);

      // ---- 1. Reuse the session's parked process when this call continues it
      let mode: "spawn" | "turn" | "handoff" = "spawn";
      const parkedCli = piSessionId
        ? takeParkedCliProcess(piSessionId)
        : undefined;
      if (parkedCli) {
        const checkpoint = parkedCli.piHistory;
        const historyMatches =
          !!checkpoint &&
          messages.length >= checkpoint.length &&
          historyHash(messages.slice(0, checkpoint.length)) === checkpoint.hash;
        if (!stale && historyMatches && parkedCli.signature === signature) {
          const toolResults = delta.filter((m) => m?.role === "toolResult");
          const userMessages = delta.filter((m) => m?.role === "user");
          if (parkedCli.turnActive) {
            // Blocked in a proxied handoff: only pi's results for exactly
            // those tool calls can continue the turn in-process.
            const ids = toolResults.map((m) => String(m.toolCallId ?? ""));
            if (
              toolResults.length === delta.length &&
              parkedCli.canContinueHandoff(ids)
            ) {
              mode = "handoff";
            }
          } else if (toolResults.length === 0 && userMessages.length > 0) {
            mode = "turn";
          }
        }
        // A new user turn runs at the level pi asks for now. A handoff keeps
        // the turn it is continuing: the CLI reads thinking once per user
        // turn, so a change made mid-turn applies from the next one.
        if (mode === "turn" && !(await parkedCli.applyThinking(thinking))) {
          mode = "spawn";
        }
        if (mode === "spawn") {
          // Different spawn parameters, a history the process has not
          // acknowledged, or a delta it cannot take: end it and start over.
          await parkedCli.retire();
        } else {
          cli = parkedCli;
        }
      }

      // ---- 2. Or spawn a fresh process and import pi's full history
      if (!cli) {
        // A provider-minted id, never pi's: it only keys this spawn's staged
        // prompt and MCP config, and forks reuse pi ids.
        const cliSessionId = randomUUID();
        promptFileKey = cliSessionId;

        // The MCP config names this CLI session so proxied tool calls route
        // back here. A verbatim mcpConfigPath (tests) wins.
        const mcpConfigPath =
          options?.mcpConfigPath ??
          (options?.mcpConfig
            ? writeSessionMcpConfig(
                cliSessionId,
                options.mcpConfig.schemaPath,
                allowHandoff ? handoffSocketPath : undefined,
                allowHandoff ? handoffSecretFile() : undefined,
              )
            : undefined);

        const proc = spawnClaude(
          model.id,
          piSystemPrompt(piRequest.systemPrompt ?? ""),
          { cwd, thinking, mcpConfigPath, cliSessionId },
        );
        const getStderr = captureStderr(proc);
        // Register in global process registry for teardown cleanup
        registerProcess(proc);

        cli = new CliProcess(proc, {
          cliSessionId,
          signature,
          allowHandoff,
          getStderr,
          thinking,
        });
        cli.writeUser(replayPiMessages(messages));
      }

      const live = cli;
      const proc = live.proc;

      // ---- 3. The episode: one pi call's view of the process
      const bridge = createEventBridge(stream, model);
      // Usage earlier episodes of this CLI turn already handed to pi. The
      // result's cumulative figures are reduced by this so the turn is billed
      // once across its episodes.
      const turnReportedBefore = live.turnReported;
      let episodeResultTotals = ZERO_USAGE;

      // Guard against double stream.end() and double error events.
      let streamEnded = false;
      let finished = false;
      let resolveFinished!: () => void;
      const finishedPromise = new Promise<void>((r) => (resolveFinished = r));

      /** Detach from the process and let the driver push done. */
      function finishEpisode() {
        if (finished) return;
        finished = true;
        clearTimeout(inactivityTimer);
        live.detach();
        resolveFinished();
      }

      /** End the stream with an error event carrying what was streamed so far. */
      function endStreamWithError(errMsg: string) {
        if (streamEnded) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const reason = aborted ? "aborted" : "error";
        stream.push({
          type: "error",
          reason,
          error: {
            ...output,
            content: output.content?.length
              ? output.content
              : [{ type: "text" as const, text: `Error: ${errMsg}` }],
            stopReason: reason,
            errorMessage: errMsg,
          },
        } as any);
        stream.end();
        // An episode that failed cannot vouch for the process it was
        // attached to; end it rather than park it for the next call.
        void live.retire();
        finishEpisode();
      }

      /** The process is not coming back: retire it and drop its config. */
      async function discardProcess() {
        await live.retire();
        removeSessionMcpConfig(live.cliSessionId);
      }

      /** Keep the process for the session's next call, or end it. */
      function releaseProcess(reason: "turn-end" | "handoff") {
        if (!live.alive || live.retired) return;
        if (!piSessionId) {
          void live.retire();
          return;
        }
        if (reason === "handoff") {
          parkCliProcess(piSessionId, live, HANDOFF_WAIT_MS);
          return;
        }
        const idle = keepaliveMs();
        if (idle > 0) parkCliProcess(piSessionId, live, idle);
        else void live.retire();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Abort ends the stream now and retires the process. pi's history is
      // authoritative, so nothing in the CLI needs preserving: the next call
      // imports that history into a fresh process.
      if (options?.signal) {
        abortHandler = () => {
          aborted = true;
          endStreamWithError("Request aborted");
        };

        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      /** Bill this episode from a `result`, net of what the turn already reported. */
      function applyResultUsage(r: any) {
        const processTotals = sumModelUsage(r.modelUsage);
        let turnDelta: Usage4;
        if (processTotals) {
          turnDelta = subUsage(processTotals, live.lastProcessTotals);
          live.lastProcessTotals = processTotals;
        } else {
          // `usage` is per turn already.
          turnDelta = usage4(r.usage);
        }
        episodeResultTotals = addUsage(episodeResultTotals, turnDelta);
        const own = bridgeUsage4(bridge.getOutput());
        const billed = maxUsage(
          subUsage(episodeResultTotals, turnReportedBefore),
          own,
        );
        bridge.applyResult({
          ...r,
          modelUsage: undefined,
          usage: billed,
        });
      }

      const sink: EpisodeSink = {
        onError(err) {
          if (finished) return;
          const stderr = live.getStderr();
          endStreamWithError(stderr || err.message);
        },
        onClose(code) {
          if (finished) return;
          // The process ended while an episode was attached and before a
          // `result`: whatever streamed is incomplete.
          const stderr = live.getStderr();
          endStreamWithError(
            stderr
              ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
              : `Claude CLI exited unexpectedly with code ${code}`,
          );
        },
        onMessage(msg) {
          if (finished) return;
          // Reset inactivity timer on each line of output
          resetInactivityTimer();

          if (msg.type === "stream_event") {
            if (!selfInterrupted) bridge.handleEvent(msg.event);

            if (
              msg.event.type === "content_block_start" &&
              msg.event.content_block?.type === "tool_use"
            ) {
              const toolName = msg.event.content_block.name;
              if (toolName && isHandoffClaudeTool(toolName)) {
                sawToolCall = true;
                const id = msg.event.content_block.id;
                // The broker sees the MCP-side (unprefixed) name, so record
                // the same form the schema server will send back.
                if (id)
                  live.noteHandoffToolUse(id, mapClaudeToolNameToPi(toolName));
              }
            }

            if (
              msg.event.type === "message_stop" &&
              sawToolCall &&
              !selfInterrupted
            ) {
              if (live.allowHandoff) {
                // Proxied handoff: pi executes the tool while the CLI blocks
                // on `tools/call`. Hand the turn to pi now; the next call
                // answers the CLI on this same process. Nothing is written
                // to the CLI, so its cached prefix stays intact.
                live.turnReported = addUsage(
                  turnReportedBefore,
                  bridgeUsage4(bridge.getOutput()),
                );
                releaseProcess("handoff");
                finishEpisode();
                return;
              }
              // No proxy: ask the CLI to end the turn and wait for the result
              // envelope. pi runs the tool; the next call imports pi's
              // history, tool result included, into a fresh process.
              selfInterrupted = true;
              sendInterrupt(proc);
              return;
            }
          } else if (msg.type === "result") {
            const r: any = msg as any;
            const isError =
              r.subtype !== "success" ||
              r.is_error === true ||
              typeof r.error === "string" ||
              (Array.isArray(r.errors) && r.errors.length > 0);
            if (isError && !selfInterrupted && !aborted) {
              const errMsg =
                r.error ??
                (typeof r.result === "string" && r.is_error
                  ? r.result
                  : undefined) ??
                (Array.isArray(r.errors) && r.errors.length > 0
                  ? r.errors.join("; ")
                  : `Claude CLI returned ${r.subtype ?? "non-success result"}`);
              void discardProcess();
              endStreamWithError(errMsg);
              return;
            }
            // Authoritative episode usage. After a self-interrupt the result
            // is `error_during_execution` BY DESIGN — the turn content (the
            // toolCall) is already accumulated; usage still applies.
            applyResultUsage(r);

            // The turn is over. The process stays for the session's next
            // call unless the turn was interrupted: its conversation then
            // ends on a rejected tool that only pi's history can continue.
            live.turnReported = ZERO_USAGE;
            if (selfInterrupted) {
              void live.retire();
            } else {
              releaseProcess("turn-end");
            }
            finishEpisode();
          }
          // control_request is answered by CliProcess (attached or not).
          // Every other envelope (rate_limit_event, system, assistant, user)
          // carries nothing pi's stream needs.
        },
      };

      // Attach: buffered lines (a handoff gap) replay first, then live ones.
      live.attach(sink);
      resetInactivityTimer();

      // Continue the parked process
      if (mode === "handoff") {
        for (const m of delta) {
          if (m?.role !== "toolResult") continue;
          live.deliverHandoffResult(
            String(m.toolCallId ?? ""),
            toHandoffResult(m),
          );
        }
      } else if (mode === "turn") {
        live.writeUser(replayPiMessages(delta));
      }

      await finishedPromise;

      // Push done after the episode ends (async): pushing it synchronously
      // inside the message_stop handler prevents pi from executing tools.
      if (!streamEnded) {
        const output = bridge.getOutput();

        // stopReason toolUse with no toolCall block would send pi looking for
        // a tool that is not there.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        // What the process has now acknowledged of pi's history; the next
        // call may reuse it only if its history extends exactly this.
        const acknowledged = [...messages, output];
        live.piHistory = {
          length: acknowledged.length,
          hash: historyHash(acknowledged),
        };
        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
    } finally {
      // Clean up this call's abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // The CLI read the staged prompt file at spawn; a parked process no
      // longer needs it.
      if (promptFileKey) cleanupSystemPromptFile(promptFileKey);
    }
  }

  runEpisode().catch((err: any) => {
    failRequest(err?.message ?? "Unexpected error in streamViaCli");
  });

  return stream;
}
