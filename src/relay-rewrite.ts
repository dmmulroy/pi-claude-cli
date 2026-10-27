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
