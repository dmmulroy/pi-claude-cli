/**
 * Context-overflow error normalization (issue #4).
 *
 * When a request exceeds the model's context window, pi can recover by
 * compacting the conversation and retrying — but only if it recognizes the
 * failure. Detection runs on the finalized assistant message: pi checks
 * `errorMessage` against its known overflow patterns, and the generic
 * fallback it always recognizes is a `context_length_exceeded` prefix
 * (see pi's custom-provider docs, "Context Overflow Errors").
 *
 * The Claude CLI surfaces the Anthropic API's error text verbatim, which pi
 * does not recognize. This module rewrites ONLY provider-scoped, clearly
 * overflow-shaped errors; rate limits and transient failures must never be
 * rewritten (that would trigger compaction instead of pi's retry/backoff).
 */

/**
 * Anthropic API overflow phrasings, matched conservatively:
 * - "prompt is too long: 214315 tokens > 200000 maximum"
 * - "input length and `max_tokens` exceed context limit: ..."
 */
const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /input length and .?max_tokens.? exceed context limit/i,
];

export const OVERFLOW_PREFIX = "context_length_exceeded";

/** True when the error text is an overflow pi should recover from. */
export function isOverflowError(errorMessage: string): boolean {
  if (errorMessage.includes(OVERFLOW_PREFIX)) return false; // already rewritten
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * `message_end` handler body: returns the rewritten assistant message when
 * this provider produced a recognizable overflow error, undefined otherwise
 * (pi keeps the message unchanged).
 */
export function rewriteOverflowMessage<
  M extends {
    role?: string;
    provider?: string;
    stopReason?: string;
    errorMessage?: string;
  },
>(message: M, ctxProvider?: string): { message: M } | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error") return undefined;
  if (message.provider !== "pi-claude-cli" && ctxProvider !== "pi-claude-cli")
    return undefined;

  const errorMessage = message.errorMessage ?? "";
  if (!isOverflowError(errorMessage)) return undefined;

  return {
    message: {
      ...message,
      errorMessage: `${OVERFLOW_PREFIX}: ${errorMessage}`,
    },
  };
}
