import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// Mock @earendil-works/pi-ai before importing event-bridge
vi.mock("@earendil-works/pi-ai", () => ({
  calculateCost: vi.fn(),
}));

import { createEventBridge } from "../src/event-bridge";
import { claudeToolName, createToolNameMap } from "../src/tool-mapping";
import { calculateCost } from "@earendil-works/pi-ai";

// Helper: create a mock stream that captures pushed events
function createMockStream() {
  const events: unknown[] = [];
  return {
    push: vi.fn((event: unknown) => events.push(event)),
    end: vi.fn(),
    events,
  };
}

// Helper: create a minimal mock model
function createMockModel() {
  return {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    api: "pi-claude-cli",
    provider: "anthropic",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

describe("createEventBridge", () => {
  let stream: ReturnType<typeof createMockStream>;
  let model: ReturnType<typeof createMockModel>;

  beforeEach(() => {
    stream = createMockStream();
    model = createMockModel();
    vi.clearAllMocks();
  });

  // Helper: create bridge and trigger the initial "start" event so tests
  // don't need to account for it in their push call counts.
  function createBridgeWithStart() {
    const bridge = createEventBridge(stream as any, model as any);
    // Trigger start event via message_start
    bridge.handleEvent({ type: "message_start", message: { usage: {} } });
    stream.push.mockClear();
    stream.events.length = 0;
    return bridge;
  }

  it("pushes start event on first handleEvent call", () => {
    const bridge = createEventBridge(stream as any, model as any);
    bridge.handleEvent({ type: "message_start", message: { usage: {} } });

    expect(stream.push).toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));
  });

  describe("text content block streaming", () => {
    it("pushes text_start on content_block_start with text type", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("text_start");
      expect(event.contentIndex).toBe(0);
    });

    it("pushes text_delta on content_block_delta with text_delta type", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });

      expect(stream.push).toHaveBeenCalledTimes(2);
      const event = stream.events[1] as any;
      expect(event.type).toBe("text_delta");
      expect(event.contentIndex).toBe(0);
      expect(event.delta).toBe("Hello");
    });

    it("pushes text_end on content_block_stop with accumulated text", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(4);
      const event = stream.events[3] as any;
      expect(event.type).toBe("text_end");
      expect(event.contentIndex).toBe(0);
      expect(event.content).toBe("Hello world");
    });
  });

  describe("multiple text blocks", () => {
    it("tracks multiple text blocks independently", () => {
      const bridge = createBridgeWithStart();

      // Block 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "First" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Block 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Second" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      // Verify block 0
      const textEnd0 = stream.events[2] as any;
      expect(textEnd0.type).toBe("text_end");
      expect(textEnd0.contentIndex).toBe(0);
      expect(textEnd0.content).toBe("First");

      // Verify block 1
      const textStart1 = stream.events[3] as any;
      expect(textStart1.type).toBe("text_start");
      expect(textStart1.contentIndex).toBe(1);

      const textEnd1 = stream.events[5] as any;
      expect(textEnd1.type).toBe("text_end");
      expect(textEnd1.contentIndex).toBe(1);
      expect(textEnd1.content).toBe("Second");
    });
  });

  describe("message_start usage tracking", () => {
    it("captures initial usage from message_start", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      });

      const output = bridge.getOutput();
      expect(output.usage.input).toBe(100);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(50);
      expect(output.usage.cacheWrite).toBe(25);
      expect(output.usage.totalTokens).toBe(175);
      expect(calculateCost).toHaveBeenCalled();
    });

    it("defaults missing usage fields to 0", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            // output_tokens, cache_read_input_tokens, cache_creation_input_tokens all missing
          },
        },
      });

      const output = bridge.getOutput();
      expect(output.usage.input).toBe(50);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(0);
      expect(output.usage.cacheWrite).toBe(0);
      expect(output.usage.totalTokens).toBe(50);
    });
  });

  describe("message_delta handling", () => {
    it("captures stop_reason from message_delta", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 42 },
      });

      const output = bridge.getOutput();
      expect(output.stopReason).toBe("stop");
    });

    it("updates usage from message_delta", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
          },
        },
      });
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 42 },
      });

      const output = bridge.getOutput();
      expect(output.usage.output).toBe(42);
      // totalTokens is the cycle's PROMPT (what pi reads as context), so the
      // 42 output tokens are billed but do not occupy the window.
      expect(output.usage.totalTokens).toBe(100);
    });
  });

  describe("message_stop (no-op, done pushed by provider)", () => {
    it("does not push done (provider pushes it after readline closes)", () => {
      const bridge = createEventBridge(stream as any, model as any);

      bridge.handleEvent({
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 0 } },
      });
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      });
      bridge.handleEvent({
        type: "message_stop",
      });

      // No done event from event bridge (provider handles it after readline closes)
      const doneEvent = stream.events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeUndefined();
      expect(stream.end).not.toHaveBeenCalled();

      // Output state is correct for provider to use
      const output = bridge.getOutput();
      expect(output.content).toHaveLength(1);
      expect((output.content[0] as any).text).toBe("Hello world");
      expect(output.stopReason).toBe("stop");
    });
  });

  describe("stop reason mapping", () => {
    it("maps end_turn to stop", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
    });

    it("maps max_tokens to length", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      });
      expect(bridge.getOutput().stopReason).toBe("length");
    });

    it("maps tool_use to toolUse", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      });
      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("maps unknown stop reasons to stop", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "something_else" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
    });
  });

  // Observer mode: only HANDOFF tools (custom pi tools behind the MCP
  // schema server) stream as pi toolCalls. Built-ins run natively in the CLI
  // and surface as markers — see the marker and filtering suites.
  describe("tool_use content block streaming (handoff tools)", () => {
    it("pushes toolcall_start with mapped pi name on content_block_start", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "mcp__custom-tools__lookup",
        },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_start");
      expect(event.contentIndex).toBe(0);
      // Tool name should be mapped from Claude "Read" to pi "read"
      expect(event.partial.content[0].name).toBe("lookup");
    });

    it("pushes toolcall_delta with raw JSON fragment on input_json_delta", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "mcp__custom-tools__lookup",
        },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_delta");
      expect(event.delta).toBe('{"file_');
      expect(event.contentIndex).toBe(0);
    });

    it("accumulates partial JSON across multiple deltas", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "mcp__custom-tools__lookup",
        },
      });

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"que' },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ry": "/foo.ts"}' },
      });

      // After full JSON is accumulated, the output content should have parsed args
      const output = bridge.getOutput();
      const toolCall = output.content[0] as any;
      expect(toolCall.type).toBe("toolCall");
      // Arguments should be updated as JSON becomes parseable
      expect(toolCall.arguments).toEqual({ query: "/foo.ts" });
    });

    it("pushes toolcall_end with fully parsed and argument-mapped ToolCall on block_stop", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "mcp__custom-tools__lookup",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/foo.ts"}',
        },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      expect(event.contentIndex).toBe(0);
      expect(event.toolCall.type).toBe("toolCall");
      expect(event.toolCall.id).toBe("toolu_01ABC");
      expect(event.toolCall.name).toBe("lookup");
      // Claude's "query" should be mapped to pi's "path"
      expect(event.toolCall.arguments).toEqual({ query: "/foo.ts" });
    });

    it("tracks multiple tool_use blocks independently by Claude event.index", () => {
      const bridge = createBridgeWithStart();

      // Tool block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__lookup",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/a.ts"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Tool block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_02",
          name: "mcp__custom-tools__store",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/b.ts", "content": "hello"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      // Find toolcall_end events
      const endEvents = stream.events.filter((e: any) => e.type === "toolcall_end") as any[];
      expect(endEvents).toHaveLength(2);
      expect(endEvents[0].toolCall.id).toBe("toolu_01");
      expect(endEvents[0].toolCall.name).toBe("lookup");
      expect(endEvents[0].toolCall.arguments).toEqual({ query: "/a.ts" });
      expect(endEvents[1].toolCall.id).toBe("toolu_02");
      expect(endEvents[1].toolCall.name).toBe("store");
      expect(endEvents[1].toolCall.arguments).toEqual({
        query: "/b.ts",
        content: "hello",
      });
    });

    it("tracks tool_use block interleaved with text block correctly", () => {
      const bridge = createBridgeWithStart();

      // Text block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me read that file." },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Tool block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__lookup",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/foo.ts"}',
        },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);
      expect((output.content[0] as any).type).toBe("text");
      expect((output.content[0] as any).text).toBe("Let me read that file.");
      expect((output.content[1] as any).type).toBe("toolCall");
      expect((output.content[1] as any).name).toBe("lookup");

      // Verify contentIndex values
      const textStart = stream.events.find((e: any) => e.type === "text_start") as any;
      expect(textStart.contentIndex).toBe(0);
      const toolStart = stream.events.find((e: any) => e.type === "toolcall_start") as any;
      expect(toolStart.contentIndex).toBe(1);
    });

    it("handles partial JSON parse failure during delta gracefully (no crash)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__run",
        },
      });

      // Partial JSON that cannot be parsed yet
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command": "ls' },
      });

      // Should not crash -- arguments should still be empty object (previous value)
      const output = bridge.getOutput();
      const toolCall = output.content[0] as any;
      expect(toolCall.arguments).toEqual({});

      // Complete the JSON
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ' -la"}' },
      });

      // Now should be parsed
      expect(toolCall.arguments).toEqual({ command: "ls -la" });
    });

    it("emits toolcall_end with raw string arguments when final JSON parse fails", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__lookup",
        },
      });

      // Send invalid JSON that will never parse
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "not valid json at all",
        },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      // Arguments should be the raw string since JSON parse failed
      expect(event.toolCall.arguments).toBe("not valid json at all");
    });

    /**
     * Claude streams a tool call's arguments as input_json_delta events. A
     * call with NO arguments produces no deltas at all, so the accumulator is
     * still "" when the block stops. JSON.parse("") throws, and the raw ""
     * used to be handed to pi, which rejected it against the tool's schema
     * with `root: must be object`.
     *
     * That killed every zero-argument handoff tool: `mcp({})` — the
     * documented first step for checking MCP status — and `artifact_list()`.
     */
    describe("zero-argument tool calls", () => {
      function runToolCall(
        name: string,
        deltas: string[],
      ): { arguments: unknown; name: string; id: string } {
        const bridge = createBridgeWithStart();
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_01", name },
        });
        for (const partial_json of deltas) {
          bridge.handleEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json },
          });
        }
        stream.push.mockClear();
        stream.events.length = 0;
        bridge.handleEvent({ type: "content_block_stop", index: 0 });
        const event = stream.events[0] as any;
        expect(event.type).toBe("toolcall_end");
        return event.toolCall;
      }

      it('emits {} — not "" — when the model sends no arguments at all', () => {
        const toolCall = runToolCall("mcp__custom-tools__mcp", []);
        expect(toolCall.arguments).toEqual({});
        // The specific regression: a bare string fails pi's schema check.
        expect(typeof toolCall.arguments).toBe("object");
      });

      it("emits {} when the accumulated payload is only whitespace", () => {
        const toolCall = runToolCall("mcp__custom-tools__mcp", ["  ", "\n"]);
        expect(toolCall.arguments).toEqual({});
      });

      it("leaves an explicit {} payload alone", () => {
        const toolCall = runToolCall("mcp__custom-tools__mcp", ["{}"]);
        expect(toolCall.arguments).toEqual({});
      });

      it("makes 'no deltas' and an explicit {} indistinguishable", () => {
        // The whole point of the fix: pi must not be able to tell the two
        // apart, because the model means the same thing by them.
        const noDeltas = runToolCall("mcp__custom-tools__mcp", []);
        const explicit = runToolCall("mcp__custom-tools__mcp", ["{}"]);
        expect(noDeltas.arguments).toEqual(explicit.arguments);
        expect(noDeltas.name).toBe(explicit.name);
      });

      /**
       * The counterpart guarantee. A truncated stream is NOT empty, and its
       * raw text is the only evidence of what arrived — blanking it to {}
       * would turn a visible failure into a tool that silently ran with no
       * arguments. Malformed stays malformed.
       */
      it.each([
        ["truncated object", '{"server": "lin'],
        ["not json at all", "not valid json"],
      ])("keeps the raw string for a malformed payload (%s)", (_label, raw) => {
        const toolCall = runToolCall("mcp__custom-tools__mcp", [raw]);
        expect(toolCall.arguments).toBe(raw);
      });

      /**
       * Valid JSON that is not an object cannot be tool arguments. It must not
       * reach pi as a bare null/array/number — and it must not be silently
       * upgraded to {} either, since that would invent arguments the model
       * never sent.
       */
      it.each([
        ["null", "null"],
        ["array", "[]"],
        ["number", "123"],
        ["string", '"hello"'],
      ])("keeps the raw string for non-object JSON (%s)", (_label, raw) => {
        const toolCall = runToolCall("mcp__custom-tools__mcp", [raw]);
        expect(toolCall.arguments).toBe(raw);
      });

      it("keeps a zero-argument call independent from a neighbour with arguments", () => {
        const bridge = createBridgeWithStart();
        // index 0: zero-argument mcp status check
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_a",
            name: "mcp__custom-tools__mcp",
          },
        });
        // index 1: a call that does carry arguments
        bridge.handleEvent({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_b",
            name: "mcp__custom-tools__lookup",
          },
        });
        bridge.handleEvent({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"query": "/foo.ts"}',
          },
        });
        bridge.handleEvent({ type: "content_block_stop", index: 0 });
        bridge.handleEvent({ type: "content_block_stop", index: 1 });

        const ends = stream.events.filter((e: any) => e.type === "toolcall_end") as any[];
        expect(ends).toHaveLength(2);
        expect(ends.find((e) => e.toolCall.id === "toolu_a").toolCall.arguments).toEqual({});
        expect(ends.find((e) => e.toolCall.id === "toolu_b").toolCall.arguments).toEqual({
          query: "/foo.ts",
        });
      });

      it("shows {} on the streaming partial before any delta arrives", () => {
        const bridge = createBridgeWithStart();
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_01",
            name: "mcp__custom-tools__mcp",
          },
        });
        const toolCall = bridge.getOutput().content[0] as any;
        expect(toolCall.arguments).toEqual({});
      });

      it("does not let non-object JSON corrupt the partial mid-stream", () => {
        const bridge = createBridgeWithStart();
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_01",
            name: "mcp__custom-tools__mcp",
          },
        });
        // "null" parses, but is not a valid argument object.
        bridge.handleEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "null" },
        });
        const toolCall = bridge.getOutput().content[0] as any;
        expect(toolCall.arguments).toEqual({});
      });
    });

    it("getOutput().stopReason is toolUse when stop_reason is tool_use", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__lookup",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/foo"}',
        },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 10 },
      });
      bridge.handleEvent({ type: "message_stop" });

      // Done is now pushed by provider, not event bridge. Check output state.
      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("output.content includes ToolCall objects alongside TextContent", () => {
      const bridge = createBridgeWithStart();

      // Text block
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Reading file..." },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      // Tool block
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "mcp__custom-tools__lookup",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query": "/test.ts"}',
        },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 1 });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);
      expect(output.content[0]).toEqual({
        type: "text",
        text: "Reading file...",
      });
      expect(output.content[1]).toEqual({
        type: "toolCall",
        id: "toolu_01",
        name: "lookup",
        arguments: { query: "/test.ts" },
      });
    });
  });

  describe("thinking and other content block types", () => {
    it("defers thinking_start until plaintext actually arrives", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });

      // Encrypted thinking sends a signature with no plaintext; nothing is
      // materialized yet, so no thinking_start.
      expect(stream.push).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thinking_start" }),
      );

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning" },
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_start",
          contentIndex: 0,
        }),
      );
    });

    it("ignores empty thinking_delta events (encrypted thinking)", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      // Verified live on sonnet-5: empty-string deltas accompany the
      // signature and must not materialize a block.
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "s".repeat(392) },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      expect(bridge.getOutput().content).toHaveLength(0);
      expect(stream.push).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thinking_start" }),
      );
    });

    it("drops encrypted thinking blocks (signature, no plaintext)", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "x".repeat(3096) },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      // Nothing rendered: no thinking events, no empty content block.
      expect(stream.push).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thinking_start" }),
      );
      expect(stream.push).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thinking_end" }),
      );
      expect(bridge.getOutput().content).toHaveLength(0);
    });

    it("keeps a signature that arrives before the plaintext it belongs to", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "real reasoning" },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      const [block] = bridge.getOutput().content as any[];
      expect(block.type).toBe("thinking");
      expect(block.thinking).toBe("real reasoning");
      expect(block.thinkingSignature).toBe("sig-");
    });

    it("keeps content indexes correct when a dropped block precedes real ones", () => {
      const bridge = createBridgeWithStart();

      // Encrypted thinking at index 0 …
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 0 });

      // … followed by real text at index 1.
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      });
      bridge.handleEvent({ type: "content_block_stop", index: 1 });

      const content = bridge.getOutput().content as any[];
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({ type: "text", text: "answer" });
      // The text block owns content index 0, not 1.
      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({ type: "text_end", contentIndex: 0 }),
      );
    });

    it("emits thinking_delta for thinking content", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      stream.push.mockClear();

      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Let me think...",
        }),
      );
    });

    it("accumulates thinking text across multiple deltas", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "First thought. " },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Second thought." },
      });

      const output = bridge.getOutput();
      const thinkingBlock = output.content[0] as any;
      expect(thinkingBlock.thinking).toBe("First thought. Second thought.");
    });

    it("emits thinking_end for thinking block stop", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning here" },
      });
      stream.push.mockClear();

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thinking_end",
          contentIndex: 0,
          content: "reasoning here",
        }),
      );
    });

    it("accumulates signature_delta on thinking block thinkingSignature", () => {
      const bridge = createBridgeWithStart();

      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "some reasoning" },
      });

      // Signature arrives in multiple chunks
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_part1" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_part2" },
      });

      const output = bridge.getOutput();
      const thinkingBlock = output.content[0] as any;
      expect(thinkingBlock.thinkingSignature).toBe("sig_part1sig_part2");
    });

    it("tracks thinking block interleaved with text block correctly", () => {
      const bridge = createBridgeWithStart();

      // Thinking block at index 0
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "deep thought" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig123" },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // Text block at index 1
      bridge.handleEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "The answer is 42." },
      });
      bridge.handleEvent({
        type: "content_block_stop",
        index: 1,
      });

      const output = bridge.getOutput();
      expect(output.content).toHaveLength(2);

      const thinking = output.content[0] as any;
      expect(thinking.type).toBe("thinking");
      expect(thinking.thinking).toBe("deep thought");
      expect(thinking.thinkingSignature).toBe("sig123");

      const text = output.content[1] as any;
      expect(text.type).toBe("text");
      expect(text.text).toBe("The answer is 42.");

      // Verify correct contentIndex values
      const thinkingStart = stream.events.find((e: any) => e.type === "thinking_start") as any;
      expect(thinkingStart.contentIndex).toBe(0);
      const textStart = stream.events.find((e: any) => e.type === "text_start") as any;
      expect(textStart.contentIndex).toBe(1);
    });
  });

  describe("MCP tool names back to pi's", () => {
    it("maps an aliased tool name back to pi's name", () => {
      const bridge = createEventBridge(
        stream as any,
        model as any,
        createToolNameMap(["deploy.prod"]),
      );
      bridge.handleEvent({ type: "message_start", message: { usage: {} } });
      stream.events.length = 0;
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_alias01",
          name: claudeToolName("deploy.prod"),
        },
      });
      expect((stream.events[0] as any).partial.content[0].name).toBe("deploy.prod");
    });

    it("strips mcp__custom-tools__ prefix from tool_use name in toolcall_start", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_mcp01",
          name: "mcp__custom-tools__foo",
        },
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_start");
      // Tool name should be stripped from "mcp__custom-tools__foo" to "foo"
      expect(event.partial.content[0].name).toBe("foo");
    });

    it("strips mcp__custom-tools__ prefix in toolcall_end", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_mcp01",
          name: "mcp__custom-tools__foo",
        },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"target": "prod"}' },
      });
      stream.push.mockClear();
      stream.events.length = 0;

      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      expect(stream.push).toHaveBeenCalledTimes(1);
      const event = stream.events[0] as any;
      expect(event.type).toBe("toolcall_end");
      expect(event.toolCall.name).toBe("foo");
      // Custom tool args pass through unchanged (no argument renames for MCP tools)
      expect(event.toolCall.arguments).toEqual({ target: "prod" });
    });
  });

  describe("internal Claude Code tools are filtered", () => {
    it("skips ToolSearch tool_use blocks (not a pi-known tool)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_ts01",
          name: "ToolSearch",
        },
      });

      // No toolcall_start should be emitted
      expect(stream.push).not.toHaveBeenCalled();
      // No content added to output
      expect(bridge.getOutput().content).toHaveLength(0);
    });

    it("skips Task, Agent, and other internal tools", () => {
      const bridge = createBridgeWithStart();
      for (const internalTool of [
        "Task",
        "TaskOutput",
        "Agent",
        "WebSearch",
        "WebFetch",
        "NotebookEdit",
      ]) {
        bridge.handleEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `toolu_${internalTool}`,
            name: internalTool,
          },
        });
      }
      expect(stream.push).not.toHaveBeenCalled();
    });

    // Observer mode: built-ins execute natively in the CLI and must NOT
    // become pi toolCalls — they surface as markers via the envelope path.
    it("filters built-in tools (Read, Write, etc.) — the CLI executes them", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_read01", name: "Read" },
      });
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("allows handoff tools (mcp__custom-tools__*)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_h01",
          name: "mcp__custom-tools__deploy",
        },
      });
      expect(stream.push).toHaveBeenCalledTimes(1);
      expect((stream.events[0] as any).type).toBe("toolcall_start");
      expect((stream.events[0] as any).partial.content[0].name).toBe("deploy");
    });

    it("silently drops deltas and stop events for filtered tools", () => {
      const bridge = createBridgeWithStart();
      // ToolSearch start (filtered)
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_ts01",
          name: "ToolSearch",
        },
      });
      // Delta for filtered tool (should be ignored)
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"test"}' },
      });
      // Stop for filtered tool (should be ignored)
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });
      // Nothing emitted
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("unknown event types", () => {
    it("silently ignores unknown event types (after start)", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "some_unknown_event",
      });
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("complete text streaming sequence", () => {
    it("produces correct pi event sequence for a full conversation turn", () => {
      const bridge = createEventBridge(stream as any, model as any);

      // 1. message_start
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 150,
            output_tokens: 0,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      });

      // 2. content_block_start
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      // 3. content_block_delta x2
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      });

      // 4. content_block_stop
      bridge.handleEvent({
        type: "content_block_stop",
        index: 0,
      });

      // 5. message_delta
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      });

      // 6. message_stop
      bridge.handleEvent({
        type: "message_stop",
      });

      // Verify event sequence: start, text_start, text_delta x2, text_end (no done — provider pushes it)
      expect(stream.events).toHaveLength(5);
      expect((stream.events[0] as any).type).toBe("start");
      expect((stream.events[1] as any).type).toBe("text_start");
      expect((stream.events[2] as any).type).toBe("text_delta");
      expect((stream.events[2] as any).delta).toBe("Hello");
      expect((stream.events[3] as any).type).toBe("text_delta");
      expect((stream.events[3] as any).delta).toBe(" world");
      expect((stream.events[4] as any).content).toBe("Hello world");

      // Output fully populated for provider to read via getOutput()
      const output = bridge.getOutput();
      expect(output.role).toBe("assistant");
      expect(output.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(output.usage.input).toBe(150);
      expect(output.usage.output).toBe(5);
      expect(output.stopReason).toBe("stop");

      expect(stream.end).not.toHaveBeenCalled();

      expect(calculateCost).toHaveBeenCalled();
    });
  });

  describe("output initialization", () => {
    it("initializes output with correct defaults", () => {
      const bridge = createEventBridge(stream as any, model as any);
      const output = bridge.getOutput();

      expect(output.role).toBe("assistant");
      expect(output.content).toEqual([]);
      expect(output.api).toBe("pi-claude-cli");
      expect(output.provider).toBe("anthropic");
      expect(output.model).toBe("claude-sonnet-4-5-20250929");
      expect(output.stopReason).toBe("stop");
      expect(output.usage.input).toBe(0);
      expect(output.usage.output).toBe(0);
      expect(output.usage.cacheRead).toBe(0);
      expect(output.usage.cacheWrite).toBe(0);
      expect(output.usage.totalTokens).toBe(0);
      expect(output.usage.cost.total).toBe(0);
      expect(typeof output.timestamp).toBe("number");
    });
  });

  describe("stopReason mapping (provider reads via getOutput)", () => {
    it("stopReason is toolUse for tool_use", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      });
      bridge.handleEvent({ type: "message_stop" });

      expect(bridge.getOutput().stopReason).toBe("toolUse");
    });

    it("stopReason is length for max_tokens", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      });
      bridge.handleEvent({ type: "message_stop" });

      expect(bridge.getOutput().stopReason).toBe("length");
    });
  });

  describe("delta without matching block", () => {
    it("handles text_delta arriving with no matching block (index mismatch)", () => {
      const bridge = createBridgeWithStart();
      // Send a delta for index 5 without any block_start
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 5,
          delta: { type: "text_delta", text: "orphan text" },
        });
      }).not.toThrow();
      // No event should be pushed for the orphan delta
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles input_json_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 99,
          delta: { type: "input_json_delta", partial_json: '{"key":"val"}' },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles thinking_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 42,
          delta: { type: "thinking_delta", thinking: "orphan thought" },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles signature_delta arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_delta",
          index: 7,
          delta: { type: "signature_delta", signature: "sig_orphan" },
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it("handles content_block_stop arriving with no matching block", () => {
      const bridge = createBridgeWithStart();
      expect(() => {
        bridge.handleEvent({
          type: "content_block_stop",
          index: 10,
        });
      }).not.toThrow();
      expect(stream.push).not.toHaveBeenCalled();
    });
  });

  describe("unknown content block type in content_block_start", () => {
    it("silently ignores unknown content block types", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "some_new_type" },
      });
      // No event pushed and no crash
      expect(stream.push).not.toHaveBeenCalled();
      expect(bridge.getOutput().content).toHaveLength(0);
    });
  });

  describe("message_delta without usage", () => {
    it("handles message_delta with stop_reason but no usage", () => {
      const bridge = createBridgeWithStart();
      bridge.handleEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      });
      expect(bridge.getOutput().stopReason).toBe("stop");
      // Usage should remain at defaults
      expect(bridge.getOutput().usage.output).toBe(0);
    });
  });

  describe("applyResult accounting", () => {
    /**
     * `result.usage` is the main agent only. Sub-agents run inside the CLI,
     * never appear in the parent stream, and show up only in `modelUsage` —
     * so billing from `usage` hid the majority of a fan-out turn's spend.
     */
    it("bills sub-agent spend from modelUsage, not the main-agent usage", () => {
      const bridge = createBridgeWithStart();
      bridge.applyResult({
        type: "result",
        subtype: "success",
        // Main agent alone.
        usage: {
          input_tokens: 4,
          output_tokens: 342,
          cache_read_input_tokens: 74562,
          cache_creation_input_tokens: 26808,
        },
        // Main agent + one synchronous sub-agent on the same model, plus the
        // haiku auto-titler. Real figures from a captured episode.
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 8,
            outputTokens: 576,
            cacheReadInputTokens: 102641,
            cacheCreationInputTokens: 56920,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 1352,
            outputTokens: 16,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });

      const usage = bridge.getOutput().usage;
      expect(usage.input).toBe(8 + 1352);
      expect(usage.output).toBe(576 + 16);
      expect(usage.cacheRead).toBe(102641);
      expect(usage.cacheWrite).toBe(56920);
      // The old behaviour: the sub-agent's 28,079 cache-read tokens missing.
      expect(usage.cacheRead).not.toBe(74562);
    });

    it("falls back to result.usage when the CLI sends no modelUsage", () => {
      const bridge = createBridgeWithStart();
      bridge.applyResult({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 4,
          output_tokens: 342,
          cache_read_input_tokens: 74562,
          cache_creation_input_tokens: 26808,
        },
      });

      const usage = bridge.getOutput().usage;
      expect(usage.input).toBe(4);
      expect(usage.cacheRead).toBe(74562);
      expect(usage.cacheWrite).toBe(26808);
    });

    it("ignores an empty modelUsage object rather than zeroing the bill", () => {
      const bridge = createBridgeWithStart();
      bridge.applyResult({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 4, cache_read_input_tokens: 74562 },
        modelUsage: {},
      });
      expect(bridge.getOutput().usage.cacheRead).toBe(74562);
    });

    it("keeps the last cycle's context when the result clears the cycle", () => {
      const bridge = createEventBridge(stream as any, model as any);
      bridge.handleEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 8,
            cache_read_input_tokens: 28096,
            cache_creation_input_tokens: 139,
          },
        },
      });
      bridge.applyResult({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 28,
          output_tokens: 429,
          cache_read_input_tokens: 64055,
          cache_creation_input_tokens: 17662,
        },
      });
      // Context is the cycle's prompt, not the episode's summed billing.
      expect(bridge.getOutput().usage.totalTokens).toBe(8 + 28096 + 139);
    });
  });

  /**
   * Tool result forwarding (PI_CLAUDE_CLI_TOOL_RESULTS=1).
   *
   * Observer mode makes the CLI execute its own tools; pi sees a call marker
   * and, historically, nothing else — the `user` envelopes carrying each
   * `tool_result` were dropped, so a front-end could show WHAT was invoked
   * but never what came back, and its rows had nothing to expand into.
   *
   * With the host opt-in set, two richer marker shapes go on the wire:
   *
   *   [Claude Code · <ToolName> #<toolUseId> <argsJson>]   (id-tagged call)
   *   [Claude Code · result #<toolUseId> <payloadJson>]    (its result)
   *
   * payloadJson is COMPLETE JSON: {status, preview, length, truncated?}.
   * Without the flag the wire is byte-identical to before — a host that has
   * not opted in must see no change at all.
   */
});
