import { describe, expect, it } from "vite-plus/test";
import { canonicalSessionContext, injectSystemMessages } from "../src/relay-rewrite";

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

describe("canonicalSessionContext, system-message layout", () => {
  const CONTEXT_LINE = `${CONTEXT}\n`;
  const ENVIRONMENT = "# Environment\n…\n\nYou are powered by Haiku 5.5.";
  const DATE_TEXT = "Today's date is 2026-10-27.";
  const firstTurn = [
    { role: "user", content: [text(CONTEXT_LINE), text(PROMPT)] },
    { role: "system", content: `${ENVIRONMENT}\n\n${DATE_TEXT}` },
  ];
  const assistantTurn = {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }],
  };

  it("moves the context and the date back from an imported user turn", () => {
    const { outcome, messages } = rewrite([
      { role: "user", content: [text(PROMPT)] },
      { role: "system", content: ENVIRONMENT },
      { role: "assistant", content: [text("hi")] },
      { role: "user", content: [text(CONTEXT_LINE), text("again")] },
      { role: "system", content: [text(DATE_TEXT, { cache_control: BREAKPOINT })] },
    ]);
    expect(outcome).toBe("moved");
    expect(messages.slice(0, 2)).toEqual(firstTurn);
    expect(messages.slice(2)).toEqual([
      { role: "assistant", content: [text("hi")] },
      { role: "user", content: [text("again", { cache_control: BREAKPOINT })] },
    ]);
  });

  it("moves them back from an imported tool result", () => {
    const { outcome, messages } = rewrite([
      { role: "user", content: [text(PROMPT)] },
      { role: "system", content: [text(ENVIRONMENT)] },
      assistantTurn,
      {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_1",
            type: "tool_result",
            content: [text("out\n\n"), text(CONTEXT)],
          },
        ],
      },
      { role: "system", content: [text(DATE_TEXT, { cache_control: BREAKPOINT })] },
    ]);
    expect(outcome).toBe("moved");
    expect(messages[0]).toEqual(firstTurn[0]);
    expect(messages[1]).toEqual({
      role: "system",
      content: [text(`${ENVIRONMENT}\n\n${DATE_TEXT}`)],
    });
    expect(messages[3].content).toEqual([
      {
        tool_use_id: "toolu_1",
        type: "tool_result",
        content: [text("out\n")],
        cache_control: BREAKPOINT,
      },
    ]);
    expect(messages).toHaveLength(4);
  });

  it("leaves a first turn alone and refuses a context without its date", () => {
    expect(rewrite(firstTurn).outcome).toBe("unchanged");
    expect(
      rewrite([
        { role: "user", content: [text(PROMPT)] },
        { role: "system", content: ENVIRONMENT },
        { role: "assistant", content: [text("hi")] },
        { role: "user", content: [text(CONTEXT_LINE), text("again")] },
      ]).outcome,
    ).toBe("unrecognized");
    expect(
      rewrite([
        { role: "user", content: [text(PROMPT)] },
        { role: "system", content: ENVIRONMENT },
        { role: "assistant", content: [text("hi")] },
      ]).outcome,
    ).toBe("unchanged");
  });
});

describe("injectSystemMessages", () => {
  const messages = [
    { role: "user", content: [text("one")] },
    { role: "assistant", content: [text("a")] },
    { role: "user", content: [text("two")] },
    { role: "assistant", content: [text("b")] },
    { role: "user", content: [text("three")] },
  ];
  const system = (value: string) => ({ role: "system", content: [text(value)] });
  const roles = (body: string) =>
    (JSON.parse(body).messages as Array<{ role: string; content: Array<{ text: string }> }>).map(
      (message) => (message.role === "system" ? `s:${message.content[0]?.text}` : message.role),
    );

  it("puts each before the assistant message that followed it, or at the end", () => {
    const result = injectSystemMessages(JSON.stringify({ messages }), [
      { beforeAssistant: 1, text: "x" },
      { beforeAssistant: 1, text: "y" },
      { beforeAssistant: null, text: "z" },
    ]);
    expect(result.injected).toBe(3);
    expect(roles(result.body)).toEqual([
      "user",
      "assistant",
      "user",
      "s:x",
      "s:y",
      "assistant",
      "user",
      "s:z",
    ]);
    expect(JSON.parse(result.body).messages[3]).toEqual(system("x"));
  });

  it("puts one whose assistant message is not in the request at the end, in order", () => {
    const result = injectSystemMessages(JSON.stringify({ messages: messages.slice(0, 1) }), [
      { beforeAssistant: 3, text: "late" },
      { beforeAssistant: 0, text: "early" },
      { beforeAssistant: null, text: "end" },
    ]);
    expect(roles(result.body)).toEqual(["user", "s:early", "s:late", "s:end"]);
  });

  it("leaves a request alone when there is nothing to add or it cannot be read", () => {
    const body = JSON.stringify({ messages });
    expect(injectSystemMessages(body, [])).toEqual({ body, injected: 0 });
    expect(injectSystemMessages("not json", [{ beforeAssistant: null, text: "x" }]).injected).toBe(
      0,
    );
    expect(injectSystemMessages("{}", [{ beforeAssistant: null, text: "x" }]).injected).toBe(0);
  });
});
