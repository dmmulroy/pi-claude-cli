/**
 * Claude's signed thinking, kept on pi's assistant message so that a later
 * process can be given it back.
 *
 * The API signs each thinking block, and accepts one back only exactly as it
 * was returned and in the message it belongs to. pi's own thinking blocks
 * cannot carry that: an encrypted block has no text to show and is not in
 * pi's content at all, a redacted block has no place there, and nothing
 * records where between the text and tool calls a block stood. So the raw
 * blocks are stored beside the content, under a namespaced key, with their
 * positions, the model that signed them and a fingerprint of the content
 * they were returned with.
 *
 * A stored block is replayed as signed thinking only when the message is
 * this provider's, the model is the one that signed it and the fingerprint
 * still matches. Anything else is replayed without a signature, as text.
 *
 * Pure, and free of Effect imports: the event bridge writes this at pi start.
 */

import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** The key on pi's assistant message that holds this provider's metadata. */
export const PROVIDER_METADATA_KEY = "piClaudeCli";

/** A thinking block exactly as the API returned it. */
export type SignedThinkingBlock =
  | {
      readonly type: "thinking";
      readonly thinking: string;
      readonly signature: string;
    }
  | { readonly type: "redacted_thinking"; readonly data: string };

/** The signed thinking of one assistant message. */
export interface SignedThinking {
  /** The model that signed the blocks; no other model accepts them. */
  readonly model: string;
  /** `assistantContentFingerprint` of the message the blocks came with. */
  readonly fingerprint: string;
  readonly blocks: ReadonlyArray<{
    /** How many text and tool call blocks of the message precede this one. */
    readonly at: number;
    readonly block: SignedThinkingBlock;
  }>;
}

/** pi's assistant message, with this provider's metadata when it has any. */
export type AssistantMessageWithMetadata = AssistantMessage & {
  [PROVIDER_METADATA_KEY]?: { signedThinking?: SignedThinking };
};

/**
 * A fingerprint of what the model said in a message: its text and its tool
 * calls, in order. Thinking is left out, since pi may show a summary of it;
 * so are timestamps, usage and stop reason.
 */
export function assistantContentFingerprint(
  content: AssistantMessage["content"],
): string {
  const visible = content.flatMap((block) => {
    if (block.type === "text") return [["text", block.text]];
    if (block.type === "toolCall")
      return [["toolCall", block.id, block.name, block.arguments]];
    return [];
  });
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

/** Store `signed` on the message, or remove what is stored. */
export function writeSignedThinking(
  message: AssistantMessageWithMetadata,
  signed: SignedThinking | undefined,
): void {
  if (signed === undefined || signed.blocks.length === 0) {
    delete message[PROVIDER_METADATA_KEY];
    return;
  }
  message[PROVIDER_METADATA_KEY] = { signedThinking: signed };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readBlock(value: unknown): SignedThinkingBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "thinking" &&
    typeof value.thinking === "string" &&
    typeof value.signature === "string" &&
    value.signature.length > 0
  )
    return {
      type: "thinking",
      thinking: value.thinking,
      signature: value.signature,
    };
  if (
    value.type === "redacted_thinking" &&
    typeof value.data === "string" &&
    value.data.length > 0
  )
    return { type: "redacted_thinking", data: value.data };
  return undefined;
}

/**
 * The signed thinking stored on a message. The message comes back from pi's
 * session file, so the metadata is read as unknown input: anything that is
 * not complete and well formed is none.
 */
export function readSignedThinking(
  message: AssistantMessage,
): SignedThinking | undefined {
  const metadata: unknown = Reflect.get(message, PROVIDER_METADATA_KEY);
  const stored = isRecord(metadata) ? metadata.signedThinking : undefined;
  if (!isRecord(stored)) return undefined;
  const { model, fingerprint, blocks } = stored;
  if (
    typeof model !== "string" ||
    typeof fingerprint !== "string" ||
    !Array.isArray(blocks) ||
    blocks.length === 0
  )
    return undefined;
  const read: Array<SignedThinking["blocks"][number]> = [];
  for (const entry of blocks) {
    const block = isRecord(entry) ? readBlock(entry.block) : undefined;
    const at = isRecord(entry) ? entry.at : undefined;
    if (
      block === undefined ||
      typeof at !== "number" ||
      !Number.isInteger(at) ||
      at < 0
    )
      return undefined;
    read.push({ at, block });
  }
  return { model, fingerprint, blocks: read };
}

/**
 * The stored blocks, when they may be given back to `modelId` as signed
 * thinking: the message is this provider's, that model signed them, and the
 * message's text and tool calls are what they were signed with.
 */
export function replayableSignedThinking(
  message: AssistantMessage,
  modelId: string,
): SignedThinking | undefined {
  if (message.api !== "pi-claude-cli") return undefined;
  if (message.model !== modelId) return undefined;
  const signed = readSignedThinking(message);
  if (signed === undefined || signed.model !== modelId) return undefined;
  return signed.fingerprint === assistantContentFingerprint(message.content)
    ? signed
    : undefined;
}
