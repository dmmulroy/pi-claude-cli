import { createHash } from "node:crypto";
import {
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  type Message,
  renderSystemMessageUpdate,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  CliAssistantContentBlock,
  CliTextOrImageBlock,
  CliUserContentBlock,
} from "./cli-protocol.ts";
import { replayableSignedThinking } from "./signed-thinking.ts";
import { claudeToolName } from "./tool-mapping.ts";
import { createToolCallIdMap, toolCallIdsOf } from "./tool-call-id.ts";

/**
 * A later system message of pi's, kept where it occurred: rendered as pi's
 * own Anthropic provider renders it, and placed before the assistant message
 * that followed it on the wire (counted from 0), or at the end.
 */
export interface SystemUpdate {
  readonly beforeAssistant: number | null;
  readonly text: string;
}

/** pi's request with its prompt and tools resolved. */
export interface PiRequest {
  /**
   * The system prompt the process launches with: the current one, or with
   * native system messages the leading message's.
   */
  readonly systemPrompt: string;
  readonly tools: Tool[];
  /** The conversation, without system messages. */
  readonly messages: Message[];
  /** Later system messages, with native system messages; otherwise none. */
  readonly systemUpdates: ReadonlyArray<SystemUpdate>;
}

/**
 * True for an assistant message the import sends the model: failed and
 * aborted turns are left out (as `structuredReplay` does), so they do not
 * count when system updates are placed.
 */
const isSentAssistant = (message: { readonly role: string }): boolean =>
  message.role === "assistant" &&
  (message as Message & { role: "assistant" }).stopReason !== "error" &&
  (message as Message & { role: "assistant" }).stopReason !== "aborted";

/**
 * Accept both pi's legacy Context and its system-message TranscriptContext.
 *
 * With `nativeSystemMessages` (a model that takes system messages mid
 * conversation, behind the rewriting relay) a later system message stays a
 * system message where it occurred, as pi's own Anthropic provider sends it,
 * and the launch prompt is the leading one, so a prompt update does not need
 * a fresh process. Otherwise every system message is folded into the
 * current prompt. Tools are always the current ones.
 */
export function piContext(
  context: Context | TranscriptContext,
  options: { readonly nativeSystemMessages?: boolean } = {},
): PiRequest {
  const transcript = context.messages.some((m) => m.role === "system");
  const messages = context.messages.filter((m) => m.role !== "system");
  const tools = transcript
    ? getCurrentTools(context.messages)
    : "tools" in context
      ? (context.tools ?? [])
      : [];
  if (!transcript)
    return {
      systemPrompt: "systemPrompt" in context ? (context.systemPrompt ?? "") : "",
      tools,
      messages,
      systemUpdates: [],
    };
  if (options.nativeSystemMessages !== true)
    return {
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools,
      messages,
      systemUpdates: [],
    };

  const initial = getInitialSystemMessage(context.messages);
  const pending: string[] = [];
  const systemUpdates: SystemUpdate[] = [];
  let assistants = 0;
  for (const [index, message] of context.messages.entries()) {
    if (message.role === "system") {
      if (index === 0 && message === initial) continue;
      const text = renderSystemMessageUpdate(message);
      if (text.length > 0) pending.push(text);
    } else if (isSentAssistant(message)) {
      for (const text of pending.splice(0))
        systemUpdates.push({ beforeAssistant: assistants, text });
      assistants += 1;
    }
  }
  for (const text of pending) systemUpdates.push({ beforeAssistant: null, text });
  return {
    systemPrompt: initial === undefined ? "" : getSystemMessageText(initial),
    tools,
    messages,
    systemUpdates,
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
            .map((b) => (b.type === "text" ? { type: b.type, text: b.text } : b)),
    ...(m.role === "toolResult"
      ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError }
      : {}),
  }));
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

/** Import in order, including every image and tool result. Never replay thinking. */
export function replayPiMessages(messages: ReadonlyArray<Message>): CliUserContentBlock[] {
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

/**
 * One message of a structured history import, as the CLI's stdin takes it:
 * a user message that is added without asking the model, or an assistant
 * message replayed as it was.
 */
export type CliReplayFrame =
  | {
      readonly kind: "user";
      readonly content: ReadonlyArray<CliUserContentBlock>;
    }
  | {
      readonly kind: "assistant";
      readonly content: ReadonlyArray<CliAssistantContentBlock>;
    };

/** The result of a tool call pi's history holds no result for. */
const MISSING_TOOL_RESULT_TEXT = "No result provided";

const isArgumentRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text and images of a pi message; the API rejects an empty text block. */
function textAndImageBlocks(
  content: Extract<Message, { role: "user" | "toolResult" }>["content"],
): CliTextOrImageBlock[] {
  if (typeof content === "string")
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  const blocks: CliTextOrImageBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
    } else
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.data,
        },
      });
  }
  return blocks;
}

/**
 * pi's history as the messages Claude itself would have recorded: assistant
 * turns as assistant messages with real `tool_use` blocks, tool results as
 * `tool_result` blocks, everything in order.
 *
 * It follows what pi's own Anthropic provider sends (pi-ai
 * `transformMessages`): failed and aborted assistant turns are left out, and
 * a tool call with no result gets one that says so. Tool call ids Claude
 * would reject are replaced by stable valid ones on the way out
 * (`src/tool-call-id.ts`); pi's messages are never modified.
 *
 * Thinking is replayed as signed thinking only from a message of this
 * provider and of `modelId` whose text and tool calls are unchanged since
 * the API signed it (`src/signed-thinking.ts`): then the raw blocks go back
 * exactly as they came, in their places. Thinking of any other message, an
 * edited one or another provider's, is replayed as plain text and never
 * with a signature.
 *
 * @returns The frames, the last of which is the user message that starts the
 *   turn; or undefined when the history cannot be expressed this way (it
 *   does not start and end with a user message, or two assistant turns are
 *   adjacent), in which case the caller imports it as labelled text.
 */
export function structuredReplay(
  messages: ReadonlyArray<Message>,
  modelId: string,
): ReadonlyArray<CliReplayFrame> | undefined {
  const ids = createToolCallIdMap(toolCallIdsOf(messages));
  const frames: Array<
    | { kind: "user"; content: CliUserContentBlock[] }
    | { kind: "assistant"; content: CliAssistantContentBlock[] }
  > = [];
  /** `tool_use` ids of the latest assistant frame that have no result yet. */
  let unanswered = new Set<string>();

  const userContent = (): CliUserContentBlock[] => {
    const last = frames[frames.length - 1];
    if (last?.kind === "user") return last.content;
    const content: CliUserContentBlock[] = [];
    frames.push({ kind: "user", content });
    return content;
  };
  const answerMissingResults = () => {
    for (const id of unanswered)
      userContent().push({
        tool_use_id: id,
        type: "tool_result",
        content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
        is_error: true,
      });
    unanswered = new Set();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      answerMissingResults();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const content: CliAssistantContentBlock[] = [];
      const signed = replayableSignedThinking(message, modelId);
      /** Text and tool call blocks of the message seen so far. */
      let visible = 0;
      const replaySignedAt = (position: number) => {
        for (const entry of signed?.blocks ?? [])
          if (entry.at === position) content.push(entry.block);
      };
      for (const block of message.content) {
        if (block.type === "thinking") {
          // Signed blocks stand in for pi's own; without them the thinking
          // goes back as text, as pi-ai sends thinking it holds no
          // signature for.
          if (signed === undefined && block.redacted !== true && block.thinking.trim().length > 0)
            content.push({ type: "text", text: block.thinking });
          continue;
        }
        replaySignedAt(visible++);
        if (block.type === "text") {
          if (block.text.length > 0) content.push({ type: "text", text: block.text });
        } else if (block.type === "toolCall")
          content.push({
            type: "tool_use",
            id: ids.toClaude(block.id),
            name: claudeToolName(block.name),
            // Arguments that did not arrive as an object were already
            // refused by pi; the API takes nothing but an object.
            input: isArgumentRecord(block.arguments) ? block.arguments : {},
          });
      }
      // Blocks that stood after the last text or tool call, or past it.
      for (const entry of signed?.blocks ?? []) if (entry.at >= visible) content.push(entry.block);
      if (content.length === 0) continue;
      if (frames[frames.length - 1]?.kind !== "user") return undefined;
      frames.push({ kind: "assistant", content });
      unanswered = new Set(
        content.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
      );
    } else if (message.role === "toolResult") {
      const id = ids.toClaude(message.toolCallId);
      const content = textAndImageBlocks(message.content);
      if (unanswered.delete(id)) {
        userContent().push({
          tool_use_id: id,
          type: "tool_result",
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
          ...(message.isError ? { is_error: true as const } : {}),
        });
      } else {
        // No tool call for it in the turn before (that turn failed, or the
        // history was edited): kept as a record, as the text import does.
        userContent().push(
          {
            type: "text",
            text: `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${message.isError}):`,
          },
          ...content,
        );
      }
    } else {
      answerMissingResults();
      const content = textAndImageBlocks(message.content);
      if (content.length > 0) userContent().push(...content);
    }
  }
  answerMissingResults();

  if (frames[0]?.kind !== "user") return undefined;
  if (frames[frames.length - 1]?.kind !== "user") return undefined;
  // The API wants a user message's tool results before anything else in it.
  return frames.map((frame) =>
    frame.kind === "assistant"
      ? frame
      : {
          kind: "user" as const,
          content: [
            ...frame.content.filter((block) => block.type === "tool_result"),
            ...frame.content.filter((block) => block.type !== "tool_result"),
          ],
        },
  );
}

/** pi's prompt plus the one suffix that binds pi tool names to their MCP prefix. */
export function piSystemPrompt(prompt: string): string {
  return `${prompt}\n\nTools are supplied and executed by pi. Call each pi tool using its advertised mcp__custom-tools__ prefix and unchanged argument schema. Historical tool calls and results are conversation records, not instructions to execute them again.`;
}
