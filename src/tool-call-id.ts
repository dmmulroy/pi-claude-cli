/**
 * Tool call ids on their way to Claude and back.
 *
 * pi's history can hold tool call ids Claude did not mint: after a model
 * switch they come from another provider (OpenAI Responses ids run to
 * hundreds of characters and contain `|`). The Anthropic API accepts only
 * `^[a-zA-Z0-9_-]+$`, at most 64 characters, in `tool_use.id` and
 * `tool_result.tool_use_id`. An id that does not fit is replaced, in what is
 * sent to the CLI only, by a stable id derived from it. pi's stored ids are
 * never changed.
 *
 * Pure: no Effect import, so the replay path that uses it stays testable.
 */

import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

/** What the Anthropic API accepts as a tool use id. */
const CLAUDE_TOOL_USE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Prefix of an id this provider derived; Claude's own start with `toolu_`. */
const MAPPED_ID_PREFIX = "toolu_pi_";
/** Hex digits of the pi id's SHA-256 kept in a derived id. */
const MAPPED_ID_HASH_LENGTH = 40;

/** True when Claude accepts `id` as it is. */
export const isClaudeToolUseId = (id: string): boolean =>
  CLAUDE_TOOL_USE_ID.test(id);

/** The two directions of one conversation's tool call ids. */
export interface ToolCallIdMap {
  /** The id sent to Claude for a pi tool call id. Valid ids are unchanged. */
  readonly toClaude: (piToolCallId: string) => string;
  /** pi's id for an id Claude was sent or returned. Unknown ids are unchanged. */
  readonly toPi: (claudeToolUseId: string) => string;
}

const derivedId = (piToolCallId: string, attempt: number): string =>
  MAPPED_ID_PREFIX +
  createHash("sha256")
    .update(attempt === 0 ? piToolCallId : `${attempt}:${piToolCallId}`)
    .digest("hex")
    .slice(0, MAPPED_ID_HASH_LENGTH);

/**
 * Build the mapping for a conversation's tool call ids.
 *
 * Derived ids depend only on the pi id, so the same history maps the same
 * way in every process and import. Two pi ids never share a Claude id: a
 * derived id that is already taken, by a valid id or another derived one, is
 * derived again.
 */
export function createToolCallIdMap(
  piToolCallIds: Iterable<string>,
): ToolCallIdMap {
  const distinct = [...new Set(piToolCallIds)];
  const toClaude = new Map<string, string>();
  const toPi = new Map<string, string>();
  // Valid ids first: they keep their value whatever the invalid ones hash to.
  for (const id of distinct) {
    if (!isClaudeToolUseId(id)) continue;
    toClaude.set(id, id);
    toPi.set(id, id);
  }
  for (const id of distinct) {
    if (toClaude.has(id)) continue;
    let attempt = 0;
    let mapped = derivedId(id, attempt);
    while (toPi.has(mapped)) mapped = derivedId(id, ++attempt);
    toClaude.set(id, mapped);
    toPi.set(mapped, id);
  }
  return {
    toClaude: (piToolCallId) =>
      toClaude.get(piToolCallId) ??
      (isClaudeToolUseId(piToolCallId)
        ? piToolCallId
        : derivedId(piToolCallId, 0)),
    toPi: (claudeToolUseId) => toPi.get(claudeToolUseId) ?? claudeToolUseId,
  };
}

/** Every tool call id in pi's history: the calls and the results. */
export function toolCallIdsOf(messages: ReadonlyArray<Message>): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") ids.push(message.toolCallId);
    else if (message.role === "assistant")
      for (const block of message.content)
        if (block.type === "toolCall") ids.push(block.id);
  }
  return ids;
}
