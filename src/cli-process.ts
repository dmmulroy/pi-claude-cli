/**
 * One Claude CLI process that outlives a single pi call.
 *
 * Spawning is expensive: a fresh process must be handed pi's whole history
 * again, and that import misses the prompt cache. A CliProcess therefore
 * stays alive:
 * - through a tool call: pi's stream ends at message_stop so pi can run the
 *   tool, the CLI blocks on the proxied `tools/call`, and the next pi call
 *   attaches to the same process and answers it;
 * - between turns: after `result` the process is parked (idle timer) and the
 *   next user message is written to the same stdin.
 *
 * Exactly one "episode" (one pi call) is attached at a time. Lines that arrive
 * while nothing is attached are buffered and replayed to the next episode, so
 * the episode code sees the stream as if it were live. Permission requests
 * are answered here, attached or not — the CLI must never wait on one.
 */

import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { parseLine } from "./stream-parser.js";
import { removeSessionMcpConfig } from "./mcp-config.js";
import { handleControlRequest } from "./control-handler.js";
import {
  writeUserMessage,
  sendInterrupt,
  forceKillProcess,
} from "./process-manager.js";
import {
  registerHandoffTarget,
  unregisterHandoffTarget,
  errorResult,
  type HandoffCall,
  type HandoffResult,
  type HandoffTarget,
} from "./handoff-broker.js";
import type { NdjsonMessage } from "./types.js";
import {
  thinkingControls,
  type CliThinking,
  type ThinkingControl,
} from "./thinking-config.js";

/** Refusal for a `tools/call` that names no live tool_use block of ours. */
export const UNMATCHED_CALL_MESSAGE =
  "pi could not match this tool call to an assistant tool_use block";

/** Four token counters, the shape both `usage` and `modelUsage` reduce to. */
export interface Usage4 {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const ZERO_USAGE: Usage4 = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function addUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** a − b, floored at zero per component. */
export function subUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    cache_read_input_tokens: Math.max(
      0,
      a.cache_read_input_tokens - b.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: Math.max(
      0,
      a.cache_creation_input_tokens - b.cache_creation_input_tokens,
    ),
  };
}

export function maxUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: Math.max(
      a.cache_read_input_tokens,
      b.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: Math.max(
      a.cache_creation_input_tokens,
      b.cache_creation_input_tokens,
    ),
  };
}

/** What an attached episode receives. */
export interface EpisodeSink {
  onMessage(msg: NdjsonMessage): void;
  /** stdout closed or the process exited while attached. */
  onClose(code: number | null): void;
  onError(err: Error): void;
}

/** Cap on lines held for a detached process before the oldest are dropped. */
const DETACHED_BUFFER_LIMIT = 20_000;

/** Grace after ending stdin before a still-running CLI is SIGKILLed. */
const EXIT_GRACE_MS = 500;
/** Grace after an interrupt for the CLI to end the turn and emit result. */
const INTERRUPT_GRACE_MS = 2_000;
/**
 * How long a thinking change may take to be acknowledged. The CLI answers in
 * milliseconds; past this the process is treated as unable to take it and the
 * provider spawns a fresh one with the right flags instead.
 */
export const THINKING_CONTROL_TIMEOUT_MS = 5_000;

let controlSeq = 0;

export class CliProcess implements HandoffTarget {
  readonly proc: ChildProcess;
  readonly cliSessionId: string;
  /** Spawn parameters; a later call may only reuse the process if they match. */
  readonly signature: string;
  /** True when proxied handoffs are on for this process. */
  readonly allowHandoff: boolean;
  readonly getStderr: () => string;
  /** Pi history acknowledged by this disposable process, never a second ledger. */
  piHistory?: { length: number; hash: string };
  /**
   * The thinking the CLI will use for its next user turn: the spawn flags,
   * then every change `applyThinking` got acknowledged.
   */
  thinking: CliThinking;

  /** A user message has been written and no `result` has followed yet. */
  turnActive = false;
  alive = true;
  exitCode: number | null | undefined;
  /** Retired by the pool or the provider; no episode may attach again. */
  retired = false;

  /**
   * `result.modelUsage` is cumulative for the PROCESS (verified 2026-09-02,
   * claude 2.1.258: turn 2 reported turn 1 + turn 2). Per-turn spend is the
   * delta against the previous result.
   */
  lastProcessTotals: Usage4 = ZERO_USAGE;
  /** Usage already handed to pi by earlier episodes of the current turn. */
  turnReported: Usage4 = ZERO_USAGE;

  private sink: EpisodeSink | undefined;
  private buffer: NdjsonMessage[] = [];
  /** Handoff tool_use ids seen in the current assistant message. */
  private awaiting = new Set<string>();
  /** pi tool name the model asked for, by tool_use id. */
  private awaitedNames = new Map<string, string>();
  /** `tools/call` arrived, pi has not answered yet. */
  private pending = new Map<string, HandoffCall>();
  /** pi answered, `tools/call` has not arrived yet. */
  private ready = new Map<string, HandoffResult>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closeWaiters: Array<() => void> = [];
  private onExitHandlers: Array<(code: number | null) => void> = [];
  /** Our own control requests awaiting the CLI's answer, by request id. */
  private controlWaiters = new Map<string, (ok: boolean) => void>();

  constructor(
    proc: ChildProcess,
    options: {
      cliSessionId: string;
      signature: string;
      allowHandoff: boolean;
      getStderr: () => string;
      thinking?: CliThinking;
    },
  ) {
    this.proc = proc;
    this.cliSessionId = options.cliSessionId;
    this.signature = options.signature;
    this.allowHandoff = options.allowHandoff;
    this.getStderr = options.getStderr;
    this.thinking = options.thinking ?? { kind: "default" };

    if (this.allowHandoff) registerHandoffTarget(this.cliSessionId, this);

    const rl = createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
      terminal: false,
    });
    // 'line' rather than `for await`: the async iterator batches lines and
    // breaks real-time streaming to pi.
    rl.on("line", (line: string) => this.handleLine(line));
    // stdout EOF ends the episode's view; only the process's own close ends
    // the process (a host may see EOF first, or — with mocks — only EOF).
    rl.on("close", () => this.handleStdoutClose());
    proc.on("error", (err: Error) => {
      this.sink?.onError(err);
    });
    proc.on("close", (code: number | null) => {
      this.exitCode = code;
      this.handleProcClose(code);
    });
  }

  // ---- episode attachment -------------------------------------------------

  attach(sink: EpisodeSink): void {
    if (this.retired) throw new Error("CliProcess is retired");
    this.clearIdleTimer();
    this.sink = sink;
    const queued = this.buffer;
    this.buffer = [];
    for (const msg of queued) sink.onMessage(msg);
    if (!this.alive || this.stdoutClosed) sink.onClose(this.exitCode ?? null);
  }

  detach(): void {
    this.sink = undefined;
  }

  get attached(): boolean {
    return this.sink !== undefined;
  }

  /** Retire this process when nobody comes back for `ms`. */
  startIdleTimer(ms: number, onExpire: () => void): void {
    this.clearIdleTimer();
    if (!(ms > 0)) return;
    this.idleTimer = setTimeout(onExpire, ms);
    this.idleTimer.unref?.();
  }

  clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  onExit(handler: (code: number | null) => void): void {
    this.onExitHandlers.push(handler);
  }

  // ---- turn I/O -----------------------------------------------------------

  writeUser(prompt: string | any[]): void {
    this.turnActive = true;
    writeUserMessage(this.proc, prompt);
  }

  /**
   * Move the process to `desired` thinking before its next user turn.
   *
   * Resolves true once every control request is acknowledged. False means
   * the process cannot take the change in place (a live turn, a dead or
   * retired process, a CLI refusal, no answer within
   * THINKING_CONTROL_TIMEOUT_MS, or a target only a spawn can reach). The
   * caller then retires it and spawns with the right flags, so the next turn
   * is correct either way; only the warm process is lost.
   *
   * Only called between turns: the CLI reads thinking once per user turn, so
   * a change sent mid-turn would not reach the rest of that turn anyway
   * (verified on 2.1.283 with a change sent during a tool call).
   */
  async applyThinking(desired: CliThinking): Promise<boolean> {
    const controls = thinkingControls(this.thinking, desired);
    if (controls === undefined) return false;
    for (const control of controls) {
      if (!(await this.sendControl(control))) return false;
    }
    this.thinking = desired;
    return true;
  }

  private sendControl(request: ThinkingControl): Promise<boolean> {
    const stdin = this.proc.stdin;
    if (
      !this.alive ||
      this.retired ||
      this.turnActive ||
      this.stdoutClosed ||
      !stdin
    )
      return Promise.resolve(false);
    const requestId = `pcc-${(++controlSeq).toString(36)}-${Date.now().toString(36)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => settle(false),
        THINKING_CONTROL_TIMEOUT_MS,
      );
      timer.unref?.();
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        this.controlWaiters.delete(requestId);
        resolve(ok);
      };
      this.controlWaiters.set(requestId, settle);
      try {
        stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request,
          }) + "\n",
        );
      } catch {
        settle(false);
      }
    });
  }

  /** Answer every outstanding control request with a failure. */
  private failControlWaiters(): void {
    for (const settle of [...this.controlWaiters.values()]) settle(false);
  }

  // ---- handoff bookkeeping ------------------------------------------------

  /**
   * A handoff tool_use block streamed in the current assistant message.
   *
   * `piToolName` is what the model actually asked for. Recording it lets
   * `onHandoffCall` refuse a call that names a different tool than the block
   * it claims to answer — a peer on the broker socket cannot borrow a live
   * tool_use id to get some other tool executed.
   */
  noteHandoffToolUse(toolUseId: string, piToolName?: string): void {
    this.awaiting.add(toolUseId);
    if (piToolName) this.awaitedNames.set(toolUseId, piToolName);
  }

  /** Can pi's toolResults for these ids continue the running turn? */
  canContinueHandoff(toolUseIds: string[]): boolean {
    if (!this.alive || this.retired || !this.turnActive) return false;
    if (toolUseIds.length === 0) return false;
    return toolUseIds.every(
      (id) => this.awaiting.has(id) || this.pending.has(id),
    );
  }

  /** Deliver pi's result. Answers the CLI now or when its call arrives. */
  deliverHandoffResult(toolUseId: string, result: HandoffResult): void {
    const call = this.pending.get(toolUseId);
    if (call) {
      this.pending.delete(toolUseId);
      call.respond(result);
      return;
    }
    this.awaiting.delete(toolUseId);
    this.ready.set(toolUseId, result);
  }

  /** HandoffTarget: the schema server forwarded a `tools/call`. */
  onHandoffCall(call: HandoffCall): void {
    const id = call.toolUseId;
    if (!id) {
      // No id tag (older CLI). Fall back to the single awaited handoff if the
      // shape is unambiguous, otherwise refuse rather than guess.
      const ids = [...this.awaiting, ...this.ready.keys()];
      if (ids.length !== 1) {
        call.respond(errorResult(UNMATCHED_CALL_MESSAGE));
        return;
      }
      this.routeCall(ids[0], call);
      return;
    }
    // An id must name a tool_use block this process actually streamed and has
    // not answered yet. Anything else — an id from a sub-agent's nested block,
    // a replayed id, a value invented by whoever reached the socket — is
    // refused. It used to land in `pending`, where nothing would ever deliver
    // a result for it and the caller blocked until the MCP timeout (an hour).
    if (!this.awaiting.has(id) && !this.ready.has(id)) {
      call.respond(errorResult(UNMATCHED_CALL_MESSAGE));
      return;
    }
    const expected = this.awaitedNames.get(id);
    if (expected && call.name && call.name !== expected) {
      call.respond(
        errorResult(
          `pi refused this tool call: tool_use ${id} asked for "${expected}", not "${call.name}"`,
        ),
      );
      return;
    }
    this.routeCall(id, call);
  }

  private routeCall(id: string, call: HandoffCall): void {
    this.awaiting.delete(id);
    this.awaitedNames.delete(id);
    const ready = this.ready.get(id);
    if (ready) {
      this.ready.delete(id);
      call.respond(ready);
      return;
    }
    this.pending.set(id, call);
  }

  /** Answer every open call with an error; used on retire and turn end. */
  private failPendingCalls(message: string): void {
    for (const call of this.pending.values())
      call.respond(errorResult(message));
    this.pending.clear();
    this.awaiting.clear();
    this.awaitedNames.clear();
    this.ready.clear();
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * End the process for good. A live turn is interrupted first so the CLI
   * can exit on its own. Resolves once the process has closed or been
   * force-killed.
   */
  retire(): Promise<void> {
    if (this.retired) return this.waitClosed();
    this.retired = true;
    removeSessionMcpConfig(this.cliSessionId);
    this.clearIdleTimer();
    unregisterHandoffTarget(this.cliSessionId, this);
    this.failPendingCalls("pi abandoned this tool call.");
    this.failControlWaiters();
    if (!this.alive) return Promise.resolve();

    // Resolves on close, or once the SIGKILL has been issued — a caller that
    // needs the process gone before spawning its replacement must not hang
    // on a process that will not report its exit.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    this.closeWaiters.push(() => settle());

    // Timers, not awaits: the kill must fire from the timer callback itself
    // so a host driving fake timers (and a wedged CLI) sees it promptly.
    const endThenKill = () => {
      if (!this.alive) return;
      try {
        this.proc.stdin?.end();
      } catch {
        /* already closed */
      }
      const killTimer = setTimeout(() => {
        if (this.alive) forceKillProcess(this.proc);
        settle();
      }, EXIT_GRACE_MS);
      killTimer.unref?.();
      this.closeWaiters.push(() => clearTimeout(killTimer));
    };
    if (this.turnActive && !this.stdoutClosed) {
      // Let the CLI end the interrupted turn before stdin goes away.
      sendInterrupt(this.proc);
      const graceTimer = setTimeout(endThenKill, INTERRUPT_GRACE_MS);
      graceTimer.unref?.();
      this.closeWaiters.push(() => clearTimeout(graceTimer));
    } else {
      endThenKill();
    }
    return settled;
  }

  private waitClosed(): Promise<void> {
    if (!this.alive) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  private handleLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return;

    // The answer to a control request of ours goes to whoever sent it, never
    // to an episode or the detached buffer: it is not part of any turn.
    if (msg.type === "control_response") {
      const settle = this.controlWaiters.get(msg.response?.request_id);
      if (settle) {
        settle(msg.response.subtype === "success");
        return;
      }
    }

    if (msg.type === "control_request") {
      // Answered here so a permission prompt is never left waiting while no
      // episode is attached (a tool call parked in a handoff).
      handleControlRequest(msg, this.proc.stdin!, {
        allowHandoff: this.allowHandoff,
      });
    }

    // The turn is over before the episode sees the result, so an episode that
    // retires the process on it does not interrupt a turn that has ended.
    if (msg.type === "result") this.turnActive = false;

    if (this.sink) {
      this.sink.onMessage(msg);
    } else if (msg.type !== "control_request") {
      if (this.buffer.length >= DETACHED_BUFFER_LIMIT) this.buffer.shift();
      this.buffer.push(msg);
    }

    if (msg.type === "result") {
      // Nothing the CLI asked for during the turn can be answered any more.
      this.failPendingCalls("the turn ended before pi delivered this result.");
    }
  }

  private stdoutClosed = false;
  private handleStdoutClose(): void {
    if (this.stdoutClosed) return;
    this.stdoutClosed = true;
    // No more output means no result is coming: the turn is over.
    this.turnActive = false;
    this.failControlWaiters();
    if (!this.closed) this.sink?.onClose(this.exitCode ?? null);
  }

  private closed = false;
  private handleProcClose(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    removeSessionMcpConfig(this.cliSessionId);
    this.alive = false;
    this.turnActive = false;
    this.clearIdleTimer();
    unregisterHandoffTarget(this.cliSessionId, this);
    this.failPendingCalls("the Claude CLI process exited.");
    this.failControlWaiters();
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of waiters) w();
    for (const h of this.onExitHandlers) h(code);
    if (!this.stdoutClosed) this.sink?.onClose(code);
    this.stdoutClosed = true;
  }
}

// ---- pool ------------------------------------------------------------------

const parked = new Map<string, CliProcess>();

/** Park a process for its pi session; an existing entry is retired. */
export function parkCliProcess(
  piSessionId: string,
  cli: CliProcess,
  idleMs: number,
): void {
  const previous = parked.get(piSessionId);
  if (previous && previous !== cli) void previous.retire();
  parked.set(piSessionId, cli);
  cli.onExit(() => {
    if (parked.get(piSessionId) === cli) parked.delete(piSessionId);
  });
  cli.startIdleTimer(idleMs, () => {
    if (parked.get(piSessionId) === cli) parked.delete(piSessionId);
    void cli.retire();
  });
}

/** Take the parked process for a pi session out of the pool, if any. */
export function takeParkedCliProcess(
  piSessionId: string,
): CliProcess | undefined {
  const cli = parked.get(piSessionId);
  if (!cli) return undefined;
  parked.delete(piSessionId);
  cli.clearIdleTimer();
  if (!cli.alive || cli.retired) return undefined;
  return cli;
}

export function parkedCliProcessCount(): number {
  return parked.size;
}

/** Test seam: drop and force-kill every parked process synchronously. */
export function resetCliProcessesForTests(): void {
  for (const cli of parked.values()) {
    cli.clearIdleTimer();
    (cli as any).retired = true;
    unregisterHandoffTarget(cli.cliSessionId, cli);
    if (cli.alive) forceKillProcess(cli.proc);
  }
  parked.clear();
}

/** Retire every parked process (extension teardown, tests). */
export async function retireAllCliProcesses(): Promise<void> {
  const all = [...parked.values()];
  parked.clear();
  await Promise.all(all.map((cli) => cli.retire()));
}
