import type {
  AssistantMessage,
  Message,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  historyHash,
  piContext,
  piSystemPrompt,
  replayPiMessages,
} from "../src/pi-context";

const user = (content: UserMessage["content"], timestamp = 1): UserMessage => ({
  role: "user",
  content,
  timestamp,
});

const assistant = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  model: "claude-haiku-4-5",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
  ...overrides,
});

const toolResult = (
  text: string,
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
  ...overrides,
});

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: Type.Object({}),
});

describe("pi transcript normalization", () => {
  it("uses current prompt sections and tools, never historical declarations", () => {
    const read = tool("read");
    const write = tool("write");
    const go = user("go");
    const messages: Message[] = [
      {
        role: "system",
        content: "base",
        sections: { rules: "old rules", remove: "old extra" },
        toolsAdded: [read, write],
        timestamp: 0,
      },
      go,
      {
        role: "system",
        content: "",
        sections: { rules: "new rules", remove: null },
        toolsRemoved: [{ name: "write" }],
        timestamp: 2,
      },
    ];
    const context = piContext({ messages });
    expect(context.systemPrompt).toContain("new rules");
    expect(context.systemPrompt).not.toContain("old");
    expect(context.tools.map((t) => t.name)).toEqual(["read"]);
    expect(context.messages).toEqual([go]);
  });

  it("supports legacy Context and an explicitly empty tool set", () => {
    expect(
      piContext({ systemPrompt: "hello", messages: [], tools: [] }),
    ).toEqual({ systemPrompt: "hello", messages: [], tools: [] });
  });

  it("treats a context with no prompt and no tools as empty, not as an error", () => {
    expect(piContext({ messages: [] })).toEqual({
      systemPrompt: "",
      messages: [],
      tools: [],
    });
  });
});

describe("historyHash", () => {
  const history: Message[] = [
    user("hello"),
    assistant([
      { type: "thinking", thinking: "hmm", thinkingSignature: "sig-a" },
      { type: "text", text: "hi", textSignature: "t-1" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
    ]),
    toolResult("file"),
  ];

  it("ignores timestamps, usage, thinking and text signatures", () => {
    const later: Message[] = [
      user("hello", 100),
      assistant(
        [
          { type: "thinking", thinking: "other", thinkingSignature: "sig-b" },
          { type: "text", text: "hi", textSignature: "t-2" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
        ],
        { timestamp: 200, stopReason: "toolUse" },
      ),
      toolResult("file", { timestamp: 300 }),
    ];
    expect(historyHash(later)).toBe(historyHash(history));
  });

  it("changes with any model-visible content", () => {
    const base = historyHash(history);
    const edited = [user("hello, edited"), ...history.slice(1)];
    const failedTool = [
      ...history.slice(0, 2),
      toolResult("file", { isError: true }),
    ];
    const otherArgs = [
      history[0],
      assistant([
        { type: "toolCall", id: "call-1", name: "read", arguments: { p: 2 } },
      ]),
      history[2],
    ];
    expect(historyHash(edited)).not.toBe(base);
    expect(historyHash(failedTool)).not.toBe(base);
    expect(historyHash(otherArgs)).not.toBe(base);
    expect(historyHash(history.slice(0, 2))).not.toBe(base);
  });
});

describe("replayPiMessages", () => {
  it("imports every message in order with role labels, images and tool records", () => {
    const blocks = replayPiMessages([
      user("look at this"),
      user([
        { type: "text", text: "and this" },
        { type: "image", mimeType: "image/png", data: "QUJD" },
      ]),
      assistant([
        { type: "thinking", thinking: "never replayed" },
        { type: "text", text: "reading" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
      ]),
      toolResult("ENOENT", { isError: true }),
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "USER:" },
      { type: "text", text: "look at this" },
      { type: "text", text: "USER:" },
      { type: "text", text: "and this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
      { type: "text", text: "ASSISTANT:" },
      { type: "text", text: "reading" },
      { type: "text", text: 'TOOL CALL read id=call-1: {"p":1}' },
      { type: "text", text: "TOOL RESULT (read, id=call-1, error=true):" },
      { type: "text", text: "ENOENT" },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("never replayed");
  });
});

describe("piSystemPrompt", () => {
  it("keeps pi's prompt verbatim and appends the tool-name binding", () => {
    const prompt = piSystemPrompt("PI PROMPT");
    expect(prompt.startsWith("PI PROMPT\n\n")).toBe(true);
    expect(prompt).toContain("mcp__custom-tools__");
  });
});
