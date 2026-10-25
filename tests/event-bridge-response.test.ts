/**
 * What the event bridge records about the response beyond its content:
 * stop reasons, the response id, the usage breakdown, the limit status, the
 * thinking level, and whether the stream matches the CLI's own record.
 */

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@earendil-works/pi-ai", () => ({ calculateCost: vi.fn() }));

import type { ClaudeApiEvent } from "../src/cli-protocol";
import { createEventBridge, mapStopReason, RATE_LIMIT_DIAGNOSTIC } from "../src/event-bridge";

const model = {
  id: "claude-sonnet-5",
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function bridgeOf(events: ReadonlyArray<ClaudeApiEvent> = []) {
  const stream = { push: vi.fn(), end: vi.fn() };
  const bridge = createEventBridge(stream as never, model as never);
  for (const event of events) bridge.handleEvent(event);
  return bridge;
}

const start = (id: string, usage: ClaudeApiEvent["usage"] = {}) =>
  ({ type: "message_start", message: { id, usage } }) as const;
const text = (index: number, value: string): ClaudeApiEvent[] => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: value },
  },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, id: string, json: string): ClaudeApiEvent[] => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: "mcp__custom-tools__read" },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: json },
  },
  { type: "content_block_stop", index },
];
const end = (stop_reason: string, usage: ClaudeApiEvent["usage"] = {}) =>
  ({ type: "message_delta", delta: { stop_reason }, usage }) as const;

describe("mapStopReason", () => {
  it.each([
    ["end_turn", "stop"],
    ["pause_turn", "stop"],
    ["stop_sequence", "stop"],
    ["something_new", "stop"],
    ["tool_use", "toolUse"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
  ])("maps %s to %s", (reason, expected) => {
    expect(mapStopReason(reason)).toEqual({ stopReason: expected });
  });

  it("makes a refusal an error, with the API's explanation when it has one", () => {
    expect(mapStopReason("refusal", "Not this.")).toEqual({
      stopReason: "error",
      errorMessage: "Not this.",
    });
    for (const explanation of [undefined, null, ""])
      expect(mapStopReason("refusal", explanation).errorMessage).toBe(
        "The model refused to complete the request",
      );
  });

  it("makes a safety stop an error", () => {
    expect(mapStopReason("sensitive")).toEqual({
      stopReason: "error",
      errorMessage: "Provider stopped with: sensitive",
    });
  });
});

describe("the response's fields", () => {
  it("records the last API message's id and its raw stop reason", () => {
    const output = bridgeOf([
      start("msg_1"),
      ...text(0, "first"),
      end("tool_use"),
      start("msg_2"),
      ...text(0, "second"),
      end("end_turn"),
    ]).getOutput();
    expect(output.responseId).toBe("msg_2");
    expect(output.rawStopReason).toBe("end_turn");
    expect(output.stopReason).toBe("stop");
    expect(output.errorMessage).toBeUndefined();
  });

  it("keeps a refusal's message on the output, and clears it when a later cycle ends normally", () => {
    const bridge = bridgeOf([
      start("msg_1"),
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { explanation: "No." },
        },
      },
    ]);
    expect(bridge.getOutput()).toMatchObject({
      stopReason: "error",
      errorMessage: "No.",
      rawStopReason: "refusal",
    });
    bridge.handleEvent(start("msg_2"));
    bridge.handleEvent(end("end_turn"));
    expect(bridge.getOutput().errorMessage).toBeUndefined();
  });

  it("sums the 1h cache write and the thinking tokens over cycles", () => {
    const output = bridgeOf([
      start("msg_1", {
        input_tokens: 2,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 500 },
      }),
      end("tool_use", {
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 30 },
      }),
      start("msg_2", {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 60 },
      }),
      end("end_turn", {
        output_tokens: 10,
        output_tokens_details: { thinking_tokens: 5 },
      }),
    ]).getOutput();
    expect(output.usage.cacheWrite).toBe(600);
    expect(output.usage.cacheWrite1h).toBe(560);
    expect(output.usage.output).toBe(50);
    expect(output.usage.reasoning).toBe(35);
  });

  it("takes a 1h split reported on message_delta, as pi's own provider does", () => {
    const output = bridgeOf([
      start("msg_1", { cache_creation_input_tokens: 80 }),
      end("end_turn", {
        cache_creation_input_tokens: 80,
        cache_creation: { ephemeral_1h_input_tokens: 80 },
      }),
    ]).getOutput();
    expect(output.usage.cacheWrite1h).toBe(80);
  });

  it("leaves the breakdown out when the API does not report it", () => {
    const output = bridgeOf([
      start("msg_1", { input_tokens: 3 }),
      end("end_turn", { output_tokens: 4 }),
    ]).getOutput();
    expect(output.usage.cacheWrite1h).toBeUndefined();
    expect(output.usage.reasoning).toBeUndefined();
  });

  it("never reports more of a subset than the authoritative total", () => {
    const bridge = bridgeOf([
      start("msg_1", {
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 500 },
      }),
      end("end_turn", {
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 30 },
      }),
    ]);
    bridge.applyResult({
      usage: {
        input_tokens: 1,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 300,
      },
    });
    const output = bridge.getOutput();
    expect(output.usage.cacheWrite1h).toBe(300);
    expect(output.usage.reasoning).toBe(20);
  });

  it("sets and clears the provider's thinking level", () => {
    const bridge = bridgeOf();
    bridge.setProviderThinkingLevel("high");
    expect(bridge.getOutput().providerThinkingLevel).toBe("high");
    bridge.setProviderThinkingLevel(undefined);
    expect("providerThinkingLevel" in bridge.getOutput()).toBe(false);
  });

  it("keeps the latest limit status as one diagnostic, with only its known fields", () => {
    const bridge = bridgeOf();
    bridge.recordRateLimit({ status: "allowed", isUsingOverage: false }, 1);
    bridge.recordRateLimit(
      {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: 1_792_971_000,
        isUsingOverage: true,
        overageStatus: null,
      },
      2,
    );
    const diagnostics = bridge.getOutput().diagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: RATE_LIMIT_DIAGNOSTIC,
      timestamp: 2,
      details: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: 1_792_971_000,
        isUsingOverage: true,
      },
    });
    expect(diagnostics[0]?.details).not.toHaveProperty("overageStatus");
  });
});

describe("checking the stream against the CLI's record", () => {
  /** A message of text and one tool call, as streamed. */
  const streamed = (): ClaudeApiEvent[] => [
    start("msg_1"),
    ...text(0, "Reading."),
    ...toolUse(1, "toolu_1", '{"path":"a.txt","depth":1}'),
    end("tool_use"),
    { type: "message_stop" },
  ];
  const recordedText = { type: "text", text: "Reading." };
  const recordedTool = {
    type: "tool_use",
    id: "toolu_1",
    name: "mcp__custom-tools__read",
    input: { depth: 1, path: "a.txt" },
  };

  it("finds nothing when the stream is what the CLI recorded, in any key order", () => {
    const bridge = bridgeOf(streamed());
    bridge.recordAssistantBlocks("msg_1", [recordedText]);
    bridge.recordAssistantBlocks("msg_1", [recordedTool]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("finds nothing without a record, or for a record of another message", () => {
    const bridge = bridgeOf(streamed());
    expect(bridge.streamMismatch()).toBeUndefined();
    bridge.recordAssistantBlocks("msg_other", [{ type: "text", text: "x" }]);
    expect(bridge.streamMismatch()).toBeUndefined();
    expect(bridgeOf([...text(0, "no id")]).streamMismatch()).toBeUndefined();
  });

  it("ignores thinking, empty text and tools that are not pi's", () => {
    const bridge = bridgeOf(streamed());
    bridge.recordAssistantBlocks("msg_1", [
      { type: "thinking" },
      { type: "text", text: "" },
      recordedText,
      { type: "tool_use", id: "toolu_x", name: "Bash", input: {} },
      recordedTool,
    ]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("ignores whitespace-only text and whitespace around text, on either side", () => {
    const bridge = bridgeOf([
      start("msg_1"),
      ...text(0, "\n\n"),
      ...text(1, "Reading.\n"),
      ...toolUse(2, "toolu_1", '{"path":"a.txt","depth":1}'),
    ]);
    bridge.recordAssistantBlocks("msg_1", [
      { type: "text", text: " Reading." },
      { type: "text", text: "  " },
      recordedTool,
    ]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("accepts a record that trails the stream", () => {
    const bridge = bridgeOf(streamed());
    bridge.recordAssistantBlocks("msg_1", [recordedText]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("reports a block the stream lost", () => {
    const bridge = bridgeOf([start("msg_1"), ...text(0, "Reading.")]);
    bridge.recordAssistantBlocks("msg_1", [recordedText, recordedTool]);
    expect(bridge.streamMismatch()).toMatch(/carried 1 of the 2 blocks/);
  });

  it.each([
    ["different text", [{ ...recordedText, text: "Writing." }, recordedTool]],
    ["text where a tool call was", [recordedText, recordedText]],
    ["another tool call id", [recordedText, { ...recordedTool, id: "toolu_2" }]],
    ["another tool", [recordedText, { ...recordedTool, name: "mcp__custom-tools__bash" }]],
    ["other arguments", [recordedText, { ...recordedTool, input: { path: "b.txt", depth: 1 } }]],
    ["a tool call where text was", [recordedTool, recordedTool]],
  ])("reports %s", (_, record) => {
    const bridge = bridgeOf(streamed());
    bridge.recordAssistantBlocks("msg_1", record);
    expect(bridge.streamMismatch()).toMatch(/differs from the Claude CLI/);
  });

  it("leaves arguments that did not arrive as an object to pi", () => {
    const bridge = bridgeOf([start("msg_1"), ...toolUse(0, "toolu_1", '{"path": "a.t')]);
    bridge.recordAssistantBlocks("msg_1", [recordedTool]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("compares a record without input as empty arguments", () => {
    const bridge = bridgeOf([start("msg_1"), ...toolUse(0, "toolu_1", "")]);
    const { input: _input, ...withoutInput } = recordedTool;
    bridge.recordAssistantBlocks("msg_1", [withoutInput]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });

  it("checks the current API message only", () => {
    const bridge = bridgeOf([...streamed(), start("msg_2"), ...text(0, "Done.")]);
    bridge.recordAssistantBlocks("msg_1", [{ type: "text", text: "stale" }]);
    bridge.recordAssistantBlocks("msg_2", [{ type: "text", text: "Done." }]);
    expect(bridge.streamMismatch()).toBeUndefined();
  });
});
