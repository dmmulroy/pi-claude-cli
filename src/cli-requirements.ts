/**
 * What this provider requires of the installed Claude Code CLI.
 *
 * pi owns the prompt, tools and conversation; the CLI must honour the flags
 * and environment controls that keep its own memory, skills, settings and
 * native tools out of the way. Older CLIs are not assumed to.
 */

/** The CLI or its environment cannot provide the isolation pi needs. */
export class CliRequirementError extends Error {}

/** Oldest Claude Code version whose isolation controls were tested. */
export const MIN_SUPPORTED_CLI_VERSION = "2.1.263";

/**
 * Throw unless `claude --version` output names a supported version.
 *
 * @throws CliRequirementError when the version is older than
 *   MIN_SUPPORTED_CLI_VERSION or cannot be parsed
 */
export function assertSupportedCliVersion(versionOutput: string): void {
  const match = /(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(versionOutput.trim());
  const parts = match?.slice(1).map(Number);
  const floor = MIN_SUPPORTED_CLI_VERSION.split(".").map(Number);
  const difference = parts
    ?.map((part, i) => part - floor[i])
    .find((n) => n !== 0);
  if (!parts || (difference !== undefined && difference < 0)) {
    throw new CliRequirementError(
      `pi-claude-cli requires Claude Code ${MIN_SUPPORTED_CLI_VERSION}+ (the tested isolation controls). Update Claude Code.`,
    );
  }
}
