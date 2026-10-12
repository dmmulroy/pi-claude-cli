/**
 * Whether a pi call may continue the parked CLI process or needs a fresh one.
 *
 * A CLI process is a disposable cache of pi's history. It may serve the next
 * call only when it was launched the same way and has acknowledged exactly
 * the history that call extends; the decision is a pure function of those
 * facts so it can be tested without a process.
 */

import type { Message } from "@earendil-works/pi-ai";
import { Option } from "effect";

/**
 * Everything a process was launched with that a later call cannot change in
 * place. Thinking is deliberately absent: a live process takes a new level
 * through control requests.
 */
export interface LaunchSignature {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  /** The tool surface, as the JSON the in-band MCP server lists. */
  readonly tools: string;
  readonly handoff: boolean;
  readonly settings: string;
}

/** The pi history a process has acknowledged: a prefix length and its hash. */
export interface HistoryCheckpoint {
  readonly length: number;
  readonly hash: string;
}

/** Why a call could not reuse a process. */
export type SpawnReason =
  /** The pi call carries no session id, so nothing can be parked for it. */
  | "noSession"
  /** No process is parked for the session. */
  | "noParked"
  /** The latest assistant turn came from another provider. */
  | "foreignProvider"
  /** pi's history is not an extension of the acknowledged one. */
  | "history"
  /** The call adds something a live process cannot take. */
  | "delta"
  /** A handoff is open and the call does not answer exactly its tool calls. */
  | "handoffMismatch"
  /** The process refused the thinking change. */
  | "thinking"
  | `signature.${keyof LaunchSignature}`;

/** How an episode gets its process. */
export type EpisodeMode =
  | { readonly mode: "spawn"; readonly reason: SpawnReason }
  /** A new user turn on the parked process. */
  | { readonly mode: "turn" }
  /** pi's tool results answer the tool calls the parked process is blocked on. */
  | { readonly mode: "handoff" };

/** What is known about the parked process when the call arrives. */
export interface ParkedProcessFacts {
  readonly signature: LaunchSignature;
  readonly acknowledged: Option.Option<HistoryCheckpoint>;
  readonly turnActive: boolean;
  /** True when the process is blocked on exactly the given tool calls. */
  readonly awaitsToolResults: boolean;
}

/** What the call asks for. */
export interface EpisodeRequestFacts {
  readonly signature: LaunchSignature;
  /** pi's history, without system messages. */
  readonly messages: ReadonlyArray<Message>;
  /** Hash of the first `length` messages, as `historyHash` computes it. */
  readonly historyHashOfPrefix: (length: number) => string;
}

/** Messages after the last assistant turn: what this call adds. */
export const deltaMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> => {
  const lastAssistant = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  return messages.slice(lastAssistant + 1);
};

/**
 * True when pi's history moved on without this provider: the most recent
 * assistant turn came from another one (a model switch), so no process of
 * ours has seen that exchange.
 */
export const latestAssistantIsForeign = (
  messages: ReadonlyArray<Message>,
): boolean => {
  const latest = messages.findLast((message) => message.role === "assistant");
  return (
    latest !== undefined &&
    latest.role === "assistant" &&
    latest.provider !== "pi-claude-cli" &&
    latest.api !== "pi-claude-cli"
  );
};

const SIGNATURE_KEYS = [
  "model",
  "prompt",
  "cwd",
  "tools",
  "handoff",
  "settings",
] as const satisfies ReadonlyArray<keyof LaunchSignature>;

/** The first launch setting that differs, if any. */
export const firstSignatureDifference = (
  a: LaunchSignature,
  b: LaunchSignature,
): Option.Option<keyof LaunchSignature> =>
  Option.fromUndefinedOr(SIGNATURE_KEYS.find((key) => a[key] !== b[key]));

/** Decide how the call is served. Thinking is applied afterwards, on `turn`. */
export const decideEpisodeMode = (
  parked: Option.Option<ParkedProcessFacts>,
  request: EpisodeRequestFacts,
): EpisodeMode => {
  if (Option.isNone(parked)) return { mode: "spawn", reason: "noParked" };
  const { signature, acknowledged, turnActive, awaitsToolResults } =
    parked.value;
  const spawn = (reason: SpawnReason): EpisodeMode => ({
    mode: "spawn",
    reason,
  });
  if (latestAssistantIsForeign(request.messages))
    return spawn("foreignProvider");
  const difference = firstSignatureDifference(signature, request.signature);
  if (Option.isSome(difference)) return spawn(`signature.${difference.value}`);
  const historyMatches = Option.exists(
    acknowledged,
    (checkpoint) =>
      request.messages.length >= checkpoint.length &&
      request.historyHashOfPrefix(checkpoint.length) === checkpoint.hash,
  );
  if (!historyMatches) return spawn("history");

  const delta = deltaMessages(request.messages);
  const toolResults = delta.filter((message) => message.role === "toolResult");
  if (turnActive) {
    // Blocked in a tool call: only pi's results for exactly those calls can
    // continue the turn in-process.
    return toolResults.length === delta.length && awaitsToolResults
      ? { mode: "handoff" }
      : spawn("handoffMismatch");
  }
  const userMessages = delta.filter((message) => message.role === "user");
  return toolResults.length === 0 && userMessages.length > 0
    ? { mode: "turn" }
    : spawn("delta");
};
