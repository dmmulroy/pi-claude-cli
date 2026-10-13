import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createToolCallIdMap,
  isClaudeToolUseId,
  toolCallIdsOf,
} from "../src/tool-call-id";

/** An OpenAI Responses id: far too long, and with a `|`. */
const RESPONSES_ID = `call_${"a".repeat(40)}|fc_${"b".repeat(400)}`;

describe("isClaudeToolUseId", () => {
  it("accepts what the Anthropic API accepts", () => {
    expect(isClaudeToolUseId("toolu_01A9bcDEF-xyz_3")).toBe(true);
    expect(isClaudeToolUseId("call_abc123")).toBe(true);
    expect(isClaudeToolUseId("a".repeat(64))).toBe(true);
  });

  it("rejects other characters, the empty id and ids over 64 characters", () => {
    expect(isClaudeToolUseId("call_abc|fc_1")).toBe(false);
    expect(isClaudeToolUseId("call.abc")).toBe(false);
    expect(isClaudeToolUseId("call abc")).toBe(false);
    expect(isClaudeToolUseId("functions.read:0")).toBe(false);
    expect(isClaudeToolUseId("")).toBe(false);
    expect(isClaudeToolUseId("a".repeat(65))).toBe(false);
  });
});

describe("createToolCallIdMap", () => {
  it("leaves an id Claude accepts as it is, both ways", () => {
    const ids = createToolCallIdMap(["toolu_01abc"]);
    expect(ids.toClaude("toolu_01abc")).toBe("toolu_01abc");
    expect(ids.toPi("toolu_01abc")).toBe("toolu_01abc");
  });

  it("replaces an id Claude rejects with a valid one and maps it back", () => {
    for (const piId of [
      RESPONSES_ID,
      "call_abc|fc_1",
      "functions.read:0",
      "",
      "a".repeat(65),
      "ünïcödé",
    ]) {
      const ids = createToolCallIdMap([piId]);
      const claudeId = ids.toClaude(piId);
      expect(claudeId).not.toBe(piId);
      expect(isClaudeToolUseId(claudeId)).toBe(true);
      expect(ids.toPi(claudeId)).toBe(piId);
    }
  });

  it("round-trips every id of a mixed conversation without collisions", () => {
    const piIds = [
      "toolu_01abc",
      RESPONSES_ID,
      `${RESPONSES_ID}x`,
      "call_abc|fc_1",
      "call_abc|fc_2",
      "call_abc_fc_1",
    ];
    const ids = createToolCallIdMap(piIds);
    const claudeIds = piIds.map(ids.toClaude);
    expect(new Set(claudeIds).size).toBe(piIds.length);
    expect(claudeIds.every(isClaudeToolUseId)).toBe(true);
    expect(claudeIds.map(ids.toPi)).toEqual(piIds);
  });

  it("derives the same id for the same pi id in every conversation", () => {
    const first = createToolCallIdMap([RESPONSES_ID]).toClaude(RESPONSES_ID);
    const later = createToolCallIdMap([
      "toolu_other",
      "call_x|y",
      RESPONSES_ID,
    ]).toClaude(RESPONSES_ID);
    expect(later).toBe(first);
  });

  it("never gives a derived id that a valid pi id already uses", () => {
    const derived = createToolCallIdMap([RESPONSES_ID]).toClaude(RESPONSES_ID);
    // pi's history already holds that very string as a real tool call id.
    const ids = createToolCallIdMap([RESPONSES_ID, derived]);
    expect(ids.toClaude(derived)).toBe(derived);
    expect(ids.toClaude(RESPONSES_ID)).not.toBe(derived);
    expect(isClaudeToolUseId(ids.toClaude(RESPONSES_ID))).toBe(true);
    expect(ids.toPi(ids.toClaude(RESPONSES_ID))).toBe(RESPONSES_ID);
    expect(ids.toPi(derived)).toBe(derived);
  });

  it("passes through ids it was never told about", () => {
    const ids = createToolCallIdMap([]);
    // A new call Claude just made: pi stores Claude's id unchanged.
    expect(ids.toPi("toolu_01new")).toBe("toolu_01new");
    expect(ids.toClaude("toolu_01new")).toBe("toolu_01new");
    expect(isClaudeToolUseId(ids.toClaude("bad|id"))).toBe(true);
  });
});

describe("toolCallIdsOf", () => {
  const assistant = (
    content: AssistantMessage["content"],
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: "pi-claude-cli",
    provider: "pi-claude-cli",
    model: "claude-haiku-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  });

  it("collects the ids of tool calls and of tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "go", timestamp: 0 },
      assistant([
        { type: "text", text: "reading" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "toolCall", id: "call|2", name: "read", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "orphan|3",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: 2,
      },
    ];
    expect(toolCallIdsOf(messages)).toEqual(["call-1", "call|2", "orphan|3"]);
  });
});
