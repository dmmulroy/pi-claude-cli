import { describe, expect, it } from "vitest";
import {
  historyHash,
  piContext,
  piSystemPrompt,
  replayPiMessages,
} from "../src/pi-context";

describe("pi 0.87 transcript normalization", () => {
  it("uses current prompt sections and tools, never historical declarations", () => {
    const read = {
      name: "read",
      description: "Read",
      parameters: { type: "object" },
    };
    const write = {
      name: "write",
      description: "Write",
      parameters: { type: "object" },
    };
    const user = { role: "user", content: "go" };
    const context = piContext({
      messages: [
        {
          role: "system",
          content: "base",
          sections: { rules: "old rules", remove: "old extra" },
          toolsAdded: [read, write],
        },
        user,
        {
          role: "system",
          content: "",
          sections: { rules: "new rules", remove: null },
          toolsRemoved: [{ name: "write" }],
        },
      ],
    });
    expect(context.systemPrompt).toContain("new rules");
    expect(context.systemPrompt).not.toContain("old");
    expect(context.tools.map((t: any) => t.name)).toEqual(["read"]);
    expect(context.messages).toEqual([user]);
  });

  it("supports legacy Context and an explicitly empty tool set", () => {
    expect(
      piContext({ systemPrompt: "hello", messages: [], tools: [] }),
    ).toEqual({ systemPrompt: "hello", messages: [], tools: [] });
  });
});

describe("historyHash", () => {
  const history = [
    { role: "user", content: "hello", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig-a" },
        { type: "text", text: "hi", textSignature: "t-1" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
      ],
      usage: { input: 1 },
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      isError: false,
      timestamp: 3,
    },
  ];

  it("ignores timestamps, usage, thinking and text signatures", () => {
    const later = [
      { ...history[0], timestamp: 100 },
      {
        ...history[1],
        content: [
          { type: "thinking", thinking: "other", thinkingSignature: "sig-b" },
          { type: "text", text: "hi", textSignature: "t-2" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
        ],
        usage: { input: 999 },
        timestamp: 200,
      },
      { ...history[2], timestamp: 300 },
    ];
    expect(historyHash(later)).toBe(historyHash(history));
  });

  it("changes with any model-visible content", () => {
    const base = historyHash(history);
    const edited = [
      { ...history[0], content: "hello, edited" },
      ...history.slice(1),
    ];
    const failedTool = [
      ...history.slice(0, 2),
      { ...history[2], isError: true },
    ];
    const otherArgs = [
      history[0],
      {
        ...history[1],
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { p: 2 } },
        ],
      },
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
      { role: "user", content: "look at this" },
      {
        role: "user",
        content: [
          { type: "text", text: "and this" },
          { type: "image", mimeType: "image/png", data: "QUJD" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "never replayed" },
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { p: 1 } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "ENOENT" }],
      },
      { role: "user" },
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
      { type: "text", text: "USER:" },
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
