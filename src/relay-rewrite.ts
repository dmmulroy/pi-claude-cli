/**
 * The turn relay's request rewrites (`PI_CLAUDE_CLI_RELAY=rewrite`).
 *
 * One rewrite so far: the CLI's session context. Claude Code attaches two
 * reminders, the session context ("As you answer the user's questions…",
 * with the account's email) and the date, to the first user message it
 * sends the model. In a process whose first turn is pi's first message that
 * is message 0, and it stays there for the life of the process. In a process
 * that took pi's history as an import, it is the last message instead, so
 * every fresh process puts them somewhere else, the request differs from
 * the one before from that message on, and the prompt cache is missed.
 *
 * `canonicalSessionContext` moves them back to where a first turn puts them,
 * byte for byte as Claude Code 2.1.299 writes it:
 *
 *   first turn, message 0:  [env, model, context, date + "\n", prompt]
 *   import, message 0:      [env, model + "\n", prompt]
 *   import, last message:   [..., X + "\n", context + "\n", date]   (a tool result)
 *                           [context, date + "\n", text, ...]        (user text)
 *
 * Anything it does not recognize exactly is sent as it came.
 *
 * Pure: the relay calls it with the request body as text.
 */

const REMINDER_PREFIX = "<system-reminder>\n";
const CONTEXT_PREFIX = `${REMINDER_PREFIX}As you answer the user's questions, you can use the following context:\n`;
const DATE_PREFIX = `${REMINDER_PREFIX}Today's date is `;

/** What the rewrite did with one request. */
export type RewriteOutcome =
  /** Nothing to move: the context is already in message 0, or nowhere. */
  | "unchanged"
  /** The context was moved to message 0. */
  | "moved"
  /** The context is somewhere the rewrite does not know; sent as it came. */
  | "unrecognized";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Block = { [key: string]: Json };

const isObject = (value: Json | undefined): value is Block =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (block: Json | undefined): string | undefined =>
  isObject(block) && block["type"] === "text" && typeof block["text"] === "string"
    ? block["text"]
    : undefined;

const isReminder = (block: Json | undefined) => textOf(block)?.startsWith(REMINDER_PREFIX) === true;
const isContext = (block: Json | undefined) => textOf(block)?.startsWith(CONTEXT_PREFIX) === true;
const isDate = (block: Json | undefined) => textOf(block)?.startsWith(DATE_PREFIX) === true;

const withoutOneNewline = (text: string): string | undefined =>
  text.endsWith("\n") ? text.slice(0, -1) : undefined;

/** Where the CLI put the session context in an imported process. */
interface Found {
  /** The content array holding it: a user message's, or a tool result's. */
  readonly blocks: Json[];
  /** The user message's own content, where a cache breakpoint may sit. */
  readonly messageContent: Json[];
  readonly start: number;
}

const findContext = (messages: Json[]): Found | undefined => {
  for (const message of messages.slice(1)) {
    if (!isObject(message) || message["role"] !== "user") continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    const start = content.findIndex(isContext);
    if (start >= 0) return { blocks: content, messageContent: content, start };
    for (const block of content) {
      if (!isObject(block) || block["type"] !== "tool_result") continue;
      const inner = block["content"];
      if (!Array.isArray(inner)) continue;
      const nested = inner.findIndex(isContext);
      if (nested >= 0) return { blocks: inner, messageContent: content, start: nested };
    }
  }
  return undefined;
};

const SYSTEM_DATE_PREFIX = "Today's date is ";

/** The text of a message's content, whether a string or one text block. */
const soleText = (message: Json | undefined): string | undefined => {
  if (!isObject(message)) return undefined;
  const content = message["content"];
  if (typeof content === "string") return content;
  return Array.isArray(content) && content.length === 1 ? textOf(content[0]) : undefined;
};

/**
 * The same move for models that take system messages mid conversation, for
 * which Claude Code 2.1.299 lays the context out differently: the
 * environment is a system message after message 0, and the date joins it.
 *
 *   first turn:  m0 [context, prompt]  m1 system "env\n\nToday's date is D."
 *   import:      m0 [prompt]           m1 system "env"
 *                ... user [context, text]  system "Today's date is D."
 *                ... user [tool_result [X + "\n", context]]  system "Today's date is D."
 *
 * @returns The rewritten request, `unchanged` with nothing to move, or
 *   undefined for a layout it does not know.
 */
const systemLayoutSessionContext = (
  request: Block,
  messages: Json[],
  head: Json[],
): { readonly body: string; readonly outcome: RewriteOutcome } | undefined => {
  const environment = messages[1];
  const environmentText = soleText(environment);
  if (!isObject(environment) || environmentText === undefined) return undefined;
  // The context opens a user message's text, or closes a tool result's.
  let at = -1;
  let take: (() => Block) | undefined;
  for (const [index, message] of messages.entries()) {
    if (index < 2 || !isObject(message) || message["role"] !== "user") continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    if (isContext(content[0]) && content.length >= 2) {
      at = index;
      take = () => content.shift() as Block;
      break;
    }
    const result = content.find(
      (block) =>
        isObject(block) &&
        block["type"] === "tool_result" &&
        Array.isArray(block["content"]) &&
        isContext(block["content"][block["content"].length - 1]),
    ) as Block | undefined;
    if (result !== undefined) {
      const inner = result["content"] as Json[];
      const before = inner[inner.length - 2];
      const beforeText = textOf(before);
      const restored = beforeText === undefined ? undefined : withoutOneNewline(beforeText);
      if (!isObject(before) || restored === undefined) return undefined;
      at = index;
      take = () => {
        const context = inner.pop() as Block;
        inner[inner.length - 1] = { ...before, text: restored };
        return context;
      };
      break;
    }
  }
  if (at < 0 || take === undefined) return { body: JSON.stringify(request), outcome: "unchanged" };
  const holderContent = (messages[at] as Block)["content"] as Json[];
  const date = messages[at + 1];
  const dateText = soleText(date);
  if (
    !isObject(date) ||
    date["role"] !== "system" ||
    dateText === undefined ||
    !dateText.startsWith(SYSTEM_DATE_PREFIX) ||
    environmentText.includes(SYSTEM_DATE_PREFIX)
  )
    return undefined;

  const { cache_control: contextBreakpoint, ...contextBlock } = take();
  const dateContent = date["content"];
  const dateBreakpoint =
    Array.isArray(dateContent) && isObject(dateContent[0])
      ? dateContent[0]["cache_control"]
      : undefined;
  const breakpoint = dateBreakpoint ?? contextBreakpoint;

  // The context back on message 0, joined to pi's text by a newline as a
  // first turn has it; the date back in the environment.
  const contextText = textOf(contextBlock) ?? "";
  head.unshift({
    ...contextBlock,
    text: contextText.endsWith("\n") ? contextText : `${contextText}\n`,
  });
  const joined = `${environmentText}\n\n${dateText}`;
  const environmentContent = environment["content"];
  if (typeof environmentContent === "string") environment["content"] = joined;
  else if (Array.isArray(environmentContent) && isObject(environmentContent[0]))
    environmentContent[0] = { ...environmentContent[0], text: joined };
  // The breakpoint the date carried stays at the end of the conversation.
  if (breakpoint !== undefined) {
    const last = holderContent[holderContent.length - 1];
    if (isObject(last))
      holderContent[holderContent.length - 1] = { ...last, cache_control: breakpoint };
  }
  messages.splice(at + 1, 1);
  return { body: JSON.stringify(request), outcome: "moved" };
};

/**
 * Move the session context of an imported process to message 0, where the
 * process's first turn would have put it.
 *
 * @returns The body to send, unchanged unless the outcome is `moved`.
 */
export const canonicalSessionContext = (
  body: string,
): { readonly body: string; readonly outcome: RewriteOutcome } => {
  const unchanged = { body, outcome: "unchanged" as const };
  const unrecognized = { body, outcome: "unrecognized" as const };
  let request: Json;
  try {
    request = JSON.parse(body) as Json;
  } catch {
    return unrecognized;
  }
  if (!isObject(request) || !Array.isArray(request["messages"])) return unchanged;
  const messages = request["messages"];
  const first = messages[0];
  if (!isObject(first) || first["role"] !== "user" || !Array.isArray(first["content"]))
    return unchanged;
  const head = first["content"];
  if (head.some(isContext)) return unchanged;
  if (isObject(messages[1]) && messages[1]["role"] === "system")
    return systemLayoutSessionContext(request, messages, head) ?? unrecognized;
  const found = findContext(messages);
  if (found === undefined) return unchanged;

  // The context and the date after it: either the last blocks of their
  // array, after a text block the CLI joined them to with a newline, or the
  // first blocks of a user message, joined to its text by the date's newline.
  const { blocks, start } = found;
  const run = isDate(blocks[start + 1]) ? 2 : 1;
  const appended = start > 0 && start + run === blocks.length;
  const prepended =
    start === 0 &&
    blocks === found.messageContent &&
    run < blocks.length &&
    !isReminder(blocks[run]) &&
    textOf(blocks[run - 1])?.endsWith("\n") === true;
  if (!appended && !prepended) return unrecognized;
  const before = appended ? blocks[start - 1] : undefined;
  const beforeText = textOf(before);
  const beforeRestored = beforeText === undefined ? undefined : withoutOneNewline(beforeText);
  if (appended && (!isObject(before) || beforeRestored === undefined)) return unrecognized;

  // Message 0: the reminders, then pi's content. The last reminder carries
  // the newline that joins them to it.
  const prompt = head.findIndex((block) => !isReminder(block));
  if (prompt < 1) return unrecognized;
  const lastReminder = head[prompt - 1];
  const lastReminderText = textOf(lastReminder);
  const lastReminderRestored =
    lastReminderText === undefined ? undefined : withoutOneNewline(lastReminderText);
  if (!isObject(lastReminder) || lastReminderRestored === undefined) return unrecognized;

  const moved = blocks.slice(start, start + run).map((block, index, all) => {
    const text = textOf(block) ?? "";
    const bare = text.endsWith("\n") ? text.slice(0, -1) : text;
    const { cache_control: _breakpoint, ...rest } = block as Block;
    return { ...rest, text: index === all.length - 1 ? `${bare}\n` : bare } satisfies Block;
  });
  // A breakpoint on a moved block stays at the end of its message.
  const breakpoint = blocks
    .slice(start)
    .map((block) => (isObject(block) ? block["cache_control"] : undefined))
    .find((control) => control !== undefined);

  blocks.splice(start, run);
  if (isObject(before) && beforeRestored !== undefined)
    blocks[start - 1] = { ...before, text: beforeRestored };
  if (breakpoint !== undefined && found.messageContent === blocks) {
    const last = blocks[blocks.length - 1];
    if (isObject(last)) blocks[blocks.length - 1] = { ...last, cache_control: breakpoint };
  }
  head[prompt - 1] = { ...lastReminder, text: lastReminderRestored };
  head.splice(prompt, 0, ...moved);
  return { body: JSON.stringify(request), outcome: "moved" };
};

/** A system message to add to the request; see `SystemUpdate` in `pi-context`. */
export interface SystemInjection {
  /** Before the assistant message with this ordinal, or at the end. */
  readonly beforeAssistant: number | null;
  readonly text: string;
}

/**
 * Add pi's later system messages to a request where they occurred in pi's
 * conversation: each before the assistant message that followed it, as pi's
 * own Anthropic provider places them. One whose assistant message the
 * request does not have (a flat import has none) goes at the end.
 *
 * The CLI's own history never holds them; they are added to every request,
 * so the model sees pi's conversation however the process got its history.
 *
 * @returns The body to send and how many messages were added.
 */
export const injectSystemMessages = (
  body: string,
  injections: ReadonlyArray<SystemInjection>,
): { readonly body: string; readonly injected: number } => {
  if (injections.length === 0) return { body, injected: 0 };
  let request: Json;
  try {
    request = JSON.parse(body) as Json;
  } catch {
    return { body, injected: 0 };
  }
  if (!isObject(request) || !Array.isArray(request["messages"])) return { body, injected: 0 };
  const system = (text: string): Block => ({
    role: "system",
    content: [{ type: "text", text }],
  });
  const before = new Map<number, string[]>();
  const atEnd: string[] = [];
  for (const injection of injections) {
    if (injection.beforeAssistant === null) atEnd.push(injection.text);
    else
      before.set(injection.beforeAssistant, [
        ...(before.get(injection.beforeAssistant) ?? []),
        injection.text,
      ]);
  }
  const messages: Json[] = [];
  let assistants = 0;
  for (const message of request["messages"]) {
    if (isObject(message) && message["role"] === "assistant") {
      for (const text of before.get(assistants) ?? []) messages.push(system(text));
      before.delete(assistants);
      assistants += 1;
    }
    messages.push(message);
  }
  for (const texts of [...before.entries()].sort(([a], [b]) => a - b).map(([, texts]) => texts))
    for (const text of texts) messages.push(system(text));
  for (const text of atEnd) messages.push(system(text));
  request["messages"] = messages;
  return { body: JSON.stringify(request), injected: injections.length };
};
