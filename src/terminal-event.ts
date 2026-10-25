/**
 * The one event that ends a pi assistant stream: `done` or `error`.
 *
 * Plain functions with no Effect import: `index.ts` uses them to report a
 * provider that failed to load, before any runtime exists.
 */

import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

/** End the stream successfully with the accumulated message. */
export function endStreamWithDone(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  stopReason: "stop" | "length" | "toolUse",
): void {
  stream.push({
    type: "done",
    reason: stopReason,
    message: { ...output, stopReason },
  });
  stream.end();
}

/**
 * End the stream with a structured assistant error carrying whatever was
 * streamed so far. Never a raw string, and never a success message.
 */
export function endStreamWithError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  reason: "error" | "aborted",
  errorMessage: string,
): void {
  stream.push({
    type: "error",
    reason,
    error: {
      ...output,
      content:
        output.content.length > 0
          ? output.content
          : [{ type: "text", text: `Error: ${errorMessage}` }],
      stopReason: reason,
      errorMessage,
    },
  });
  stream.end();
}
