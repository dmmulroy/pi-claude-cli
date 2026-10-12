/**
 * Provider orchestration — observer mode (docs/SPEC-observer-mode.md).
 *
 * The Claude CLI owns its loop, its tools, and its session. streamViaCli:
 * 1. Resolves the pi session's CLI session (session-map) — resume, or
 *    create/import a fresh one from pi's full history
 * 2. Reuses the session's live CLI process when one is parked (0.7.0), or
 *    spawns `claude -p` and writes the turn's prompt to stdin as NDJSON
 * 3. Streams events to pi: prose/thinking verbatim; the CLI's own tool
 *    executions as `[Claude Code · Name]` markers; HANDOFF tools (custom pi
 *    tools) as real pi toolCall blocks
 * 4. On a handoff tool at message_stop: ends pi's stream with
 *    stopReason=toolUse so pi executes the tool, while the CLI blocks on the
 *    proxied `tools/call`; the next pi call answers it on the SAME process
 *    (src/handoff-broker.ts, src/cli-process.ts). Without the proxy (no pi
 *    session id, or PI_CLAUDE_CLI_HANDOFF_PROXY=0) it falls back to a clean
 *    `interrupt` — never a kill, which corrupts the CLI transcript
 * 5. After `result`: parks the process for the next turn (idle timer) instead
 *    of killing it, so the CLI's system prompt — and its git snapshot — is
 *    built once per session, not once per call
 * 6. Hardened lifecycle: inactivity timeout, exit handler, streamEnded
 *    guard, abort = interrupt + delayed SIGKILL backstop, process registry
 */

import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
} from "./prompt-builder.js";
import { resolveSystemPromptMode } from "./system-prompt-mode.js";
import {
  usesPiContext,
  assertContextPolicy,
  ContextPolicyError,
} from "./context-policy.js";
import {
  spawnClaude,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  sendInterrupt,
} from "./process-manager.js";
import { createEventBridge } from "./event-bridge.js";
import { isTaskSubtype } from "./task-tracker.js";
import type {
  ClaudeModelUsage,
  ClaudeUsage,
  TaskTrackerState,
} from "./types.js";
import { resolveCliThinking } from "./thinking-config.js";
import { isHandoffClaudeTool, mapClaudeToolNameToPi } from "./tool-mapping.js";
import { resolveAutocompact } from "./autocompact.js";
import {
  getCliSession,
  setCliSession,
  clearCliSession,
  getSystemPrompt,
  setSystemPrompt,
  clearSystemPrompt,
} from "./session-map.js";
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
  historyHash,
  replayPiMessages,
} from "./pi-context.js";

/**
 * Inactivity timeout. CLI-side tool executions (web search, user MCP
 * servers, sub-agents) can be silent on stdout for minutes, so the default
 * is generous and overridable via PI_CLAUDE_CLI_TIMEOUT_MS.
 */
const INACTIVITY_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS)
    : 300_000;

/**
 * BACKGROUND SUB-AGENTS REPORT BACK, AND THIS IS WHY THEY DIDN'T.
 *
 * The CLI answers a background `Agent` call in milliseconds with "Async agent
 * launched successfully… you will be notified when it completes", and the
 * model — correctly, per its own tool contract — ends its turn to wait. The
 * CLI then emits `result` for that turn WHILE the agents keep running.
 * Killing on that first result is what made every fan-out a dead end: the
 * agents died mid-tool-call, their reports were never written, and the turn
 * closed on "Now waiting on the three investigation agents".
 *
 * The loop the host was assumed to owe the CLI turned out to be the CLI's
 * own. Captured 2026-08-28 on claude 2.1.231, holding the process open past
 * `result`: the sub-agent finished at +25s, `task_notification` carried its
 * report, the CLI re-invoked the model unprompted, and it answered with the
 * findings and emitted a SECOND `result`. Nothing was written to stdin to
 * make that happen.
 *
 * So the fix is to stop killing: while `pendingAgents()` is non-zero, a
 * `result` is a cycle boundary, not the end of the episode. Two bounds keep a
 * runaway fan-out from holding a turn open forever — the inactivity timer
 * (which `task_progress` keeps resetting for as long as agents do real work)
 * and the wall clock below.
 */
const WAIT_FOR_AGENTS = process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT !== "1";

/** Hard ceiling on holding a turn open for sub-agents. */
const AGENT_WAIT_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS)
    : 900_000;

/**
 * Backstop on continuation cycles. Each completing agent costs one, and an
 * agent may launch more; this only exists so a pathological loop cannot spin
 * without end.
 */
const MAX_AGENT_CONTINUATIONS = 32;

/**
 * THE CLI CAN ANSWER A PROMPT THAT IS NOT OURS, AND THAT USED TO EAT A TURN.
 *
 * On `--resume` the CLI drains its own queue first. A session whose previous
 * turn launched a background task gets a `<task-notification>` enqueued ahead
 * of our prompt ("background shell command task(s) from the previous session
 * have no completion record") — orphaned because the pre-0.7.0 provider
 * exited the CLI at the end of every turn. The CLI dequeues the notification,
 * decides it needs no reply, and emits `result` in under a second, having
 * never called the model. Our prompt is still queued behind it.
 *
 * Ending the episode on that `result` is what made the user's first message
 * (and often the second) do nothing: pi got an assistant message with empty
 * content and zero tokens, and the CLI transcript was left ending on an
 * unanswered user entry — so the NEXT `--resume` spliced "Continue from where
 * you left off." / "No response requested." filler in to repair it. That
 * filler changes the cached prefix, so the whole conversation re-billed as
 * cache WRITE. Captured 2026-09-01 on claude 2.1.258: 329,944 cache-creation
 * tokens and zero cache read on the repairing resume, against ~400 write /
 * ~315k read on every healthy cycle of the same session.
 *
 * So a `result` that carried no content AND spent no tokens is a cycle
 * boundary, not the end of the episode (agustinsacco/pi-claude-cli#33,
 * folded in here). A persistent process makes the orphaning rare — the
 * process that launched the task usually still runs — but a retire-and-resume
 * can still hit it. Bounded below, and by the inactivity timer, which still
 * fires if the CLI has genuinely gone quiet.
 */
const MAX_EMPTY_CONTINUATIONS = 4;

/**
 * How long a parked CLI process waits for the next turn before it is retired
 * (PI_CLAUDE_CLI_KEEPALIVE_MS; `0`/`off` parks nothing — the process ends at
 * `result` as before 0.7.0, and only handoffs keep it alive). The default is
 * ten minutes: long enough to span a user reading an answer, short enough
 * that an abandoned session does not hold ~200 MB for an afternoon. The next
 * turn after a retire resumes the CLI session on disk as before.
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

/** Kill switch for the proxied handoff (falls back to interrupt-and-resume). */
function handoffProxyAllowed(): boolean {
  return process.env.PI_CLAUDE_CLI_HANDOFF_PROXY !== "0";
}

/** Extended stream options: pi's SimpleStreamOptions plus host plumbing. */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  /** Pre-built `--mcp-config` file used verbatim (tests, legacy hosts). */
  mcpConfigPath?: string;
  /**
   * The staged custom-tool schema and the handoff socket. The provider writes
   * one config file per CLI session from these so the schema server can route
   * proxied tool calls back to that session.
   */
  mcpConfig?: {
    schemaPath: string;
    /** Bumped whenever the schema file is rewritten. */
    version: number;
    /** Handoff socket path, or a promise of one (the broker starts lazily). */
    handoffSocket?: string | Promise<string | undefined>;
  };
  /**
   * Called with live sub-agent state as the CLI reports it. Ephemeral: this is
   * progress, not transcript, and must never be folded into turn content. The
   * durable half (start/finish) rides in the turn as markers instead.
   */
  onTaskProgress?: (state: TaskTrackerState) => void;
};

/**
 * The mapped CLI session is stale when pi's history moved on without it:
 * an assistant turn from another provider (model switch) after — or with no —
 * pi-claude-cli turn means the CLI never saw that exchange. Resuming would
 * answer from a conversation missing turns, so reimport instead.
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
 * Orchestrates the full subprocess lifecycle: resolve/resume the CLI session,
 * reuse or spawn the process, write the prompt or answer the pending handoff,
 * parse NDJSON, bridge events, handle result, park or clean up.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and MCP plumbing
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const piOwned = usesPiContext();
  // pi 0.86+ sends its prompt and tools as system messages and leaves
  // systemPrompt empty. Both policies read the current ones from there.
  context = normalizePiContext(context);
  function failPiRequest(error: string, reason: "error" | "aborted" = "error") {
    const message = createEventBridge(stream, model).getOutput();
    stream.push({
      type: "error",
      reason,
      error: { ...message, stopReason: reason, errorMessage: error },
    } as any);
    stream.end();
  }
  if (piOwned && options?.signal?.aborted) {
    failPiRequest("Request aborted", "aborted");
    return stream;
  }

  /**
   * One attempt. Returns "resume-miss" (without touching the stream) when the
   * sidecar pointed --resume at a CLI session that no longer exists on disk.
   * The driver below retries once with a fresh session imported from pi's
   * full history, re-recording the mapping.
   */
  async function runOnce(
    forceFullReplay: boolean,
  ): Promise<"ok" | "resume-miss"> {
    let cli: CliProcess | undefined;
    let abortHandler: (() => void) | undefined;
    let resumeMiss = false;
    // Track HANDOFF tool_use blocks (custom pi tools) for the decision at
    // message_stop. Built-ins run natively and never end the episode.
    let sawHandoffTool = false;
    // Set once we have asked the CLI to end the turn (legacy handoff or
    // abort): stream content is frozen and only the result envelope is awaited.
    let selfInterrupted = false;
    // Set on pi-initiated abort so the turn ends quietly, not as an error.
    let aborted = false;
    // CLI session this attempt staged its system prompt under, so the finally
    // below can remove the right file. Only set when this attempt spawned.
    let promptFileKey: string | undefined;
    // The pi session, for parking.
    const piSessionId = options?.sessionId;

    try {
      const cwd = options?.cwd ?? process.cwd();
      if (piOwned && piSessionId) {
        const oldId = getCliSession(piSessionId);
        if (oldId) {
          clearCliSession(piSessionId);
          clearSystemPrompt(oldId);
        }
      }
      const messages = context.messages as any[];
      const stale = cliSessionIsStale(messages);
      const delta = deltaMessages(messages);
      const thinking = resolveCliThinking(
        model,
        options?.reasoning,
        options?.thinkingBudgets,
      );
      const systemPromptMode = piOwned ? "pi" : resolveSystemPromptMode();
      const piContext = usesPiContext();
      // Never attach a new context policy to a transcript that still carries
      // the other loader's instructions. Leave that session available under
      // its original policy; the host/user must start a fresh pi session.
      const mappedContextId =
        !piOwned && piSessionId ? getCliSession(piSessionId) : undefined;
      if (mappedContextId && !stale && !forceFullReplay) {
        assertContextPolicy(getSystemPrompt(mappedContextId), piContext);
      }
      const autocompact = resolveAutocompact();
      const handoffSocketPath = options?.mcpConfig?.handoffSocket
        ? await options.mcpConfig.handoffSocket
        : undefined;
      // The proxy needs a pi session to route the continuation back to.
      const allowHandoff =
        handoffProxyAllowed() && !!piSessionId && !!handoffSocketPath;
      // Thinking is deliberately absent: a live process takes a new level
      // through control requests (step 1), so changing it mid-session no
      // longer costs a respawn and a full-history replay.
      const signature = JSON.stringify([
        model.id,
        systemPromptMode,
        piContext,
        piOwned ? context.systemPrompt : null,
        cwd,
        options?.mcpConfigPath ?? null,
        options?.mcpConfig?.schemaPath ?? null,
        options?.mcpConfig?.version ?? null,
        handoffSocketPath ?? null,
        autocompact ?? null,
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
          !piOwned ||
          (!!checkpoint &&
            messages.length >= checkpoint.length &&
            historyHash(messages.slice(0, checkpoint.length)) ===
              checkpoint.hash);
        if (
          !forceFullReplay &&
          !stale &&
          historyMatches &&
          parkedCli.signature === signature
        ) {
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
          // Different spawn parameters, stale history, or a delta the live
          // process cannot take: end it cleanly and start over via --resume.
          await parkedCli.retire();
        } else {
          cli = parkedCli;
        }
      }

      // ---- 2. Or spawn
      let resumeSessionId: string | undefined;
      let newCliId: string | undefined;
      if (!cli) {
        // One CLI session per pi session, resumed across turns and restarts.
        // Resume only when a mapping exists AND the CLI session is not behind
        // pi's history (a foreign-provider turn after our last one means the
        // CLI never saw that exchange). Anything else — first turn, fork,
        // model switch, lost sidecar, resume miss — is one reimport.
        const mappedCliId =
          !piOwned && piSessionId ? getCliSession(piSessionId) : undefined;
        resumeSessionId =
          !forceFullReplay && mappedCliId && !stale ? mappedCliId : undefined;
        // Fresh sessions get a provider-minted id, never pi's: the CLI refuses
        // a --session-id it has already seen, and forks reuse pi ids.
        newCliId = resumeSessionId ? undefined : randomUUID();
        const cliSessionId = (resumeSessionId ?? newCliId)!;
        promptFileKey = cliSessionId;

        // Resume sends only the delta since the last assistant turn (new user
        // text, handoff tool results). Create/import sends the full history.
        const prompt = piOwned
          ? replayPiMessages(messages)
          : resumeSessionId
            ? buildResumePrompt(context)
            : buildPrompt(context);
        // The CLI does not keep --system-prompt across --resume, so it goes on
        // EVERY spawn. On resume, replay the stored bytes rather than rebuilding
        // them: an identical prompt keeps the cached prefix, a drifted one
        // re-bills the whole transcript as cache write. See src/session-map.ts.
        const storedSystemPrompt = resumeSessionId
          ? getSystemPrompt(resumeSessionId)
          : undefined;
        const systemPrompt =
          storedSystemPrompt ??
          buildSystemPrompt(context, cwd, systemPromptMode);

        // The MCP config names this CLI session so proxied tool calls route
        // back here. A verbatim mcpConfigPath (tests, legacy hosts) wins.
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

        const proc = spawnClaude(model.id, systemPrompt || undefined, {
          cwd,
          signal: options?.signal,
          thinking,
          mcpConfigPath,
          resumeSessionId,
          newSessionId: newCliId,
          systemPromptMode,
        });
        // Record the mapping as soon as the session exists on disk. On a turn
        // that later errors, the mapping is cleared so the next turn reimports.
        if (!piOwned && piSessionId && newCliId)
          setCliSession(piSessionId, newCliId);
        // Store the created prompt so every later turn re-passes these exact
        // bytes. Without it, resume falls back to a rebuild that can drift.
        if (!piOwned && newCliId && systemPrompt)
          setSystemPrompt(newCliId, systemPrompt);
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
        cli.writeUser(prompt);
      }

      const live = cli;
      const proc = live.proc;

      // ---- 3. The episode: one pi call's view of the process
      const bridge = createEventBridge(stream, model, {
        markedTools: live.markedTools,
      });
      const taskTracker = live.taskTracker;
      // Usage earlier episodes of this CLI turn already handed to pi. The
      // result's cumulative figures are reduced by this so the turn is billed
      // once across its episodes.
      const turnReportedBefore = live.turnReported;
      // Result deltas seen by THIS episode (a sub-agent wait yields several).
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
        clearTimeout(agentWaitTimer);
        live.detach();
        resolveFinished();
      }

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(errMsg: string) {
        if (streamEnded || resumeMiss) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        stream.push(
          piOwned
            ? ({
                type: "error",
                reason: aborted ? "aborted" : "error",
                error: {
                  ...errorMessage,
                  stopReason: aborted ? "aborted" : "error",
                  errorMessage: errMsg,
                },
              } as any)
            : ({
                type: "done",
                reason: "stop",
                message: errorMessage,
              } as any),
        );
        stream.end();
        // An episode that failed cannot vouch for the process it was
        // attached to; end it rather than park it for the next call.
        void live.retire();
        finishEpisode();
      }

      /** The process is not coming back: drop it from every registry. */
      async function discardProcess() {
        if (piSessionId) {
          // Nothing to do — the pool never held it while attached.
        }
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

      // Sub-agent wait state (see WAIT_FOR_AGENTS): how many `result`
      // envelopes have been treated as cycle boundaries, and the wall-clock
      // backstop that stops waiting no matter what the agents are doing.
      let agentContinuations = 0;
      // Results consumed by a prompt of the CLI's own. See
      // MAX_EMPTY_CONTINUATIONS.
      let emptyContinuations = 0;
      let agentWaitTimer: ReturnType<typeof setTimeout> | undefined;
      let agentWaitExpired = false;
      let waitingForAgents = false;

      /**
       * End the episode on what it already has, without pushing an error.
       *
       * Only correct once a `result` has been seen. Before that, silence means
       * a wedged CLI and the turn has nothing — which is what the inactivity
       * timeout's error is for.
       */
      function endTurnOnPartialWork() {
        agentWaitExpired = true;
        // Agents may still be running inside the process; a fresh process
        // for the next turn is the safe outcome.
        void discardProcess();
        finishEpisode();
      }

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          // Waiting on sub-agents is the one state where silence is not a
          // failed turn: the model already spoke and the result already
          // landed. An agent that dies without notifying must not convert
          // that into an error and throw the content away.
          if (waitingForAgents) {
            endTurnOnPartialWork();
            return;
          }
          forceKillProcess(proc);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Abort = the CLI's own interrupt (keeps the session resumable), with a
      // SIGKILL backstop in case the CLI is wedged and never emits a result.
      if (options?.signal) {
        abortHandler = () => {
          aborted = true;
          selfInterrupted = true;
          if (piOwned) {
            endStreamWithError("Request aborted");
            return;
          }
          sendInterrupt(proc);
          const backstop = setTimeout(() => forceKillProcess(proc), 2000);
          proc.once("close", () => clearTimeout(backstop));
        };

        if (options.signal.aborted) {
          abortHandler();
          return "ok";
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      /**
       * Nothing to hand pi: no content blocks and no tokens spent. Both halves
       * matter — a model that legitimately answers with silence still bills
       * for the call, so usage alone separates "said nothing" from "never
       * ran".
       */
      function episodeIsEmpty(): boolean {
        const output = bridge.getOutput();
        if (output.content.length > 0) return false;
        const u = output.usage;
        if (!u) return true;
        return (
          (u.input ?? 0) === 0 &&
          (u.output ?? 0) === 0 &&
          (u.cacheRead ?? 0) === 0 &&
          (u.cacheWrite ?? 0) === 0
        );
      }

      /** Bill this episode from a `result`, net of what the turn already reported. */
      function applyResultUsage(r: any) {
        const processTotals = sumModelUsage(r.modelUsage);
        let turnDelta: Usage4;
        if (processTotals) {
          turnDelta = subUsage(processTotals, live.lastProcessTotals);
          live.lastProcessTotals = processTotals;
        } else {
          // `usage` is per turn already (main agent only).
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
          if (resumeMiss || finished) return;
          const stderr = live.getStderr();
          endStreamWithError(stderr || err.message);
        },
        onClose(code) {
          if (resumeMiss || finished) return;
          if (piOwned || (code !== 0 && code !== null)) {
            const stderr = live.getStderr();
            const message = stderr
              ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
              : `Claude CLI exited unexpectedly with code ${code}`;
            endStreamWithError(message);
            return;
          }
          // stdout closed without a result: end on whatever was streamed.
          // The process is gone or going; it cannot serve another call.
          void live.retire();
          finishEpisode();
        },
        onMessage(msg) {
          if (resumeMiss || finished) return;
          // Reset inactivity timer on each line of output
          resetInactivityTimer();

          if (msg.type === "stream_event") {
            // Only forward top-level events to pi's event bridge.
            // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
            const isTopLevel = !(msg as any).parent_tool_use_id;
            if (isTopLevel && !selfInterrupted) {
              bridge.handleEvent(msg.event);
            }

            // Track handoff tool_use blocks (top-level only). Built-ins and
            // CLI-internal tools execute natively and must not end the episode.
            if (
              isTopLevel &&
              msg.event.type === "content_block_start" &&
              msg.event.content_block?.type === "tool_use"
            ) {
              const toolName = msg.event.content_block.name;
              if (toolName && isHandoffClaudeTool(toolName)) {
                sawHandoffTool = true;
                const id = msg.event.content_block.id;
                // The broker sees the MCP-side (unprefixed) name, so record
                // the same form the schema server will send back.
                if (id)
                  live.noteHandoffToolUse(id, mapClaudeToolNameToPi(toolName));
              }
            }

            if (
              isTopLevel &&
              msg.event.type === "message_stop" &&
              sawHandoffTool &&
              !selfInterrupted
            ) {
              if (live.allowHandoff) {
                // Proxied handoff: pi executes the tool while the CLI blocks
                // on `tools/call`. Hand the turn to pi now; the next call
                // answers the CLI on this same process. Nothing is written
                // to the CLI, so its transcript and cached prefix stay intact.
                live.turnReported = addUsage(
                  turnReportedBefore,
                  bridgeUsage4(bridge.getOutput()),
                );
                releaseProcess("handoff");
                finishEpisode();
                return;
              }
              // Legacy handoff: ask the CLI to end the turn CLEANLY so the
              // session file stays truthful and resumable, then wait for the
              // result envelope. Never SIGKILL here — a kill truncates the
              // transcript before the assistant turn is written, and every
              // later --resume then splices in synthetic "No response
              // requested." filler that the model eventually imitates.
              selfInterrupted = true;
              sendInterrupt(proc);
              return;
            }
          } else if (
            msg.type === "system" &&
            (msg as any).subtype === "compact_boundary"
          ) {
            // The CLI compacted its own session and will carry on by itself.
            // The host needs two things from it: the context is now the
            // compacted size (the bridge resets its latch — otherwise pi is
            // told the pre-compaction figure and compacts its own record on
            // it), and the transcript should show where the cut happened.
            if (!selfInterrupted) bridge.handleCompactBoundary(msg as any);
          } else if (
            msg.type === "system" &&
            isTaskSubtype((msg as any).subtype)
          ) {
            // Sub-agent lifecycle. The agents' own envelopes carry
            // parent_tool_use_id and stay internal to the CLI, but these arrive
            // at top level even for deeply nested agents — the one channel that
            // makes a fan-out visible at all (#23).
            if (!selfInterrupted) {
              const marker = taskTracker.apply(msg as any);
              if (marker) bridge.appendMarker(marker);
              try {
                options?.onTaskProgress?.(taskTracker.snapshot());
              } catch {
                /* a status push must never break a turn */
              }
            }
          } else if (msg.type === "assistant") {
            // Complete-block envelopes: marker text for the CLI's own tool
            // executions (built-ins, WebSearch, user MCP, …), which in observer
            // mode is every tool except handoffs.
            if (!selfInterrupted) bridge.handleAssistantEnvelope(msg as any);
          } else if (msg.type === "user") {
            // Tool results the CLI feeds back between cycles. Internal by
            // default; with PI_CLAUDE_CLI_TOOL_RESULTS=1 the bridge forwards
            // each one as a `result` marker paired to its call marker. Frozen
            // after an interrupt like every other content path.
            if (!selfInterrupted) bridge.handleUserEnvelope(msg as any);
          } else if (msg.type === "control_request") {
            // Answered by CliProcess (it must be, attached or not).
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
              if (
                resumeSessionId &&
                /No conversation found with session ID/i.test(errMsg)
              ) {
                // Recoverable: the sidecar pointed at a CLI session that no
                // longer exists. Clear it; the driver reimports once.
                if (piSessionId) clearCliSession(piSessionId);
                clearSystemPrompt(resumeSessionId);
                resumeMiss = true;
                void discardProcess();
                finishEpisode();
                return;
              }
              // A failed turn may leave the CLI session ending on a user
              // entry; resuming that would splice filler. Reimport next turn.
              if (piSessionId) clearCliSession(piSessionId);
              // This CLI session will never be resumed, so its stored prompt
              // is dead weight.
              clearSystemPrompt(live.cliSessionId);
              void discardProcess();
              endStreamWithError(errMsg);
              return;
            }
            // Authoritative episode usage. After a self-interrupt the result
            // is `error_during_execution` BY DESIGN — the turn content (the
            // handoff toolCall) is already accumulated; usage still applies.
            applyResultUsage(r);

            // The CLI answered a queued prompt of its own (see
            // MAX_EMPTY_CONTINUATIONS): nothing was said and nothing was
            // spent, and our prompt is still waiting. Keep reading; the turn
            // is still live for the process.
            if (
              !isError &&
              !selfInterrupted &&
              !aborted &&
              emptyContinuations < MAX_EMPTY_CONTINUATIONS &&
              episodeIsEmpty()
            ) {
              emptyContinuations++;
              live.resumeTurn();
              resetInactivityTimer();
              return;
            }

            // Sub-agents still working: this result ends a CYCLE, not the
            // episode. Leave the CLI alive and keep reading — it re-invokes the
            // model itself once they report, and emits another result. See
            // WAIT_FOR_AGENTS for the capture this is built on.
            if (
              WAIT_FOR_AGENTS &&
              !isError &&
              !selfInterrupted &&
              !aborted &&
              !agentWaitExpired &&
              agentContinuations < MAX_AGENT_CONTINUATIONS &&
              taskTracker.pendingAgents() > 0
            ) {
              agentContinuations++;
              waitingForAgents = true;
              live.resumeTurn();
              if (agentWaitTimer === undefined) {
                agentWaitTimer = setTimeout(() => {
                  // Give up waiting, but let the turn end on its own content:
                  // the launch markers and whatever the model already said are
                  // real, and an error here would throw them away.
                  endTurnOnPartialWork();
                }, AGENT_WAIT_TIMEOUT_MS);
                // A pending wait must never hold the host process open.
                agentWaitTimer.unref?.();
              }
              resetInactivityTimer();
              return;
            }

            // The turn is over. The process stays for the session's next
            // call unless the turn was interrupted for a legacy handoff (the
            // CLI transcript then ends on a rejected tool; only --resume with
            // the result pasted in can continue it).
            live.turnReported = ZERO_USAGE;
            if (selfInterrupted && !aborted) {
              void live.retire();
            } else {
              releaseProcess("turn-end");
            }
            finishEpisode();
          }
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
        live.writeUser(
          piOwned ? replayPiMessages(delta) : buildResumePrompt(context),
        );
      }

      await finishedPromise;

      if (resumeMiss) return "resume-miss";

      // Push done after the episode ends (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        const output = bridge.getOutput();

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        if (piOwned) {
          const acknowledged = [...messages, output];
          live.piHistory = {
            length: acknowledged.length,
            hash: historyHash(acknowledged),
          };
        }
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
      return "ok";
    } finally {
      // Clean up this attempt's abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // Staged prompt file is per CLI session, so it is removed here where
      // the ids are in scope — a resume-miss retry stages a second one. The
      // CLI read it at spawn; a parked process no longer needs it.
      if (promptFileKey) cleanupSystemPromptFile(promptFileKey);
    }
  }

  (async () => {
    try {
      const outcome = await runOnce(false);
      if (outcome === "resume-miss") {
        console.error(
          "[pi-claude-cli] CLI session missing for --resume — importing pi history into a fresh CLI session",
        );
        await runOnce(true);
      }
    } catch (err: any) {
      if (piOwned) {
        failPiRequest(err.message ?? "Unexpected error in streamViaCli");
        return;
      }
      if (err instanceof ContextPolicyError) {
        // pi's stream result must be an AssistantMessage, not a raw error
        // string (agent-loop inspects .content even when a call failed).
        const message = createEventBridge(stream, model).getOutput();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...message,
            content: [{ type: "text", text: err.message }],
            stopReason: "error",
            errorMessage: err.message,
          },
        } as any);
        stream.end();
        return;
      }
      stream.push({
        type: "error",
        reason: "error",
        error: err.message ?? "Unexpected error in streamViaCli",
      } as any);
      stream.end();
    } finally {
      // The sub-agent channel is state ABOUT a turn, so it must not outlive
      // one. Left standing, the last snapshot pins whatever the agents were
      // doing when the episode ended — a host then shows "running" for
      // agents that finished, or for agents that died, until the next turn
      // happens to publish something else.
      try {
        options?.onTaskProgress?.({ tasks: [], active: 0, completed: 0 });
      } catch {
        /* a status push must never break a turn */
      }
    }
  })();

  return stream;
}
