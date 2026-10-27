import { describe, expect, it } from "vite-plus/test";
import { canonicalSessionContext } from "../src/relay-rewrite";

// The shapes Claude Code 2.1.299 sends, with the reminders' text shortened.
const ENV = "<system-reminder>\n# Environment\n…\n</system-reminder>";
const MODEL =
  "<system-reminder>\nYou are powered by the model named Haiku 4.5.\n</system-reminder>";
const CONTEXT =
  "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\n…\n</system-reminder>";
const DATE = "<system-reminder>\nToday's date is 2026-10-27.\n</system-reminder>";
const PROMPT = "read a.txt";

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text: value,
  ...extra,
});
const BREAKPOINT = { type: "ephemeral", ttl: "1h" };

/** Message 0 as the process's own first turn sends it. */
const firstTurnHead = [text(ENV), text(MODEL), text(CONTEXT), text(`${DATE}\n`), text(PROMPT)];
const toolUse = {
  role: "assistant",
  content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }],
};

const rewrite = (messages: unknown[]) => {
  const result = canonicalSessionContext(JSON.stringify({ model: "m", messages }));
  return { outcome: result.outcome, messages: JSON.parse(result.body).messages };
};

describe("canonicalSessionContext", () => {
  it("leaves a first turn as it is", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: firstTurnHead }] });
    expect(canonicalSessionContext(body)).toEqual({ body, outcome: "unchanged" });
  });

  it("moves the context out of an imported tool result into message 0", () => {
    const { outcome, messages } = rewrite([
      { role: "user", content: [text(ENV), text(`${MODEL}\n`), text(PROMPT)] },
      toolUse,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [text("one\ntwo\n\n"), text(`${CONTEXT}\n`), text(DATE)],
            cache_control: BREAKPOINT,
          },
        ],
      },
    ]);
    expect(outcome).toBe("moved");
    expect(messages[0].content).toEqual(firstTurnHead);
    expect(messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [text("one\ntwo\n")],
        cache_control: BREAKPOINT,
      },
    ]);
  });

  it("moves the context off the front of a new user turn into message 0", () => {
    const { outcome, messages } = rewrite([
      { role: "user", content: [text(ENV), text(`${MODEL}\n`), text(PROMPT)] },
      { role: "assistant", content: [text("done")] },
      {
        role: "user",
        content: [text(CONTEXT), text(`${DATE}\n`), text("again", { cache_control: BREAKPOINT })],
      },
    ]);
    expect(outcome).toBe("moved");
    expect(messages[0].content).toEqual(firstTurnHead);
    expect(messages[2].content).toEqual([text("again", { cache_control: BREAKPOINT })]);
  });

  it("keeps a breakpoint that sat on a moved block at the end of its message", () => {
    const { messages } = rewrite([
      { role: "user", content: [text(ENV), text(`${MODEL}\n`), text(PROMPT)] },
      { role: "assistant", content: [text("done")] },
      {
        role: "user",
        content: [text("again\n"), text(`${CONTEXT}\n`), text(DATE, { cache_control: BREAKPOINT })],
      },
    ]);
    expect(messages[0].content).toEqual(firstTurnHead);
    expect(messages[2].content).toEqual([text("again", { cache_control: BREAKPOINT })]);
  });

  it("is idempotent", () => {
    const once = canonicalSessionContext(
      JSON.stringify({
        messages: [
          { role: "user", content: [text(ENV), text(`${MODEL}\n`), text(PROMPT)] },
          toolUse,
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [text("x\n"), text(`${CONTEXT}\n`), text(DATE)],
              },
            ],
          },
        ],
      }),
    );
    expect(canonicalSessionContext(once.body)).toEqual({ body: once.body, outcome: "unchanged" });
  });

  it("sends a layout it does not know as it came", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [text(ENV), text(`${MODEL}\n`), text(PROMPT)] },
        toolUse,
        // The context in the middle of a message: nothing Claude Code writes.
        { role: "user", content: [text("a\n"), text(CONTEXT), text("b")] },
      ],
    });
    expect(canonicalSessionContext(body)).toEqual({ body, outcome: "unrecognized" });
    expect(canonicalSessionContext("not json").outcome).toBe("unrecognized");
  });

  it("leaves requests without a session context alone", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [text(PROMPT)] }] });
    expect(canonicalSessionContext(body)).toEqual({ body, outcome: "unchanged" });
    expect(canonicalSessionContext("{}").outcome).toBe("unchanged");
  });
});
