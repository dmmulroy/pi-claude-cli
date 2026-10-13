import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({ calculateCost: vi.fn() }));

import type { ClaudeApiEvent } from "../src/cli-protocol";
import { createEventBridge } from "../src/event-bridge";
import { structuredReplay } from "../src/pi-context";
import {
  assistantContentFingerprint,
  PROVIDER_METADATA_KEY,
  readSignedThinking,
  replayableSignedThinking,
  type SignedThinking,
  writeSignedThinking,
} from "../src/signed-thinking";

const MODEL = "claude-haiku-4-5";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Run stream events through the bridge and return pi's finished message. */
function bridged(
  events: ReadonlyArray<ClaudeApiEvent>,
  modelId = MODEL,
): AssistantMessage {
  const stream = { push: vi.fn(), end: vi.fn() };
  const model = {
    id: modelId,
    provider: "pi-claude-cli",
    api: "pi-claude-cli",
  };
  const bridge = createEventBridge(stream as never, model as never);
  for (const event of events) bridge.handleEvent(event);
  return bridge.getOutput();
}

const start = (index: number, content_block: ClaudeApiEvent["content_block"]) =>
  ({ type: "content_block_start", index, content_block }) as const;
const delta = (index: number, value: NonNullable<ClaudeApiEvent["delta"]>) =>
  ({ type: "content_block_delta", index, delta: value }) as const;
const stop = (index: number) =>
  ({ type: "content_block_stop", index }) as const;
const messageStart = { type: "message_start", message: { usage: {} } } as const;

/** thinking (signed, with a summary), text, and one tool call. */
const signedTurn: ClaudeApiEvent[] = [
  messageStart,
  start(0, { type: "thinking" }),
  delta(0, { type: "thinking_delta", thinking: "Let me " }),
  delta(0, { type: "thinking_delta", thinking: "read it." }),
  delta(0, { type: "signature_delta", signature: "SIG-" }),
  delta(0, { type: "signature_delta", signature: "ONE" }),
  stop(0),
  start(1, { type: "text", text: "" }),
  delta(1, { type: "text_delta", text: "Reading." }),
  stop(1),
  start(2, {
    type: "tool_use",
    id: "toolu_01a",
    name: "mcp__custom-tools__read",
  }),
  delta(2, { type: "input_json_delta", partial_json: '{"path":"a.txt"}' }),
  stop(2),
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 0,
});
const toolResult = (toolCallId: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

/** What pi does with a message: write it to a session file and read it back. */
const persisted = <T>(message: T): T => JSON.parse(JSON.stringify(message));

const assistantFrame = (messages: ReadonlyArray<Message>, modelId = MODEL) =>
  structuredReplay(messages, modelId)?.find(
    (frame) => frame.kind === "assistant",
  )?.content;

describe("capturing signed thinking", () => {
  it("stores the raw block, its position, the model and a fingerprint", () => {
    const message = bridged(signedTurn);
    expect(readSignedThinking(message)).toEqual({
      model: MODEL,
      fingerprint: assistantContentFingerprint(message.content),
      blocks: [
        {
          at: 0,
          block: {
            type: "thinking",
            thinking: "Let me read it.",
            signature: "SIG-ONE",
          },
        },
      ],
    });
    // pi's own content is what it always was.
    expect(message.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "toolCall",
    ]);
  });

  it("keeps the metadata under one namespaced key that survives JSON", () => {
    const message = persisted(bridged(signedTurn));
    expect(Object.keys(message)).toContain(PROVIDER_METADATA_KEY);
    expect(readSignedThinking(message)?.blocks).toHaveLength(1);
  });

  it("stores encrypted thinking that pi has nothing to show for", () => {
    const message = bridged([
      messageStart,
      start(0, { type: "thinking" }),
      delta(0, { type: "thinking_delta", thinking: "" }),
      delta(0, { type: "signature_delta", signature: "ENCRYPTED" }),
      stop(0),
      start(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "Done." }),
      stop(1),
    ]);
    expect(message.content.map((block) => block.type)).toEqual(["text"]);
    expect(readSignedThinking(message)?.blocks).toEqual([
      {
        at: 0,
        block: { type: "thinking", thinking: "", signature: "ENCRYPTED" },
      },
    ]);
  });

  it("stores redacted thinking and blocks between text and tool calls", () => {
    const message = bridged([
      messageStart,
      start(0, { type: "redacted_thinking", data: "OPAQUE" }),
      stop(0),
      start(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "First." }),
      stop(1),
      start(2, { type: "thinking" }),
      delta(2, { type: "thinking_delta", thinking: "more" }),
      delta(2, { type: "signature_delta", signature: "SIG-TWO" }),
      stop(2),
      start(3, { type: "text", text: "" }),
      delta(3, { type: "text_delta", text: "Second." }),
      stop(3),
    ]);
    expect(readSignedThinking(message)?.blocks).toEqual([
      { at: 0, block: { type: "redacted_thinking", data: "OPAQUE" } },
      {
        at: 1,
        block: { type: "thinking", thinking: "more", signature: "SIG-TWO" },
      },
    ]);
  });

  it("stores nothing for thinking that carries no signature", () => {
    const message = bridged([
      messageStart,
      start(0, { type: "thinking" }),
      delta(0, { type: "thinking_delta", thinking: "unsigned" }),
      stop(0),
      start(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "Done." }),
      stop(1),
    ]);
    expect(readSignedThinking(message)).toBeUndefined();
    expect(PROVIDER_METADATA_KEY in message).toBe(false);
  });

  it("stores nothing when the episode spans several API messages", () => {
    const message = bridged([
      ...signedTurn,
      messageStart,
      start(0, { type: "text", text: "" }),
      delta(0, { type: "text_delta", text: "Second message." }),
      stop(0),
    ]);
    expect(readSignedThinking(message)).toBeUndefined();
  });
});

describe("replaying signed thinking", () => {
  const history = (assistant: AssistantMessage): Message[] => [
    user("read a.txt"),
    assistant,
    toolResult("toolu_01a", "CONTENT"),
  ];

  it("gives an unchanged message its blocks back exactly, in place", () => {
    const message = persisted(bridged(signedTurn));
    expect(assistantFrame(history(message))).toEqual([
      { type: "thinking", thinking: "Let me read it.", signature: "SIG-ONE" },
      { type: "text", text: "Reading." },
      {
        type: "tool_use",
        id: "toolu_01a",
        name: "mcp__custom-tools__read",
        input: { path: "a.txt" },
      },
    ]);
  });

  it("puts each block back where it stood", () => {
    const message: AssistantMessage = {
      role: "assistant",
      api: "pi-claude-cli",
      provider: "pi-claude-cli",
      model: MODEL,
      usage,
      stopReason: "stop",
      timestamp: 0,
      content: [
        { type: "text", text: "First." },
        { type: "thinking", thinking: "summary", thinkingSignature: "SIG-TWO" },
        { type: "text", text: "Second." },
      ],
    };
    writeSignedThinking(message, {
      model: MODEL,
      fingerprint: assistantContentFingerprint(message.content),
      blocks: [
        { at: 0, block: { type: "redacted_thinking", data: "OPAQUE" } },
        {
          at: 1,
          block: { type: "thinking", thinking: "raw", signature: "SIG-TWO" },
        },
        { at: 2, block: { type: "redacted_thinking", data: "TAIL" } },
      ],
    });
    expect(assistantFrame([user("go"), message, user("next")])).toEqual([
      { type: "redacted_thinking", data: "OPAQUE" },
      { type: "text", text: "First." },
      { type: "thinking", thinking: "raw", signature: "SIG-TWO" },
      { type: "text", text: "Second." },
      { type: "redacted_thinking", data: "TAIL" },
    ]);
  });

  it("is unaffected by what the hash of pi's history ignores", () => {
    const message = persisted(bridged(signedTurn));
    const later = { ...message, timestamp: 99, usage: { ...usage, input: 7 } };
    expect(replayableSignedThinking(later, MODEL)).toBeDefined();
  });

  const edits: Array<
    [string, (message: AssistantMessage) => AssistantMessage]
  > = [
    [
      "edited text",
      (message) => ({
        ...message,
        content: message.content.map((block) =>
          block.type === "text" ? { ...block, text: "Edited." } : block,
        ),
      }),
    ],
    [
      "changed tool arguments",
      (message) => ({
        ...message,
        content: message.content.map((block) =>
          block.type === "toolCall"
            ? { ...block, arguments: { path: "b.txt" } }
            : block,
        ),
      }),
    ],
    [
      "a removed block",
      (message) => ({
        ...message,
        content: message.content.filter((block) => block.type !== "text"),
      }),
    ],
    [
      "an added block",
      (message) => ({
        ...message,
        content: [{ type: "text", text: "Prefix." }, ...message.content],
      }),
    ],
  ];
  it.each(edits)("drops the signature of a message with %s", (_, edit) => {
    const message = edit(persisted(bridged(signedTurn)));
    const frame = assistantFrame(history(message));
    expect(replayableSignedThinking(message, MODEL)).toBeUndefined();
    expect(JSON.stringify(frame)).not.toContain("SIG-ONE");
    expect(frame?.some((block) => block.type === "thinking")).toBe(false);
    // What pi shows of the thinking goes back as plain text.
    expect(frame).toContainEqual({ type: "text", text: "Let me read it." });
  });

  it("drops the signature when another model is asked to continue", () => {
    const message = persisted(bridged(signedTurn));
    const frame = assistantFrame(history(message), "claude-opus-5-5");
    expect(JSON.stringify(frame)).not.toContain("SIG-ONE");
    expect(frame?.[0]).toEqual({ type: "text", text: "Let me read it." });
  });

  it("never replays another provider's thinking as signed thinking", () => {
    const own = persisted(bridged(signedTurn));
    // Another provider's message, even with a signature of its own and with
    // this provider's metadata copied onto it.
    const foreign: AssistantMessage = {
      ...own,
      api: "openai-responses",
      provider: "openai",
      model: MODEL,
      content: [
        {
          type: "thinking",
          thinking: "foreign reasoning",
          thinkingSignature: "FOREIGN-SIG",
        },
        ...own.content.filter((block) => block.type !== "thinking"),
      ],
    };
    const frame = assistantFrame(history(foreign));
    expect(frame?.[0]).toEqual({ type: "text", text: "foreign reasoning" });
    expect(frame?.some((block) => block.type === "thinking")).toBe(false);
    expect(JSON.stringify(frame)).not.toMatch(/SIG-ONE|FOREIGN-SIG/);
  });

  it("replays thinking as text when the message stores no signed blocks", () => {
    const message = bridged(signedTurn);
    writeSignedThinking(message, undefined);
    const frame = assistantFrame(history(message));
    expect(frame?.[0]).toEqual({ type: "text", text: "Let me read it." });
  });

  it("leaves out thinking that has no text to give back", () => {
    const message: AssistantMessage = {
      ...bridged(signedTurn),
      api: "anthropic-messages",
      content: [
        { type: "thinking", thinking: "  " },
        { type: "thinking", thinking: "[redacted]", redacted: true },
        { type: "text", text: "Answer." },
      ],
    };
    expect(assistantFrame([user("go"), message, user("next")])).toEqual([
      { type: "text", text: "Answer." },
    ]);
  });
});

describe("readSignedThinking", () => {
  const valid: SignedThinking = {
    model: MODEL,
    fingerprint: "f",
    blocks: [
      { at: 0, block: { type: "thinking", thinking: "t", signature: "s" } },
    ],
  };
  const withMetadata = (metadata: unknown): AssistantMessage =>
    ({ ...bridged([]), [PROVIDER_METADATA_KEY]: metadata }) as AssistantMessage;

  it("reads what writeSignedThinking wrote", () => {
    expect(readSignedThinking(withMetadata({ signedThinking: valid }))).toEqual(
      valid,
    );
  });

  it.each([
    ["no metadata", undefined],
    ["metadata of another shape", "text"],
    ["no signed thinking", {}],
    ["no blocks", { signedThinking: { ...valid, blocks: [] } }],
    ["a missing model", { signedThinking: { ...valid, model: undefined } }],
    ["a missing fingerprint", { signedThinking: { ...valid, fingerprint: 1 } }],
    [
      "blocks that are not a list",
      { signedThinking: { ...valid, blocks: {} } },
    ],
    [
      "a block without a signature",
      {
        signedThinking: {
          ...valid,
          blocks: [{ at: 0, block: { type: "thinking", thinking: "t" } }],
        },
      },
    ],
    [
      "an empty signature",
      {
        signedThinking: {
          ...valid,
          blocks: [
            { at: 0, block: { type: "thinking", thinking: "", signature: "" } },
          ],
        },
      },
    ],
    [
      "an unknown block type",
      {
        signedThinking: {
          ...valid,
          blocks: [{ at: 0, block: { type: "text", text: "t" } }],
        },
      },
    ],
    [
      "a position that is not a count",
      {
        signedThinking: {
          ...valid,
          blocks: [{ at: -1, block: valid.blocks[0]!.block }],
        },
      },
    ],
    [
      "an entry that is not an object",
      { signedThinking: { ...valid, blocks: [1] } },
    ],
  ])("reads %s as nothing stored", (_, metadata) => {
    expect(readSignedThinking(withMetadata(metadata))).toBeUndefined();
  });
});
