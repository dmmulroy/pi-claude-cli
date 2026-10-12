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

/** True when `version` is `MIN_SUPPORTED_CLI_VERSION` or newer. */
export const isSupportedCliVersion = (version: string): boolean => {
  const parts = version.split(".").map(Number);
  const floor = MIN_SUPPORTED_CLI_VERSION.split(".").map(Number);
  const difference = parts
    .map((part, index) => part - (floor[index] ?? 0))
    .find((delta) => delta !== 0);
  return difference === undefined || difference > 0;
};
