import { describe, expect, it } from "vite-plus/test";
import {
  ALLOW_USAGE_CREDITS_ENV,
  describeUsageCreditsRejection,
  isChargedToUsageCredits,
  usageCreditsChargeMessage,
} from "../src/usage-credits";

/** pi's own rule for errors it must not retry (pi-ai `utils/retry`). */
const NOT_RETRIED = /billing/i;

describe("isChargedToUsageCredits", () => {
  it("is true only when the CLI says the call used usage credits", () => {
    expect(isChargedToUsageCredits({ isUsingOverage: true })).toBe(true);
    expect(isChargedToUsageCredits({ isUsingOverage: false })).toBe(false);
    expect(isChargedToUsageCredits({ isUsingOverage: null })).toBe(false);
    expect(isChargedToUsageCredits({ status: "allowed" })).toBe(false);
  });
});

describe("usageCreditsChargeMessage", () => {
  it("names the status and window, how to stop it, and how to allow it", () => {
    const message = usageCreditsChargeMessage({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      isUsingOverage: true,
    });
    expect(message).toMatch(NOT_RETRIED);
    expect(message).toContain("allowed_warning, five_hour");
    expect(message).toContain("claude.ai/settings/usage");
    expect(message).toContain(`${ALLOW_USAGE_CREDITS_ENV}=1`);
  });

  it("says unknown for a status the CLI did not give", () => {
    expect(usageCreditsChargeMessage({ isUsingOverage: true })).toContain(
      "rate limit status unknown)",
    );
  });
});

describe("describeUsageCreditsRejection", () => {
  it.each([
    "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
    "You're out of extra usage. Add more at claude.ai/settings/usage",
    "This request draws from your usage credits",
  ])("rewrites %j into a billing error that keeps the original", (original) => {
    const rewritten = describeUsageCreditsRejection(original);
    expect(rewritten).toMatch(NOT_RETRIED);
    expect(rewritten).toContain(`Original error: ${original}`);
  });

  it("leaves every other error alone, and never rewrites twice", () => {
    expect(describeUsageCreditsRejection("rate_limit_error: 429")).toBe(undefined);
    const once = describeUsageCreditsRejection("out of extra usage") ?? "";
    expect(describeUsageCreditsRejection(once)).toBeUndefined();
    expect(describeUsageCreditsRejection(usageCreditsChargeMessage({}))).toBeUndefined();
  });
});
