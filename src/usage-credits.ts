/**
 * The guard against model calls moving from the subscription's plan limits
 * to pay-as-you-go usage credits (formerly "extra usage").
 *
 * Claude Code reports the account's limit status after each API call in a
 * `rate_limit_event`. When it says `isUsingOverage`, that call was charged
 * to usage credits. The call has already been paid for; stopping the
 * episode with an error keeps pi's agent loop from making more of them. A
 * user who wants usage credits spent sets `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1`.
 *
 * Every message here contains the word "billing": pi's retry classifier
 * treats that as an account problem and does not retry it.
 *
 * Pure, and free of Effect imports.
 */

import type { ClaudeRateLimitInfo } from "./cli-protocol.ts";

/** The variable that lets model calls be charged to usage credits. */
export const ALLOW_USAGE_CREDITS_ENV = "PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS";

/** True when `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS` is `1`, `true` or `yes`. */
export function usageCreditsAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[ALLOW_USAGE_CREDITS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** True when the limit status says the call was charged to usage credits. */
export function isChargedToUsageCredits(info: ClaudeRateLimitInfo): boolean {
  return info.isUsingOverage === true;
}

/** The error pi shows when a call was charged to usage credits. */
export function usageCreditsChargeMessage(info: ClaudeRateLimitInfo): string {
  const window = typeof info.rateLimitType === "string" ? `, ${info.rateLimitType}` : "";
  return (
    "Claude billing: this request was charged to Claude usage credits instead of your plan limits " +
    `(rate limit status ${info.status ?? "unknown"}${window}). ` +
    "pi stopped so further requests are not charged. To stay on plan limits only, turn off usage credits at " +
    `claude.ai/settings/usage. To allow usage credits, set ${ALLOW_USAGE_CREDITS_ENV}=1.`
  );
}

/**
 * Anthropic's wording when it will not serve a request on plan limits and
 * wants it charged to usage credits: the plan limit is used up, or the
 * request was classified as third-party app usage.
 */
const USAGE_CREDITS_REJECTION =
  /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i;

/**
 * An actionable, non-retryable rewrite of an Anthropic usage-credit
 * rejection, or undefined for any other error.
 */
export function describeUsageCreditsRejection(errorMessage: string): string | undefined {
  if (errorMessage.startsWith("Claude billing:")) return undefined;
  if (!USAGE_CREDITS_REJECTION.test(errorMessage)) return undefined;
  return (
    "Claude billing: Anthropic did not accept this request on your Claude plan limits and wants to charge " +
    "it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
    `request as third-party app usage. pi will not retry it. Original error: ${errorMessage}`
  );
}
