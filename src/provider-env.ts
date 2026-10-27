/**
 * The provider's four user settings, resolved the way pi resolves a
 * provider's settings: through the auth hooks' context (`ctx.env`), which
 * sees pi's provider-scoped configuration as well as the process
 * environment. The latest values are kept so the launches, the probes, the
 * auth check and the runtime's own configuration all see the same ones.
 *
 *   PI_CLAUDE_CLI_COMMAND              the Claude Code executable
 *   PI_CLAUDE_CLI_CONFIG_DIR           its CLAUDE_CONFIG_DIR
 *   PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS  let calls be charged to usage credits
 *   PI_CLAUDE_CLI_TRACE                trace file path, or `off`
 *
 * Pure and free of Effect imports: `index.ts` loads it at pi start.
 */

/** The settings pi resolves for this provider. */
export const PROVIDER_SETTINGS = [
  "PI_CLAUDE_CLI_COMMAND",
  "PI_CLAUDE_CLI_CONFIG_DIR",
  "PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS",
  "PI_CLAUDE_CLI_TRACE",
] as const;

/** What a pi auth hook's context offers for reading settings. */
export interface SettingsContext {
  readonly env: (name: string) => Promise<string | undefined>;
}

let resolved: Record<string, string> = {};

/**
 * Read the settings through pi's auth context and keep them.
 *
 * @returns Only the settings that have a value, as pi's `ProviderEnv`.
 */
export async function resolveProviderSettings(
  ctx: SettingsContext,
): Promise<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const name of PROVIDER_SETTINGS) {
    const value = await ctx.env(name);
    if (value !== undefined) next[name] = value;
  }
  resolved = next;
  return { ...resolved };
}

/** The process environment with the settings pi resolved laid over it. */
export function providerEnv(): Record<string, string | undefined> {
  return { ...process.env, ...resolved };
}
