/**
 * The environment variables that would move the Claude CLI off the
 * subscription login. Pure and free of Effect imports: the auth check that
 * `index.ts` runs at pi start uses it as well as every launch.
 */

import { providerEnv } from "./provider-env.ts";

/**
 * Environment variables that redirect the CLI away from its subscription
 * login: an API key or token, a gateway, or another model provider (Bedrock,
 * Vertex, Foundry, Claude Platform on AWS). Never forwarded: turns would bill
 * another account, or fail against a gateway that was meant for another
 * tool. The names are Claude Code's (code.claude.com/docs/en/env-vars).
 */
export const SUBSCRIPTION_OVERRIDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

/** `env` without the variables that would move the CLI off the subscription. */
export function withoutSubscriptionOverrides(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const kept = { ...env };
  for (const name of SUBSCRIPTION_OVERRIDE_ENV_VARS) delete kept[name];
  return kept;
}

/**
 * The Claude Code executable: `PI_CLAUDE_CLI_COMMAND` (a path or a name on
 * `PATH`), or `claude`. Every launch, probe and auth check uses it.
 */
export function claudeCommand(
  env: Readonly<Record<string, string | undefined>> = providerEnv(),
): string {
  const command = env.PI_CLAUDE_CLI_COMMAND?.trim();
  return command !== undefined && command.length > 0 ? command : "claude";
}

/**
 * The CLI's configuration directory for every launch, probe and auth check:
 * `PI_CLAUDE_CLI_CONFIG_DIR` as `CLAUDE_CONFIG_DIR`, or nothing, which leaves
 * an inherited `CLAUDE_CONFIG_DIR` (or the CLI's default) in place.
 */
export function claudeConfigEnvironment(
  env: Readonly<Record<string, string | undefined>> = providerEnv(),
): Record<string, string> {
  const directory = env.PI_CLAUDE_CLI_CONFIG_DIR?.trim();
  return directory !== undefined && directory.length > 0 ? { CLAUDE_CONFIG_DIR: directory } : {};
}

/**
 * A short name for the installation the provider talks to, or none for the
 * default one: different installations keep their login state apart.
 */
export function claudeInstallationKey(
  env: Readonly<Record<string, string | undefined>> = providerEnv(),
): string | undefined {
  const command = claudeCommand(env);
  const directory = claudeConfigEnvironment(env).CLAUDE_CONFIG_DIR;
  if (command === "claude" && directory === undefined) return undefined;
  return `${command}\u0000${directory ?? ""}`;
}
