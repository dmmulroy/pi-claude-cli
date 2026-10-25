/**
 * Expected failures of a provider episode. Each carries the `message` pi
 * shows as the assistant error, so it says what failed and what to do.
 */

import { Data, Option } from "effect";

/** The installed CLI or its environment cannot provide what pi needs. */
export class CliRequirementError extends Data.TaggedError(
  "CliRequirementError",
)<{
  readonly reason: "NotInstalled" | "VersionTooOld" | "RestrictedMode";
  readonly message: string;
}> {}

/** The CLI process could not be started. */
export class CliSpawnError extends Data.TaggedError("CliSpawnError")<{
  readonly message: string;
}> {}

/** The private runtime directory or a file in it could not be written. */
export class RuntimeDirectoryError extends Data.TaggedError(
  "RuntimeDirectoryError",
)<{
  readonly operation: "CreateDirectory" | "StageSystemPrompt";
  readonly message: string;
}> {}

/** The CLI process ended; what is left of its inbox has been read. */
export class ProcessExited extends Data.TaggedError("ProcessExited")<{
  /** None when the process was killed by a signal or its exit was not seen. */
  readonly exitCode: Option.Option<number>;
  /** The most recent stderr output, possibly empty. */
  readonly stderrTail: string;
}> {
  override get message(): string {
    const code = Option.match(this.exitCode, {
      onNone: () => "no exit code",
      onSome: (exitCode) => `code ${exitCode}`,
    });
    const stderr = this.stderrTail.trim();
    return stderr.length > 0
      ? `Claude CLI exited with ${code}: ${stderr}`
      : `Claude CLI exited unexpectedly with ${code}`;
  }
}

/** A message was written to a CLI process that has already ended. */
export class ProcessGone extends Data.TaggedError("ProcessGone")<{
  readonly message: string;
}> {}

/** The CLI ended the turn with an error `result`. */
export class CliResultError extends Data.TaggedError("CliResultError")<{
  readonly message: string;
}> {}

/**
 * A model call was charged to usage credits instead of plan limits, and
 * `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS` is not set. The message contains
 * "billing", so pi does not retry it.
 */
export class UsageCreditsChargeError extends Data.TaggedError(
  "UsageCreditsChargeError",
)<{
  readonly message: string;
}> {}

/** The model stopped without an answer: a refusal or a safety stop. */
export class ModelStopError extends Data.TaggedError("ModelStopError")<{
  /** The API's stop reason: `refusal`, `sensitive`. */
  readonly stopReason: string;
  readonly message: string;
}> {}

/**
 * What the CLI streamed of an API message is not what it recorded of the
 * same message, so what pi received cannot be trusted; above all a tool
 * call's arguments.
 */
export class StreamMismatchError extends Data.TaggedError(
  "StreamMismatchError",
)<{
  readonly message: string;
}> {}

/**
 * The CLI wrote nothing to stdout for the configured idle timeout
 * (`PI_CLAUDE_CLI_TIMEOUT_MS`) while pi was waiting for it.
 */
export class InactivityTimeout extends Data.TaggedError("InactivityTimeout")<{
  readonly seconds: number;
}> {
  override get message(): string {
    return `Claude CLI stalled: it timed out after ${this.seconds} seconds without output and was stopped. Retry the request; raise PI_CLAUDE_CLI_TIMEOUT_MS (milliseconds) if the model legitimately needs longer.`;
  }
}

/** Every expected way an episode fails. */
export type EpisodeError =
  | CliRequirementError
  | CliSpawnError
  | RuntimeDirectoryError
  | ProcessExited
  | ProcessGone
  | CliResultError
  | UsageCreditsChargeError
  | ModelStopError
  | StreamMismatchError
  | InactivityTimeout;
