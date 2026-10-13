/**
 * What this provider requires of the installed Claude Code CLI.
 *
 * pi owns the prompt, tools and conversation; the CLI must honour the flags
 * and environment controls that keep its own memory, skills, settings and
 * native tools out of the way, and must host an in-band MCP server. Older
 * CLIs are not assumed to.
 */

import { Option } from "effect";

/**
 * Oldest Claude Code version the launch flags and in-band MCP were tested on.
 * 2.1.263 hosts the in-band server but ignores
 * `notifications/tools/list_changed`; 2.1.265 is the first that lists the
 * tools again, which a tool change on a live process depends on.
 */
export const MIN_SUPPORTED_CLI_VERSION = "2.1.265";

/** The `major.minor.patch` in `claude --version` output, when there is one. */
export const parseCliVersion = (versionOutput: string): Option.Option<string> =>
  Option.fromNullOr(/(\d+\.\d+\.\d+)(?=\s|$)/.exec(versionOutput.trim())).pipe(
    Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
  );

/**
 * Oldest Claude Code version whose stdin was seen to take a structured
 * history: held user messages (`shouldQuery: false`) and replayed assistant
 * messages, in order. Read off the wire on 2.1.292; nothing older was tried,
 * and a CLI that does not know `shouldQuery` would answer each replayed user
 * message with a model call.
 */
export const MIN_STRUCTURED_IMPORT_CLI_VERSION = "2.1.292";

/** True when `version` is `floor` or newer. */
const isAtLeast = (version: string, floor: string): boolean => {
  const parts = version.split(".").map(Number);
  const floorParts = floor.split(".").map(Number);
  const difference = parts
    .map((part, index) => part - (floorParts[index] ?? 0))
    .find((delta) => delta !== 0);
  return difference === undefined || difference > 0;
};

/** True when `version` is `MIN_SUPPORTED_CLI_VERSION` or newer. */
export const isSupportedCliVersion = (version: string): boolean =>
  isAtLeast(version, MIN_SUPPORTED_CLI_VERSION);

/** True when `version` takes a structured history on stdin. */
export const supportsStructuredImport = (version: string): boolean =>
  isAtLeast(version, MIN_STRUCTURED_IMPORT_CLI_VERSION);
