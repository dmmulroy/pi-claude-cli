/**
 * How one pi call ends when things go wrong: abort, a silent CLI, a CLI that
 * exits or fails to start, and an error result. Every path must end pi's
 * stream exactly once and must not leave a process parked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).stdout = new PassThrough();
    (proc as any).stderr = new EventEmitter();
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
  execSync: vi.fn(() => Buffer.from("2.1.292 (Claude Code)")),
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
import { execSync } from "node:child_process";
import { streamViaCli, toHandoffResult } from "../src/provider";
import {
  resetCliProcessesForTests,
  parkedCliProcessCount,
} from "../src/cli-process";
import { resetHandoffBrokerForTests } from "../src/handoff-broker";
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

const line = (o: any) => JSON.stringify(o) + "\n";
const ev = (event: any) => line({ type: "stream_event", event });
const startCycle = () =>
  ev({ type: "message_start", message: { usage: { input_tokens: 1 } } });
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
const endCycle = (stop: string) =>
  ev({
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: 5 },
  }) + ev({ type: "message_stop" });

const procAt = (i: number) => (spawn as any).mock.results[i].value;
const eventsOf = (n: number) => MockStream.mock.instances[n]._events as any[];
const streamOf = (n: number) => MockStream.mock.instances[n];
const terminalEvents = (n: number) =>
  eventsOf(n).filter((e) => e.type === "error" || e.type === "done");

const opts = (sessionId: string, extra: any = {}) => ({
  sessionId,
  mcpConfig: {
    schemaPath: "/tmp/schema.json",
    version: 1,
    handoffSocket: "/tmp/handoff.sock",
  },
  ...extra,
});
const userTurn = { messages: [{ role: "user", content: "go" }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  (execSync as any).mockReturnValue(Buffer.from("2.1.292 (Claude Code)"));
  resetCliProcessesForTests();
  resetHandoffBrokerForTests();
  resetMcpConfigCache();
});

afterEach(() => {
  resetCliProcessesForTests();
  vi.useRealTimers();
  delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
});

describe("streamViaCli failure and abort paths", () => {
  it("abort mid-stream ends the stream as aborted, keeps what streamed, and retires the process", async () => {
    const controller = new AbortController();
    streamViaCli(
      model,
      userTurn,
      opts("abort", { signal: controller.signal }) as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(startCycle() + text("partial answer"));
    await vi.advanceTimersByTimeAsync(10);

    controller.abort();
    await vi.advanceTimersByTimeAsync(3000);

    const [event, ...rest] = terminalEvents(0);
    expect(rest).toHaveLength(0);
    expect(event.type).toBe("error");
    expect(event.reason).toBe("aborted");
    expect(event.error.stopReason).toBe("aborted");
    expect(event.error.content[0].text).toBe("partial answer");
    expect(streamOf(0).end).toHaveBeenCalledTimes(1);
    expect(parkedCliProcessCount()).toBe(0);
    expect(procAt(0).stdin.end).toHaveBeenCalled();
  });

  it("output arriving after an abort does not reach pi's ended stream", async () => {
    const controller = new AbortController();
    streamViaCli(
      model,
      userTurn,
      opts("abort-late", { signal: controller.signal }) as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const pushedAtAbort = eventsOf(0).length;

    procAt(0).stdout.write(
      startCycle() + text("too late") + endCycle("end_turn"),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(eventsOf(0)).toHaveLength(pushedAtAbort);
  });

  it("a CLI that goes silent is killed and reported after the inactivity timeout", async () => {
    streamViaCli(model, userTurn, opts("silent") as any);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(300_000);

    const [event] = terminalEvents(0);
    expect(event.type).toBe("error");
    expect(event.reason).toBe("error");
    expect(event.error.errorMessage).toMatch(/timed out: no output for 300/);
    expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
    expect(parkedCliProcessCount()).toBe(0);
  });

  it("output resets the inactivity timeout", async () => {
    streamViaCli(model, userTurn, opts("slow") as any);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(299_000);
    procAt(0).stdout.write(startCycle());
    await vi.advanceTimersByTimeAsync(299_000);

    expect(terminalEvents(0)).toHaveLength(0);
  });

  it("a CLI that exits before a result reports its exit code and stderr", async () => {
    streamViaCli(model, userTurn, opts("exit") as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = procAt(0);
    proc.stderr.emit("data", Buffer.from("Invalid API key\n"));

    proc.exitCode = 1;
    proc.emit("close", 1);
    await vi.advanceTimersByTimeAsync(10);

    const [event] = terminalEvents(0);
    expect(event.type).toBe("error");
    expect(event.error.errorMessage).toBe(
      "Claude CLI exited with code 1: Invalid API key",
    );
    expect(parkedCliProcessCount()).toBe(0);
  });

  it("a CLI that exits silently still ends the stream with an error", async () => {
    streamViaCli(model, userTurn, opts("exit-quiet") as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = procAt(0);

    proc.exitCode = 0;
    proc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(terminalEvents(0)[0].error.errorMessage).toBe(
      "Claude CLI exited unexpectedly with code 0",
    );
  });

  it("a process error (the binary cannot be started) is reported once", async () => {
    streamViaCli(model, userTurn, opts("enoent") as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = procAt(0);

    proc.emit("error", new Error("spawn claude ENOENT"));
    proc.emit("close", -2);
    await vi.advanceTimersByTimeAsync(10);

    const terminal = terminalEvents(0);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].error.errorMessage).toBe("spawn claude ENOENT");
    expect(streamOf(0).end).toHaveBeenCalledTimes(1);
  });

  it("an unsupported CLI version fails the request without spawning", async () => {
    (execSync as any).mockReturnValue(Buffer.from("2.1.100 (Claude Code)"));

    streamViaCli(model, userTurn, opts("old-cli") as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawn).not.toHaveBeenCalled();
    const [event] = terminalEvents(0);
    expect(event.type).toBe("error");
    expect(event.error.errorMessage).toMatch(
      /requires Claude Code 2\.1\.263\+/,
    );
    expect(streamOf(0).end).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ subtype: "error_max_turns" }, "Claude CLI returned error_max_turns"],
    [{ subtype: "success", error: "overloaded" }, "overloaded"],
    [
      { subtype: "error_during_execution", errors: ["first", "second"] },
      "first; second",
    ],
  ])("an error result %j surfaces as %s", async (result, expected) => {
    streamViaCli(model, userTurn, opts("error-result") as any);
    await vi.advanceTimersByTimeAsync(0);

    procAt(0).stdout.write(line({ type: "result", ...result }));
    await vi.advanceTimersByTimeAsync(10);

    const [event] = terminalEvents(0);
    expect(event.type).toBe("error");
    expect(event.error.errorMessage).toBe(expected);
    expect(parkedCliProcessCount()).toBe(0);
  });

  it("stop reason tool_use with no tool call block ends as a plain stop", async () => {
    streamViaCli(model, userTurn, opts("phantom-tool") as any);
    await vi.advanceTimersByTimeAsync(0);

    procAt(0).stdout.write(
      startCycle() +
        text("done") +
        endCycle("tool_use") +
        line({ type: "result", subtype: "success", is_error: false }),
    );
    await vi.advanceTimersByTimeAsync(10);

    const [event] = terminalEvents(0);
    expect(event.type).toBe("done");
    expect(event.reason).toBe("stop");
    expect(event.message.stopReason).toBe("stop");
  });

  it("max_tokens ends the stream with reason length", async () => {
    streamViaCli(model, userTurn, opts("length") as any);
    await vi.advanceTimersByTimeAsync(0);

    procAt(0).stdout.write(
      startCycle() +
        text("cut off") +
        endCycle("max_tokens") +
        line({ type: "result", subtype: "success", is_error: false }),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(terminalEvents(0)[0].reason).toBe("length");
  });
});

describe("toHandoffResult", () => {
  it("passes string content through as one text block", () => {
    expect(toHandoffResult({ content: "plain" })).toEqual({
      content: [{ type: "text", text: "plain" }],
    });
  });

  it("keeps text and image blocks and marks errors", () => {
    expect(
      toHandoffResult({
        isError: true,
        content: [
          { type: "text", text: "failed" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      }),
    ).toEqual({
      isError: true,
      content: [
        { type: "text", text: "failed" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    });
  });

  it("serializes blocks it does not recognise instead of dropping them", () => {
    const result = toHandoffResult({
      content: [null, { type: "resource", uri: "file:///a" }],
    });
    expect(result.content).toEqual([
      { type: "text", text: '{"type":"resource","uri":"file:///a"}' },
    ]);
  });

  it("serializes non-array, non-string content", () => {
    expect(toHandoffResult({ content: { exitCode: 0 } }).content).toEqual([
      { type: "text", text: '{"exitCode":0}' },
    ]);
  });

  it("never returns an empty content array", () => {
    for (const msg of [{}, { content: [] }, { content: null }, undefined]) {
      expect(toHandoffResult(msg).content).toEqual([
        { type: "text", text: "" },
      ]);
    }
  });
});
