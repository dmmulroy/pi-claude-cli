/**
 * The environment variables that would move the Claude CLI off the
 * subscription login. Pure and free of Effect imports: the auth check that
 * `index.ts` runs at pi start uses it as well as every launch.
 */

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
