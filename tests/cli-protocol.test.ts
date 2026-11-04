import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodeCliLine } from "../src/cli-protocol";

describe("decoding a rate_limit_event", () => {
  it("keeps the usage of each limit window", () => {
    const rateLimitInfo = {
      status: "allowed",
      rateLimitType: "seven_day",
      unifiedWindows: {
        seven_day: { utilization: 0.18, resetsAt: 1_793_952_000, status: "allowed" },
      },
    };
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: rateLimitInfo });
    expect(Option.getOrThrow(decodeCliLine(line))).toEqual({
      _tag: "RateLimit",
      info: {
        status: "allowed",
        rateLimitType: "seven_day",
        unifiedWindows: { seven_day: { utilization: 0.18, resetsAt: 1_793_952_000 } },
      },
    });
  });
});
