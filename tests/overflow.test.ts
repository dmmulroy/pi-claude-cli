import { describe, it, expect } from "vitest";
import {
  isOverflowError,
  rewriteOverflowMessage,
  OVERFLOW_PREFIX,
} from "../src/overflow";

describe("overflow error normalization (issue #4)", () => {
  describe("isOverflowError", () => {
    it("matches the Anthropic overflow phrasings", () => {
      expect(
        isOverflowError("prompt is too long: 214315 tokens > 200000 maximum"),
      ).toBe(true);
      expect(
        isOverflowError(
          "input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000",
        ),
      ).toBe(true);
    });

    it("never matches rate limits or transient failures", () => {
      expect(isOverflowError("rate limit exceeded, please slow down")).toBe(
        false,
      );
      expect(isOverflowError("429 too many requests")).toBe(false);
      expect(isOverflowError("overloaded_error: try again later")).toBe(false);
      expect(
        isOverflowError("Claude CLI exited unexpectedly with code 1"),
      ).toBe(false);
    });

    it("classifies the CLI's own wording, which now reaches pi on the first failure", () => {
      // With CLAUDE_CODE_MAX_RETRIES=0 the CLI reports each failed request
      // at once. Capacity errors must stay with pi's retry, not compaction.
      expect(
        isOverflowError(
          "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
        ),
      ).toBe(false);
      expect(
        isOverflowError(
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 214315 tokens > 200000 maximum"}}',
        ),
      ).toBe(true);
    });

    it("is idempotent: already-rewritten messages do not match again", () => {
      expect(
        isOverflowError("context_length_exceeded: prompt is too long"),
      ).toBe(false);
    });
  });

  describe("rewriteOverflowMessage", () => {
    const overflow = {
      role: "assistant",
      provider: "pi-claude-cli",
      stopReason: "error",
      errorMessage: "prompt is too long: 214315 tokens > 200000 maximum",
    };

    it("rewrites a provider-scoped overflow with the recognized prefix", () => {
      const result = rewriteOverflowMessage(overflow);
      expect(result).toBeDefined();
      expect(result!.message.errorMessage).toBe(
        `${OVERFLOW_PREFIX}: prompt is too long: 214315 tokens > 200000 maximum`,
      );
      // Everything else on the message is preserved.
      expect(result!.message.provider).toBe("pi-claude-cli");
      expect(result!.message.stopReason).toBe("error");
    });

    it("scopes to this provider via message.provider or ctx model provider", () => {
      const foreign = { ...overflow, provider: "anthropic" };
      expect(rewriteOverflowMessage(foreign)).toBeUndefined();
      expect(rewriteOverflowMessage(foreign, "pi-claude-cli")).toBeDefined();
    });

    it("ignores non-error, non-assistant, and non-overflow messages", () => {
      expect(
        rewriteOverflowMessage({ ...overflow, stopReason: "stop" }),
      ).toBeUndefined();
      expect(
        rewriteOverflowMessage({ ...overflow, role: "user" }),
      ).toBeUndefined();
      expect(
        rewriteOverflowMessage({ ...overflow, errorMessage: "rate limited" }),
      ).toBeUndefined();
    });
  });
});
