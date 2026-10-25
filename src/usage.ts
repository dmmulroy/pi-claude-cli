/**
 * Token arithmetic for billing an episode.
 *
 * `result.modelUsage` is cumulative for the CLI process and a turn can span
 * several pi calls (one per tool handoff), so what an episode bills is a
 * difference of totals, never a figure the CLI reports directly.
 */

import { Number as Num, Option, Struct } from "effect";
import type { ClaudeModelUsage, ClaudeUsage } from "./cli-protocol.ts";

/** The four token counters every usage figure reduces to. */
export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

const sumReducer = Struct.makeReducer<TokenUsage>({
  input_tokens: Num.ReducerSum,
  output_tokens: Num.ReducerSum,
  cache_read_input_tokens: Num.ReducerSum,
  cache_creation_input_tokens: Num.ReducerSum,
});

const maxReducer = Struct.makeReducer<TokenUsage>({
  input_tokens: Num.ReducerMax,
  output_tokens: Num.ReducerMax,
  cache_read_input_tokens: Num.ReducerMax,
  cache_creation_input_tokens: Num.ReducerMax,
});

/** No tokens. */
export const ZERO_TOKEN_USAGE: TokenUsage = sumReducer.initialValue;

/** Component-wise sum. */
export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => sumReducer.combine(a, b);

/** Component-wise maximum. */
export const maxTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => maxReducer.combine(a, b);

/** `a − b`, floored at zero per component. */
export const subtractTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage =>
  maxTokenUsage(ZERO_TOKEN_USAGE, {
    input_tokens: a.input_tokens - b.input_tokens,
    output_tokens: a.output_tokens - b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens - b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens - b.cache_creation_input_tokens,
  });

/** A `usage` object from the wire, with absent counters as zero. */
export const tokenUsageFromClaudeUsage = (usage: ClaudeUsage | null | undefined): TokenUsage => ({
  input_tokens: usage?.input_tokens ?? 0,
  output_tokens: usage?.output_tokens ?? 0,
  cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
});

/**
 * The process total across every model in `result.modelUsage`; none when the
 * CLI sent no per-model figures.
 */
export const tokenUsageFromModelUsage = (
  modelUsage: Readonly<Record<string, ClaudeModelUsage>> | null | undefined,
): Option.Option<TokenUsage> => {
  const entries = Object.values(modelUsage ?? {});
  if (entries.length === 0) return Option.none();
  return Option.some(
    entries
      .map((entry): TokenUsage => ({
        input_tokens: entry.inputTokens ?? 0,
        output_tokens: entry.outputTokens ?? 0,
        cache_read_input_tokens: entry.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: entry.cacheCreationInputTokens ?? 0,
      }))
      .reduce(addTokenUsage, ZERO_TOKEN_USAGE),
  );
};

/** The usage pi's assistant message carries, in the wire's field names. */
export const tokenUsageFromPiUsage = (usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): TokenUsage => ({
  input_tokens: usage.input,
  output_tokens: usage.output,
  cache_read_input_tokens: usage.cacheRead,
  cache_creation_input_tokens: usage.cacheWrite,
});
