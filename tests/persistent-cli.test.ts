/**
 * The persistent CLI process: one process per pi session that lives through
 * proxied tool calls and across turns, so pi's history is imported once per
 * process instead of once per call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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
    (proc as any).pid = 4242;
    return proc;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));

const { MockStream } = vi.hoisted(() => {
  const MockStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockStream,
  createAssistantMessageEventStream: vi.fn(() => new MockStream()),
  calculateCost: vi.fn(),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import {
  resetCliProcessesForTests,
  parkedCliProcessCount,
} from "../src/cli-process";
import {
  dispatchHandoffCall,
  resetHandoffBrokerForTests,
} from "../src/handoff-broker";
import type { HandoffResult } from "../src/handoff-broker";
import { resetMcpConfigCache } from "../src/mcp-config";

const model = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: "text",
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as any;

const ourAssistant = (content: any) => ({
  role: "assistant",
  content,
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
});

const line = (o: any) => JSON.stringify(o) + "\n";
const ev = (event: any) => line({ type: "stream_event", event });
const startCycle = (usage: any) =>
  ev({ type: "message_start", message: { usage } });
const text = (t: string) =>
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: t },
  }) +
  ev({ type: "content_block_stop", index: 0 });
const handoffToolUse = (id: string, name: string, args: any) =>
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name, input: "" },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
  }) +
  ev({ type: "content_block_stop", index: 0 });
const endCycle = (stop: string, output = 5) =>
  ev({
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: output },
  }) + ev({ type: "message_stop" });
const result = (extra: any = {}) =>
  line({ type: "result", subtype: "success", is_error: false, ...extra });

const procAt = (i: number) => (spawn as any).mock.results[i].value;
const spawnArgs = (i: number) => (spawn as any).mock.calls[i][1] as string[];
const cliIdOf = (i: number) => {
  const a = spawnArgs(i);
  const k = a.indexOf("--session-id");
  return a[k + 1];
};
const written = (proc: any) =>
  (proc.stdin.write as any).mock.calls.map((c: any) => String(c[0]));
const doneOf = (n: number) =>
  MockStream.mock.instances[n]._events.find((e: any) => e.type === "done");

describe("persistent CLI process", () => {
  const opts = (sessionId: string, extra: any = {}) => ({
    sessionId,
    mcpConfig: {
      schemaPath: "/tmp/schema.json",
      version: 1,
      handoffSocket: "/tmp/handoff.sock",
    },
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    resetMcpConfigCache();
    delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
    delete process.env.PI_CLAUDE_CLI_HANDOFF_PROXY;
  });

  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
    delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
    delete process.env.PI_CLAUDE_CLI_HANDOFF_PROXY;
  });

  describe("pi context continuity", () => {
    it("keeps the warm process across follow-up turns", async () => {
      const ctx = {
        systemPrompt: "PI-PROJECT-SENTINEL",
        messages: [{ role: "user", content: "first" }],
      };
      streamViaCli(model, ctx, opts("pi-context") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      expect(spawnArgs(0)).toContain("--no-session-persistence");
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      const next = {
        ...ctx,
        messages: [
          ...ctx.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, next, opts("pi-context") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("two") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(1).message.stopReason).toBe("stop");
    });
  });

  describe("default pi ownership", () => {
    it("returns a structured abort before spawning", () => {
      const controller = new AbortController();
      controller.abort();
      streamViaCli(model, { messages: [] }, { signal: controller.signal });
      expect(spawn).not.toHaveBeenCalled();
      expect(MockStream.mock.instances[0]._events[0].error.stopReason).toBe(
        "aborted",
      );
    });

    it("surfaces the CLI error as an assistant error for pi retry/compaction", async () => {
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        opts("error") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        result({ is_error: true, result: "prompt is too long" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      const event = MockStream.mock.instances[0]._events.find(
        (e: any) => e.type === "error",
      );
      expect(event.error.stopReason).toBe("error");
      expect(event.error.errorMessage).toBe("prompt is too long");
      expect(parkedCliProcessCount()).toBe(0);
    });
    it.each(["native-turn", "branch", "compaction", "prompt"])(
      "reimports pi context after %s without stale history",
      async (change) => {
        const ctx = {
          systemPrompt: "old rules",
          messages: [{ role: "user", content: "original" }],
        };
        streamViaCli(model, ctx, opts("owned") as any);
        await vi.advanceTimersByTimeAsync(0);
        procAt(0).stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("one") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(10);
        const messages: any[] = [
          ...ctx.messages,
          ourAssistant(doneOf(0).message.content),
        ];
        if (change === "native-turn")
          messages.push(
            { role: "user", content: "native question" },
            {
              role: "assistant",
              provider: "openai",
              content: [{ type: "text", text: "NATIVE FINDING" }],
            },
          );
        if (change === "branch")
          messages[0] = { role: "user", content: "edited root" };
        if (change === "compaction")
          messages.splice(0, 1, { role: "user", content: "compact summary" });
        messages.push({ role: "user", content: "follow-up" });
        streamViaCli(
          model,
          {
            systemPrompt: change === "prompt" ? "new rules" : ctx.systemPrompt,
            messages,
          },
          opts("owned") as any,
        );
        await vi.advanceTimersByTimeAsync(600);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(procAt(0).stdin.end).toHaveBeenCalled();
        expect(spawnArgs(1)).not.toContain("--resume");
        const replay = written(procAt(1)).join("");
        expect(replay).toContain("follow-up");
        if (change === "native-turn")
          expect(replay).toContain("NATIVE FINDING");
        if (change === "branch" || change === "compaction")
          expect(replay).not.toContain("original");
        procAt(1).stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("two") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(doneOf(1).message.stopReason).toBe("stop");
      },
    );
  });

  describe("proxied handoff", () => {
    it("hands the tool to pi WITHOUT interrupting, then answers the CLI's tools/call from the next pi call on the same process", async () => {
      const ctx1 = { messages: [{ role: "user", content: "search please" }] };
      streamViaCli(model, ctx1, opts("pi-A") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      // The config file names this session so the schema server can route back.
      const cfgIdx = spawnArgs(0).indexOf("--mcp-config");
      expect(spawnArgs(0)[cfgIdx + 1]).toContain(cliId);

      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        }) +
          handoffToolUse("toolu_1", "mcp__custom-tools__search", { q: "x" }) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);

      // pi got the toolCall and the turn ended for pi…
      const done1 = doneOf(0);
      expect(done1.reason).toBe("toolUse");
      expect(
        done1.message.content.filter((c: any) => c.type === "toolCall"),
      ).toHaveLength(1);
      // …but the CLI was neither interrupted nor killed.
      expect(written(proc).join("")).not.toContain('"interrupt"');
      expect(proc.kill).not.toHaveBeenCalled();
      expect(parkedCliProcessCount()).toBe(1);

      // The CLI asks permission (allowed) and calls the tool over MCP.
      proc.stdout.write(
        line({
          type: "control_request",
          request_id: "perm-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "mcp__custom-tools__search",
            input: { q: "x" },
            tool_use_id: "toolu_1",
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const perm = written(proc)
        .map((w: string) => JSON.parse(w))
        .find((m: any) => m.type === "control_response");
      expect(perm.response.response.behavior).toBe("allow");

      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliId, {
        toolUseId: "toolu_1",
        name: "search",
        arguments: { q: "x" },
        respond: (r) => answers.push(r),
      });
      expect(answers).toHaveLength(0);

      // pi executed the tool and calls back with the result.
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(done1.message.content),
          {
            role: "toolResult",
            toolCallId: "toolu_1",
            toolName: "search",
            content: [{ type: "text", text: "three hits" }],
            isError: false,
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-A") as any);
      await vi.advanceTimersByTimeAsync(0);
      // Same process: no second spawn, no user message written, the call answered.
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([
        { content: [{ type: "text", text: "three hits" }] },
      ]);
      expect(
        written(proc).filter((w: string) => JSON.parse(w).type === "user"),
      ).toHaveLength(1);

      // The CLI continues in-process; its next cycle streams into the second pi call.
      proc.stdout.write(
        startCycle({
          input_tokens: 2,
          cache_read_input_tokens: 130,
          cache_creation_input_tokens: 20,
        }) +
          text("Found three.") +
          endCycle("end_turn", 7) +
          result({
            usage: {
              input_tokens: 12,
              output_tokens: 12,
              cache_read_input_tokens: 230,
              cache_creation_input_tokens: 25,
            },
          }),
      );
      await vi.advanceTimersByTimeAsync(10);
      const done2 = doneOf(1);
      expect(done2.reason).toBe("stop");
      expect(done2.message.content.map((c: any) => c.text).join("")).toContain(
        "Found three.",
      );
      // Parked for the next turn rather than killed.
      expect(proc.kill).not.toHaveBeenCalled();
      expect(parkedCliProcessCount()).toBe(1);
    });

    it("answers a tools/call that arrives before pi's result as soon as the result lands", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-B") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t2", "mcp__custom-tools__deploy", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      const answers: HandoffResult[] = [];
      // pi answers first…
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "t2",
            toolName: "deploy",
            content: [{ type: "text", text: "deployed" }],
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-B") as any);
      await vi.advanceTimersByTimeAsync(0);
      // …then the CLI's call comes in and is answered immediately.
      dispatchHandoffCall(cliId, {
        toolUseId: "t2",
        name: "deploy",
        arguments: {},
        respond: (r) => answers.push(r),
      });
      expect(answers[0].content[0]).toEqual({ type: "text", text: "deployed" });
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("retires the process and reimports pi's history when the delta is not exactly the awaited tool results", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-C") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc1 = procAt(0);
      proc1.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t3", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      // pi appends a user message after the tool result (a host injecting a screenshot, say).
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "t3",
            toolName: "x",
            content: [{ type: "text", text: "r" }],
          },
          { role: "user", content: "and look at this" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-C") as any);
      await vi.advanceTimersByTimeAsync(0);
      // The live process is interrupted and retired; a fresh one is handed
      // pi's whole history, tool result and new user message included.
      expect(written(proc1).join("")).toContain('"interrupt"');
      await vi.advanceTimersByTimeAsync(2600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      const sent = JSON.stringify(
        JSON.parse(written(procAt(1))[0]).message.content,
      );
      expect(sent).toContain("TOOL RESULT (x, id=t3, error=false):");
      expect(sent).toContain("and look at this");
    });

    it("PI_CLAUDE_CLI_HANDOFF_PROXY=0 interrupts the turn at a tool call instead of proxying it", async () => {
      process.env.PI_CLAUDE_CLI_HANDOFF_PROXY = "0";
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        opts("pi-D") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t4", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(written(proc).join("")).toContain('"interrupt"');
      // The permission for the handoff tool is denied on this path.
      proc.stdout.write(
        line({
          type: "control_request",
          request_id: "p",
          request: {
            subtype: "can_use_tool",
            tool_name: "mcp__custom-tools__x",
            input: {},
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const perm = written(proc)
        .map((w: string) => JSON.parse(w))
        .find((m: any) => m.type === "control_response");
      expect(perm.response.response.behavior).toBe("deny");
    });
  });

  describe("thinking changes mid-session", () => {
    const after = (args: string[], flag: string) =>
      args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1];
    const wire = (proc: any) => written(proc).map((w: string) => JSON.parse(w));
    /** Our own thinking controls (never the CLI's permission answers). */
    const ours = (proc: any) =>
      wire(proc).filter(
        (m: any) =>
          m.type === "control_request" &&
          String(m.request_id).startsWith("pcc-"),
      );
    /** Acknowledge each control as it arrives; the provider sends them in order. */
    const ackAll = async (proc: any, subtype = "success") => {
      const answered = new Set<string>();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);
        for (const c of ours(proc)) {
          if (answered.has(c.request_id)) continue;
          answered.add(c.request_id);
          proc.stdout.write(
            line({
              type: "control_response",
              response: { subtype, request_id: c.request_id },
            }),
          );
        }
      }
      await vi.advanceTimersByTimeAsync(0);
    };
    const finishTurn = async (proc: any, t: string) => {
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text(t) +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
    };
    /** Turn 1 at `level`, finished; returns the history for turn 2. */
    const firstTurn = async (session: string, level: any) => {
      const ctx = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx, opts(session, { reasoning: level }) as any);
      await vi.advanceTimersByTimeAsync(0);
      await finishTurn(procAt(0), "one");
      return [
        ...ctx.messages,
        ourAssistant(doneOf(0).message.content),
        { role: "user", content: "second" },
      ];
    };

    it("applies a new level to the warm process before the next user message", async () => {
      const messages = await firstTurn("think-1", "medium");
      expect(after(spawnArgs(0), "--effort")).toBe("medium");
      expect(after(spawnArgs(0), "--max-thinking-tokens")).toBe("8192");

      streamViaCli(
        model,
        { messages },
        opts("think-1", {
          reasoning: "high",
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      // Nothing is written to the CLI's turn until the change is acknowledged.
      expect(
        wire(procAt(0)).filter((m: any) => m.type === "user"),
      ).toHaveLength(1);
      await ackAll(procAt(0));

      expect(spawn).toHaveBeenCalledTimes(1);
      const lines = wire(procAt(0));
      expect(ours(procAt(0)).map((c: any) => c.request)).toEqual([
        {
          subtype: "set_max_thinking_tokens",
          max_thinking_tokens: 16384,
          thinking_display: "summarized",
        },
        { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
      ]);
      const lastControl = lines.lastIndexOf(ours(procAt(0))[1]);
      const secondUser = lines.findLastIndex((m: any) => m.type === "user");
      expect(secondUser).toBeGreaterThan(lastControl);
      await finishTurn(procAt(0), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("turns thinking off mid-session without a respawn", async () => {
      const messages = await firstTurn("think-2", "medium");
      streamViaCli(model, { messages }, opts("think-2") as any); // pi's off
      await ackAll(procAt(0));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ours(procAt(0)).map((c: any) => c.request)).toEqual([
        { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 },
      ]);
      await finishTurn(procAt(0), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("writes no controls when the level did not change", async () => {
      const messages = await firstTurn("think-3", "low");
      streamViaCli(
        model,
        { messages },
        opts("think-3", {
          reasoning: "low",
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(ours(procAt(0))).toHaveLength(0);
      expect(
        wire(procAt(0)).filter((m: any) => m.type === "user"),
      ).toHaveLength(2);
    });

    it("spawns with the new flags when the live process refuses the change", async () => {
      const messages = await firstTurn("think-4", "medium");
      streamViaCli(
        model,
        { messages },
        opts("think-4", {
          reasoning: "high",
        }) as any,
      );
      await ackAll(procAt(0), "error");
      await vi.advanceTimersByTimeAsync(600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(after(spawnArgs(1), "--effort")).toBe("high");
      expect(after(spawnArgs(1), "--max-thinking-tokens")).toBe("16384");
      expect(written(procAt(1)).join("")).toContain("second");
      await finishTurn(procAt(1), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("keeps a handoff's turn as is; the change lands on the next user turn", async () => {
      const ctx1 = { messages: [{ role: "user", content: "search please" }] };
      streamViaCli(
        model,
        ctx1,
        opts("think-5", { reasoning: "medium" }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("toolu_t", "mcp__custom-tools__search", { q: "x" }) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      const done1 = doneOf(0);
      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "toolu_t",
        name: "search",
        arguments: { q: "x" },
        respond: (r) => answers.push(r),
      });
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(done1.message.content),
          {
            role: "toolResult",
            toolCallId: "toolu_t",
            toolName: "search",
            content: [{ type: "text", text: "hits" }],
            isError: false,
          },
        ],
      };
      // The level changed while the tool ran.
      streamViaCli(model, ctx2, opts("think-5", { reasoning: "high" }) as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toHaveLength(1);
      expect(ours(proc)).toHaveLength(0);
      await finishTurn(proc, "found");
      expect(doneOf(1).message.stopReason).toBe("stop");

      const ctx3 = {
        messages: [
          ...ctx2.messages,
          ourAssistant(doneOf(1).message.content),
          { role: "user", content: "and then?" },
        ],
      };
      streamViaCli(model, ctx3, opts("think-5", { reasoning: "high" }) as any);
      await ackAll(proc);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ours(proc).map((c: any) => c.request.subtype)).toEqual([
        "set_max_thinking_tokens",
        "apply_flag_settings",
      ]);
    });

    it("applies the change in place when thinking budgets are passed explicitly", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("think-6", { reasoning: "high" }) as any);
      await vi.advanceTimersByTimeAsync(0);
      await finishTurn(procAt(0), "one");
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("think-6", { reasoning: "low" }) as any);
      await ackAll(procAt(0));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ours(procAt(0)).map((c: any) => c.request)).toEqual([
        {
          subtype: "set_max_thinking_tokens",
          max_thinking_tokens: 2048,
          thinking_display: "summarized",
        },
        { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
      ]);
    });
  });

  describe("turn continuation", () => {
    it("writes the next user turn to the parked process instead of spawning", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-E") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({ usage: { input_tokens: 1, output_tokens: 5 } }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).reason).toBe("stop");
      expect(proc.kill).not.toHaveBeenCalled();

      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-E") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const users = written(proc)
        .map((w: string) => JSON.parse(w))
        .filter((m: any) => m.type === "user");
      expect(users).toHaveLength(2);
      // Only the delta is written to the warm process, never the history.
      const delta = JSON.stringify(users[1].message.content);
      expect(delta).toContain("second");
      expect(delta).not.toContain("first");
      expect(String(users[1].message.content)).not.toContain("first");

      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("two") +
          endCycle("end_turn") +
          result({ usage: { input_tokens: 1, output_tokens: 5 } }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(
        doneOf(1)
          .message.content.map((c: any) => c.text)
          .join(""),
      ).toContain("two");
    });

    it("bills each turn from the delta of the CLI's process-cumulative modelUsage", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-F") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const mu = (inp: number, out: number, cr: number, cw: number) => ({
        "claude-opus-5": {
          inputTokens: inp,
          outputTokens: out,
          cacheReadInputTokens: cr,
          cacheCreationInputTokens: cw,
        },
      });
      proc.stdout.write(
        startCycle({ input_tokens: 10, cache_creation_input_tokens: 1000 }) +
          text("one") +
          endCycle("end_turn", 40) +
          result({ modelUsage: mu(10, 40, 0, 1000) }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).message.usage).toMatchObject({
        input: 10,
        output: 40,
        cacheRead: 0,
        cacheWrite: 1000,
      });

      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-F") as any);
      await vi.advanceTimersByTimeAsync(0);
      // Cumulative: turn 1 + turn 2 (turn 2 = 10 in, 30 out, 1000 read, 50 write).
      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        }) +
          text("two") +
          endCycle("end_turn", 30) +
          result({ modelUsage: mu(20, 70, 1000, 1050) }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(1).message.usage).toMatchObject({
        input: 10,
        output: 30,
        cacheRead: 1000,
        cacheWrite: 50,
      });
    });

    it("bills a turn split across a handoff once: the finishing episode is net of what the first reported", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-G") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      proc.stdout.write(
        startCycle({ input_tokens: 10, cache_creation_input_tokens: 1000 }) +
          handoffToolUse("t", "mcp__custom-tools__x", {}) +
          endCycle("tool_use", 40),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).message.usage).toMatchObject({
        input: 10,
        output: 40,
        cacheWrite: 1000,
      });
      dispatchHandoffCall(cliId, {
        toolUseId: "t",
        name: "x",
        arguments: {},
        respond: () => {},
      });
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "t",
            toolName: "x",
            content: [{ type: "text", text: "r" }],
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-G") as any);
      await vi.advanceTimersByTimeAsync(0);
      const mu = {
        "claude-opus-5": {
          inputTokens: 20,
          outputTokens: 70,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 1050,
        },
      };
      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        }) +
          text("done") +
          endCycle("end_turn", 30) +
          result({ modelUsage: mu }),
      );
      await vi.advanceTimersByTimeAsync(10);
      // Whole turn was 20/70/1000/1050; the first episode already reported 10/40/0/1000.
      expect(doneOf(1).message.usage).toMatchObject({
        input: 10,
        output: 30,
        cacheRead: 1000,
        cacheWrite: 50,
      });
    });

    it("spawns fresh when the spawn parameters differ (model switch)", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-H") as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      const other = { ...model, id: "claude-sonnet-5" };
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(other, ctx2, opts("pi-H") as any);
      await vi.advanceTimersByTimeAsync(600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(spawnArgs(1)).not.toContain("--resume");
      expect(written(procAt(1)).join("")).toContain("first");
    });

    it("retires the parked process after the keepalive window; the next turn reimports pi's history", async () => {
      process.env.PI_CLAUDE_CLI_KEEPALIVE_MS = "1000";
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-I") as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-I") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      const replay = written(procAt(1)).join("");
      expect(replay).toContain("first");
      expect(replay).toContain("second");
    });

    it("PI_CLAUDE_CLI_KEEPALIVE_MS=0 ends the process at result", async () => {
      process.env.PI_CLAUDE_CLI_KEEPALIVE_MS = "0";
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "first" }] },
        opts("pi-J") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("without a pi session id nothing is parked and nothing is proxied", async () => {
      streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
        mcpConfig: opts("x").mcpConfig,
      } as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(written(proc).join("")).toContain('"interrupt"');
      expect(parkedCliProcessCount()).toBe(0);
    });
  });
});
