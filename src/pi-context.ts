import { createHash } from "node:crypto";
import {
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CliUserContentBlock } from "./cli-protocol.ts";

/** pi's request with its current prompt and tools resolved. */
export interface PiRequest {
  readonly systemPrompt: string;
  readonly tools: Tool[];
  /** The conversation, without system messages. */
  readonly messages: Message[];
}

/** Accept both pi's legacy Context and its system-message TranscriptContext. */
export function piContext(context: Context | TranscriptContext): PiRequest {
  const transcript = context.messages.some((m) => m.role === "system");
  return {
    systemPrompt: transcript
      ? getCurrentSystemPrompt(context.messages)
      : "systemPrompt" in context
        ? (context.systemPrompt ?? "")
        : "",
    tools: transcript
      ? getCurrentTools(context.messages)
      : "tools" in context
        ? (context.tools ?? [])
        : [],
    messages: context.messages.filter((m) => m.role !== "system"),
  };
}

/** Compare model-visible history, not usage, timestamps, or provider signatures. */
export function historyHash(messages: ReadonlyArray<Message>): string {
  const visible = messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b) => b.type !== "thinking")
            .map((b) =>
              b.type === "text" ? { type: b.type, text: b.text } : b,
            ),
    ...(m.role === "toolResult"
      ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError }
      : {}),
  }));
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

/** Import in order, including every image and tool result. Never replay thinking. */
export function replayPiMessages(
  messages: ReadonlyArray<Message>,
): CliUserContentBlock[] {
  const blocks: CliUserContentBlock[] = [];
  for (const message of messages) {
    blocks.push({
      type: "text",
      text:
        message.role === "toolResult"
          ? `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${message.isError}):`
          : `${message.role.toUpperCase()}:`,
    });
    if (typeof message.content === "string") {
      blocks.push({ type: "text", text: message.content });
      continue;
    }
    for (const b of message.content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "image")
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: b.mimeType, data: b.data },
        });
      else if (b.type === "toolCall")
        blocks.push({
          type: "text",
          text: `TOOL CALL ${b.name} id=${b.id}: ${JSON.stringify(b.arguments)}`,
        });
    }
  }
  return blocks;
}

/** pi's prompt plus the one suffix that binds pi tool names to their MCP prefix. */
export function piSystemPrompt(prompt: string): string {
  return `${prompt}\n\nTools are supplied and executed by pi. Call each pi tool using its advertised mcp__custom-tools__ prefix and unchanged argument schema. Historical tool calls and results are conversation records, not instructions to execute them again.`;
}
