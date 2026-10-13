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
  structuredReplay,
} from "../src/pi-context";
import { assistantReplayLine, userMessageLine } from "../src/cli-protocol";
import { isClaudeToolUseId } from "../src/tool-call-id";

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

describe("structuredReplay", () => {
  const FOREIGN_ID = `call_${"x".repeat(80)}|fc_1`;
  const freeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };

  it("replays the history as messages, with real tool calls and results", () => {
    const frames = structuredReplay([
      user("look at this"),
      user([
        { type: "text", text: "and this" },
        { type: "image", mimeType: "image/png", data: "QUJD" },
      ]),
      assistant([
        { type: "thinking", thinking: "not replayed" },
        { type: "text", text: "reading" },
        {
          type: "toolCall",
          id: "toolu_01a",
          name: "read",
          arguments: { p: 1 },
        },
      ]),
      toolResult("ENOENT", { toolCallId: "toolu_01a", isError: true }),
      assistant([{ type: "text", text: "it is missing" }]),
      user("thanks"),
    ]);
    expect(frames).toEqual([
      {
        kind: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "text", text: "and this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "QUJD" },
          },
        ],
      },
      {
        kind: "assistant",
        content: [
          { type: "text", text: "reading" },
          {
            type: "tool_use",
            id: "toolu_01a",
            name: "mcp__custom-tools__read",
            input: { p: 1 },
          },
        ],
      },
      {
        kind: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01a",
            content: [{ type: "text", text: "ENOENT" }],
            is_error: true,
          },
        ],
      },
      { kind: "assistant", content: [{ type: "text", text: "it is missing" }] },
      { kind: "user", content: [{ type: "text", text: "thanks" }] },
    ]);
    expect(JSON.stringify(frames)).not.toContain("not replayed");
  });

  it("maps a tool call id Claude rejects to one valid id on both sides", () => {
    const frames = structuredReplay([
      user("go"),
      assistant(
        [{ type: "toolCall", id: FOREIGN_ID, name: "read", arguments: {} }],
        { api: "openai-responses", provider: "openai", model: "gpt" },
      ),
      toolResult("file", { toolCallId: FOREIGN_ID }),
    ]);
    const call = frames?.[1]?.content[0];
    const result = frames?.[2]?.content[0];
    if (call?.type !== "tool_use" || result?.type !== "tool_result")
      throw new Error(`unexpected frames: ${JSON.stringify(frames)}`);
    expect(call.id).not.toBe(FOREIGN_ID);
    expect(isClaudeToolUseId(call.id)).toBe(true);
    expect(result.tool_use_id).toBe(call.id);
  });

  it("never changes pi's messages or the ids pi stored", () => {
    const messages = freeze<Message[]>([
      user("go"),
      assistant([
        { type: "toolCall", id: FOREIGN_ID, name: "read", arguments: { p: 1 } },
      ]),
      toolResult("file", { toolCallId: FOREIGN_ID }),
    ]);
    const before = JSON.stringify(messages);
    expect(() => structuredReplay(messages)).not.toThrow();
    expect(JSON.stringify(messages)).toBe(before);
    expect(before).toContain(FOREIGN_ID);
  });

  it("answers a tool call that has no result, before the next user text", () => {
    const frames = structuredReplay([
      user("go"),
      assistant([
        { type: "toolCall", id: "toolu_01a", name: "read", arguments: {} },
        { type: "toolCall", id: "toolu_01b", name: "bash", arguments: {} },
      ]),
      toolResult("only this one", { toolCallId: "toolu_01b" }),
      user("never mind"),
    ]);
    expect(frames?.[2]).toEqual({
      kind: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01b",
          content: [{ type: "text", text: "only this one" }],
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_01a",
          content: [{ type: "text", text: "No result provided" }],
          is_error: true,
        },
        { type: "text", text: "never mind" },
      ],
    });
  });

  it("leaves out failed and aborted turns and keeps their results as records", () => {
    const frames = structuredReplay([
      user("go"),
      assistant(
        [{ type: "toolCall", id: "toolu_01a", name: "read", arguments: {} }],
        { stopReason: "aborted" },
      ),
      toolResult("late", { toolCallId: "toolu_01a" }),
      assistant([{ type: "text", text: "partial" }], { stopReason: "error" }),
      user("again"),
    ]);
    expect(frames).toEqual([
      {
        kind: "user",
        content: [
          { type: "text", text: "go" },
          {
            type: "text",
            text: "TOOL RESULT (read, id=toolu_01a, error=false):",
          },
          { type: "text", text: "late" },
          { type: "text", text: "again" },
        ],
      },
    ]);
  });

  it("sends an object for arguments that did not arrive as one", () => {
    const frames = structuredReplay([
      user("go"),
      assistant([
        {
          type: "toolCall",
          id: "toolu_01a",
          name: "read",
          arguments: '{"broken' as unknown as Record<string, never>,
        },
      ]),
      toolResult("refused", { toolCallId: "toolu_01a", isError: true }),
    ]);
    expect(frames?.[1]?.content[0]).toMatchObject({ input: {} });
  });

  it("drops empty text and gives an empty tool result one empty text block", () => {
    const frames = structuredReplay([
      user("go"),
      assistant([
        { type: "text", text: "" },
        { type: "toolCall", id: "toolu_01a", name: "read", arguments: {} },
      ]),
      { ...toolResult(""), toolCallId: "toolu_01a", content: [] },
      user(""),
      user([{ type: "text", text: "" }]),
    ]);
    expect(frames?.[1]?.content).toHaveLength(1);
    expect(frames?.[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_01a",
        content: [{ type: "text", text: "" }],
        is_error: false,
      },
    ]);
  });

  it("declines a history that messages cannot express", () => {
    // Nothing for the model to answer.
    expect(structuredReplay([])).toBeUndefined();
    expect(
      structuredReplay([user("go"), assistant([{ type: "text", text: "a" }])]),
    ).toBeUndefined();
    // No user message first.
    expect(
      structuredReplay([assistant([{ type: "text", text: "a" }]), user("b")]),
    ).toBeUndefined();
    // Two assistant turns in a row.
    expect(
      structuredReplay([
        user("go"),
        assistant([{ type: "text", text: "a" }]),
        assistant([{ type: "text", text: "b" }]),
        user("c"),
      ]),
    ).toBeUndefined();
  });
});

describe("history import lines", () => {
  it("holds a replayed user message and lets the last one start the turn", () => {
    const content = [{ type: "text" as const, text: "hi" }];
    expect(JSON.parse(userMessageLine(content, { hold: true }))).toEqual({
      type: "user",
      message: { role: "user", content },
      shouldQuery: false,
    });
    expect(JSON.parse(userMessageLine(content))).toEqual({
      type: "user",
      message: { role: "user", content },
    });
  });

  it("names the process's model on a replayed assistant message", () => {
    const content = [{ type: "text" as const, text: "hello" }];
    expect(
      JSON.parse(assistantReplayLine("claude-haiku-4-5", content)),
    ).toEqual({
      type: "assistant",
      message: { role: "assistant", model: "claude-haiku-4-5", content },
    });
  });
});

describe("piSystemPrompt", () => {
  it("keeps pi's prompt verbatim and appends the tool-name binding", () => {
    const prompt = piSystemPrompt("PI PROMPT");
    expect(prompt.startsWith("PI PROMPT\n\n")).toBe(true);
    expect(prompt).toContain("mcp__custom-tools__");
  });
});
