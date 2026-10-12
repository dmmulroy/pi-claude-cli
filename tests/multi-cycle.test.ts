import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same harness as provider.test.ts: PassThrough stdout for readline.
vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    const stdin = { write: vi.fn(), end: vi.fn() };
    const stdout = new PassThrough();
    const stderr = new EventEmitter();
    (proc as any).stdin = stdin;
    (proc as any).stdout = stdout;
    (proc as any).stderr = stderr;
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).kill = vi.fn(() => {
      (proc as any).killed = true;
    });
    (proc as any).pid = 99999;
    return proc;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("1.0.0")),
}));

const { MockAssistantMessageEventStream } = vi.hoisted(() => {
  const MockAssistantMessageEventStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockAssistantMessageEventStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockAssistantMessageEventStream,
  createAssistantMessageEventStream: vi.fn(
    () => new MockAssistantMessageEventStream(),
  ),
  calculateCost: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: vi.fn(() => []),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import { resetCliProcessesForTests } from "../src/cli-process";

const model = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: "text",
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 8192,
} as any;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A real captured `claude -p --output-format stream-json
 * --include-partial-messages` episode (claude 2.1.237, 2026-08-21): three
 * cycles — thinking + ToolSearch, thinking + WebSearch, thinking + final
 * text — with tool_result user envelopes between cycles and a result
 * envelope carrying the cumulative usage (input 28, output 429,
 * cache_read 64055, cache_creation 17662).
 */
const EPISODE = readFileSync(
  join(__dirname, "fixtures", "multi-cycle-episode.jsonl"),
  "utf8",
);

describe("multi-cycle episodes (issue #3)", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runEpisode(): Promise<any> {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of EPISODE.split("\n")) {
      if (line.trim()) proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    return { message: done.message, events: mockStream._events };
  }

  it("keeps every cycle's content in order and never loses the final answer", async () => {
    const { message } = await runEpisode();
    const kinds = message.content.map((c: any) => c.type);

    // Three thinking blocks (one per cycle), no cross-cycle folding.
    expect(kinds.filter((k: string) => k === "thinking")).toHaveLength(3);

    // The final text block is the episode's actual answer, positioned last.
    const texts = message.content.filter((c: any) => c.type === "text");
    const finalText = texts[texts.length - 1].text;
    expect(finalText).toContain("grant access so I can search");
    expect(message.content[message.content.length - 1].type).toBe("text");

    // The safety net must not duplicate text the SSE stream already carried.
    const occurrences = texts.filter((t: any) =>
      t.text.includes("grant access so I can search"),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("surfaces CLI-side tools as marker blocks instead of dropping them", async () => {
    const { message } = await runEpisode();
    const texts = message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);

    expect(
      texts.some((t: string) => t.startsWith("[Claude Code · ToolSearch")),
    ).toBe(true);
    expect(
      texts.some((t: string) => t.startsWith("[Claude Code · WebSearch")),
    ).toBe(true);
    // No pi tool calls leak out of a CLI-side-only episode.
    expect(message.content.some((c: any) => c.type === "toolCall")).toBe(false);
    expect(message.stopReason).toBe("stop");
  });

  it("surfaces natively-executed built-in tools as markers, never as pi toolCalls", async () => {
    // Observer mode: the CLI runs Read/Bash/etc. itself mid-episode. pi sees
    // activity markers; a built-in must never become a pi toolCall and must
    // never end the episode early.
    const sse = (event: any) => JSON.stringify({ type: "stream_event", event });
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    const lines = [
      // Cycle 1: the model calls Read; the CLI executes it natively.
      sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 2 },
      }),
      sse({ type: "message_stop" }),
      // Envelope for the completed Read block → marker.
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/a.txt" },
            },
          ],
        },
      }),
      // CLI feeds the tool result back internally.
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }],
        },
      }),
      // Cycle 2: the final answer.
      sse({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "the file says hi" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      }),
      sse({ type: "message_stop" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    for (const line of lines) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(600);

    // The turn ran to completion: no interrupt asked for, no kill before the
    // 500ms post-result reap.
    const written = (proc.stdin.write as any).mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    expect(written).not.toContain('"interrupt"');

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.message.stopReason).toBe("stop");
    expect(done.message.content.some((c: any) => c.type === "toolCall")).toBe(
      false,
    );
    const texts = done.message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts.some((t: string) => t.startsWith("[Claude Code · Read"))).toBe(
      true,
    );
    expect(texts.some((t: string) => t.includes("the file says hi"))).toBe(
      true,
    );
  });

  it("bills every model the episode used, not just the main agent", async () => {
    const { message } = await runEpisode();

    // `result.usage` covers the MAIN AGENT only: 28 / 429 / 64055 / 17662.
    // `result.modelUsage` adds the work that never reaches the parent stream
    // — here the haiku auto-titler's 906 input + 12 output. In the wild that
    // slice is sub-agents, and it dwarfed the main agent (28.6M cache-read
    // tokens against 1.96M, reported as $2.34 of a real ~$24).
    expect(message.usage.input).toBe(28 + 906);
    expect(message.usage.output).toBe(429 + 12);
    expect(message.usage.cacheRead).toBe(64055);
    expect(message.usage.cacheWrite).toBe(17662);
  });

  it("reports context as the last cycle's prompt, not the summed cycles", async () => {
    const { message } = await runEpisode();

    // Per-cycle prompt sizes in the capture: the prefix is re-read every
    // cycle, so it appears in all three.
    //   cycle 0: 10 + 17825 + 7561 = 25396
    //   cycle 1: 10 + 18134 + 9962 = 28106
    //   cycle 2:  8 + 28096 +  139 = 28243
    // pi treats totalTokens as context, so only the last one is right.
    expect(message.usage.totalTokens).toBe(8 + 28096 + 139);

    // Guard the regression explicitly: the old value was the sum of all four
    // cumulative components, 2.9x the real context on this 3-cycle episode.
    expect(message.usage.totalTokens).not.toBe(28 + 429 + 64055 + 17662);
    expect(message.usage.totalTokens).toBeLessThan(message.usage.cacheRead);
  });

  it("sums per-cycle usage when the episode ends without a result envelope", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Two SSE-only cycles (break-early style: killed before `result`).
    const lines = EPISODE.split("\n").filter((l) => {
      if (!l.trim()) return false;
      const rec = JSON.parse(l);
      return rec.type === "stream_event";
    });
    // First two cycles = everything up to the second message_stop.
    let stops = 0;
    for (const line of lines) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
      if (JSON.parse(line).event.type === "message_stop" && ++stops === 2)
        break;
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    // Cycle finals from the capture: (10+155) + (10+95) outputs/inputs.
    expect(done.message.usage.input).toBe(20);
    expect(done.message.usage.output).toBe(250);
    expect(done.message.usage.cacheRead).toBe(17825 + 18134);
    expect(done.message.usage.cacheWrite).toBe(7561 + 9962);
    // Context still tracks the newest cycle even with no result envelope.
    expect(done.message.usage.totalTokens).toBe(10 + 18134 + 9962);
  });
});

describe("sub-agent visibility (#23)", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  /** The real nested capture: one sub-agent that spawned another. */
  const CAPTURE = readFileSync(
    join(__dirname, "fixtures", "subagent-task-events.ndjson"),
    "utf-8",
  )
    .split("\n")
    .filter(Boolean);

  async function runWithCapture(opts: Record<string, unknown> = {}) {
    streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      opts as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of CAPTURE) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "done" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    const markers = (done.message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .filter((t: string) => t.startsWith("[Claude Code · Task"));
    return { done, markers };
  }

  it("puts one marker in the turn per sub-agent start and finish", async () => {
    const { markers } = await runWithCapture();
    // Two sub-agents in the capture, one nested inside the other.
    expect(markers).toHaveLength(4);
    expect(markers.filter((m: string) => m.includes('"started"'))).toHaveLength(
      2,
    );
    expect(
      markers.filter((m: string) => m.includes('"completed"')),
    ).toHaveLength(2);
    // The nested agent is named, which is the whole point: before this, a
    // fan-out was a blank pane.
    expect(markers.join("\n")).toContain("Explore");
  });

  it("keeps per-step progress OUT of the turn and on the status channel", async () => {
    const seen: any[] = [];
    const { done } = await runWithCapture({
      onTaskProgress: (s: any) => seen.push(s),
    });

    // 3 task_progress events in the capture; none may reach the transcript.
    const text = (done.message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).not.toContain("Running Search for b.txt");
    expect(text).not.toContain("Reading b.txt");

    expect(seen.length).toBeGreaterThan(0);
    // The episode signs off with an EMPTY snapshot, which the host reads as
    // "clear the channel" — live state must not outlive the turn it is about.
    expect(seen[seen.length - 1]).toMatchObject({
      tasks: [],
      active: 0,
      completed: 0,
    });
    const last = seen.filter((s) => s.tasks.length > 0).at(-1);
    expect(last).toMatchObject({ active: 0, completed: 2 });
    expect(last.tasks.map((t: any) => t.subagentType)).toEqual([
      "general-purpose",
      "Explore",
    ]);
  });

  it("reports a fan-out as active while it is still running", async () => {
    const seen: any[] = [];
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onTaskProgress: (s: any) => seen.push(s),
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    for (const id of ["a", "b", "c"]) {
      proc.stdout.write(
        JSON.stringify({
          type: "system",
          subtype: "task_started",
          task_id: id,
          description: `Angle ${id}`,
          subagent_type: "general-purpose",
        }) + "\n",
      );
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(seen[seen.length - 1]).toMatchObject({ active: 3, completed: 0 });
  });

  it("ignores the other system subtypes on the same channel", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onTaskProgress: () => {
        throw new Error("must not fire for non-task system envelopes");
      },
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const subtype of ["init", "status", "task_summary"]) {
      proc.stdout.write(
        JSON.stringify({ type: "system", subtype, detail: "x" }) + "\n",
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "ok" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    expect(
      mockStream._events.find((e: any) => e.type === "done"),
    ).toBeDefined();
  });

  it("survives a host callback that throws", async () => {
    const { markers } = await runWithCapture({
      onTaskProgress: () => {
        throw new Error("host blew up");
      },
    });
    expect(markers).toHaveLength(4);
  });
});

describe("rate limit events (account state, not turn content)", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps rate_limit_event out of the message", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Captured verbatim from claude 2.1.237.
    proc.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1787331600,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "hi" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    const text = (done.message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).not.toContain("rate_limit");
    expect(text).not.toContain("five_hour");
  });
});

/**
 * Sub-agents report back — the reason a fan-out used to be a dead end.
 *
 * The CLI answers a background `Agent` call immediately and the model ends
 * its turn to wait for the notification it was promised. The CLI emits
 * `result` for THAT turn while the agents are still working, and killing on
 * it took the agents down mid-tool-call.
 *
 * Captured 2026-08-28 on claude 2.1.231: held open past the first `result`,
 * the CLI finished the agent at +25s, re-invoked the model unprompted, and
 * emitted a second `result` carrying the findings. These tests encode that
 * shape — two results, one turn.
 */
describe("waiting for background sub-agents", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT;
  });

  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const agentStarted = (id: string) =>
    line({
      type: "system",
      subtype: "task_started",
      task_id: id,
      task_type: "local_agent",
      tool_use_id: `toolu_${id}`,
      description: `agent ${id}`,
      subagent_type: "general-purpose",
    });
  const agentDone = (id: string, status = "completed") =>
    line({
      type: "system",
      subtype: "task_notification",
      task_id: id,
      status,
      summary: "the report",
    });
  const result = () =>
    line({ type: "result", subtype: "success", result: "ok" });

  async function start() {
    streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      {} as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    return (spawn as any).mock.results[0].value;
  }
  const doneEvent = () =>
    MockAssistantMessageEventStream.mock.instances[0]._events.find(
      (e: any) => e.type === "done",
    );

  it("does not kill the CLI on a result while an agent is still running", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(0);

    // The old behaviour: SIGKILL 500ms after the first result.
    await vi.advanceTimersByTimeAsync(1000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(doneEvent()).toBeUndefined();
  });

  it("ends the turn on the result that follows the last agent's report", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    proc.stdout.write(agentStarted("a2"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(1000);
    expect(doneEvent()).toBeUndefined();

    // One agent reports; the other still holds the turn open.
    proc.stdout.write(agentDone("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(1000);
    expect(doneEvent()).toBeUndefined();

    // Both reported: the next result is the episode's.
    proc.stdout.write(agentDone("a2"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(doneEvent()).toBeDefined();
  });

  it("keeps the continuation's content in the same pi turn", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      line({ type: "result", subtype: "success", result: "launched, waiting" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(agentDone("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      line({
        type: "result",
        subtype: "success",
        result: "the agent found the answer",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const text = (doneEvent().message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // Both cycles' answers, and the lifecycle either side of them.
    expect(text).toContain("launched, waiting");
    expect(text).toContain("the agent found the answer");
    expect(text).toContain('"status":"started"');
    expect(text).toContain('"status":"completed"');
  });

  it("does not wait for a task that is not a sub-agent", async () => {
    const proc = await start();
    // An auto-backgrounded Bash must not hold the turn open.
    proc.stdout.write(
      line({
        type: "system",
        subtype: "task_started",
        task_id: "b1",
        task_type: "local_bash",
        description: "Search for local source checkout of pi-claude-cli",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("gives up at the wall-clock ceiling, keeping the turn's own content", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      line({ type: "result", subtype: "success", result: "launched, waiting" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(doneEvent()).toBeUndefined();

    // The agent never reports. 15 minutes later the turn ends anyway, and
    // what the model already said survives — an error here would discard it.
    await vi.advanceTimersByTimeAsync(900_000 + 1000);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    const done = doneEvent();
    expect(done).toBeDefined();
    const text = (done.message.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("launched, waiting");
  });

  it("an agent that stalls ends the turn, it does not fail it", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      line({ type: "result", subtype: "success", result: "launched, waiting" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // The agent dies without notifying, so the CLI goes quiet. Silence is
    // the inactivity timeout's kill signal — but the model already spoke and
    // the result already landed, so converting that into
    // "Claude CLI subprocess timed out" would report a failure for a turn
    // that succeeded.
    await vi.advanceTimersByTimeAsync(300_000 + 1000);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const done = doneEvent();
    expect(done).toBeDefined();
    const text = (done.message.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("launched, waiting");
    // The turn reports what happened, not a subprocess timeout.
    expect(text).not.toContain("timed out");
    expect(text).not.toContain("Error:");
  });

  it("still ends immediately on an error result", async () => {
    const proc = await start();
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("PI_CLAUDE_CLI_NO_AGENT_WAIT=1 restores the old teardown", async () => {
    process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT = "1";
    vi.resetModules();
    const { streamViaCli: noWait } = await import("../src/provider");
    noWait(model, { messages: [{ role: "user", content: "go" }] }, {} as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    proc.stdout.write(agentStarted("a1"));
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(result());
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

/**
 * Provider-level pass over the SAME captured episode with result forwarding
 * on: proves the `user` envelope branch in provider.ts reaches the bridge,
 * and that the real fixture's two tool_results (one ok with only a
 * tool_reference block, one is_error string) come out as paired markers.
 */
describe("tool result forwarding through the provider (PI_CLAUDE_CLI_TOOL_RESULTS)", () => {
  const FLAG = "PI_CLAUDE_CLI_TOOL_RESULTS";
  let saved: string | undefined;

  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
    saved = process.env[FLAG];
    process.env[FLAG] = "1";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  async function runEpisode(): Promise<any> {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of EPISODE.split("\n")) {
      if (line.trim()) proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    return done.message;
  }

  it("pairs each fixture result to its id-tagged call marker", async () => {
    const message = await runEpisode();
    const texts = message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);

    // Call markers now carry the ids the fixture really used.
    expect(
      texts.some((t: string) =>
        t.startsWith(
          "[Claude Code · ToolSearch #toolu_0184T4PXjC3DYpy1wRRZ1A9j",
        ),
      ),
    ).toBe(true);
    expect(
      texts.some((t: string) =>
        t.startsWith(
          "[Claude Code · WebSearch #toolu_01WaqWQ9mT68TCvVkQf9ddGv",
        ),
      ),
    ).toBe(true);

    // ToolSearch's result content is a lone tool_reference block: an ok
    // result with an empty preview, not a dropped one.
    const toolSearchResult = texts.find((t: string) =>
      t.startsWith("[Claude Code · result #toolu_0184T4PXjC3DYpy1wRRZ1A9j"),
    );
    expect(toolSearchResult).toBeDefined();
    const tsPayload = JSON.parse(
      /^\[Claude Code · result #\S+ (.*)\]$/s.exec(toolSearchResult!)![1]!,
    );
    expect(tsPayload).toEqual({
      status: "ok",
      tool: "ToolSearch",
      summary: "empty",
      preview: "",
      length: 0,
    });

    // WebSearch's result is a real is_error string.
    const webSearchResult = texts.find((t: string) =>
      t.startsWith("[Claude Code · result #toolu_01WaqWQ9mT68TCvVkQf9ddGv"),
    );
    expect(webSearchResult).toBeDefined();
    const wsPayload = JSON.parse(
      /^\[Claude Code · result #\S+ (.*)\]$/s.exec(webSearchResult!)![1]!,
    );
    expect(wsPayload.status).toBe("error");
    expect(wsPayload.preview).toContain("haven't granted it yet");

    // Each result marker sits AFTER its call marker.
    const callIdx = texts.findIndex((t: string) =>
      t.startsWith("[Claude Code · WebSearch #"),
    );
    const resultIdx = texts.findIndex((t: string) =>
      t.startsWith("[Claude Code · result #toolu_01WaqWQ9mT68TCvVkQf9ddGv"),
    );
    expect(resultIdx).toBeGreaterThan(callIdx);
  });

  it("changes nothing when the flag is off", async () => {
    delete process.env[FLAG];
    const message = await runEpisode();
    const texts = message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts.some((t: string) => t.includes("· result #"))).toBe(false);
    expect(texts.some((t: string) => t.includes(" #toolu_"))).toBe(false);
    // The historical shape, exactly.
    expect(
      texts.some((t: string) => t.startsWith("[Claude Code · ToolSearch {")),
    ).toBe(true);
  });
});
