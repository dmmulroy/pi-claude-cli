/**
 * Whether a newer Claude Code CLI is out than the one installed.
 *
 * The account's models come from the installed CLI (`src/account-models.ts`),
 * and a new model is listed only by the CLI release that added it: Fable 5.2
 * first appears in Claude Code 2.1.321. An outdated CLI therefore hides
 * models from pi's list with no hint why, so at pi start the provider
 * compares the installed version with the newest one published on npm and
 * offers to run `claude update`.
 *
 * The published versions are asked of the npm registry at most once a day
 * and kept in `cli-update.json` under the state directory, with the version
 * the user last declined, so a declined update is not offered again until a
 * newer one is out. The file holds version numbers and a timestamp only.
 *
 * Pure apart from the probes and the file, and free of Effect imports:
 * `index.ts` loads this at pi start.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { providerEnv } from "./provider-env.ts";
import {
  claudeCommand,
  claudeConfigEnvironment,
  claudeInstallationKey,
  withoutSubscriptionOverrides,
} from "./subscription-env.ts";

/** Claude Code's release channels, as its `autoUpdatesChannel` setting names them. */
export type CliReleaseChannel = "latest" | "stable";

/** The newest Claude Code version on each release channel. */
export interface PublishedCliVersions {
  readonly latest: string;
  readonly stable: string | undefined;
}

/** What one check found. */
export interface CliUpdateCheck {
  /** The installed CLI's version. */
  readonly installed: string;
  /** The newest version on the installation's release channel. */
  readonly available: string;
  readonly channel: CliReleaseChannel;
  /** True when `available` is newer than `installed`. */
  readonly updateAvailable: boolean;
  /** True when the user already declined updating to `available`. */
  readonly declined: boolean;
}

/** How long the published versions are served before npm is asked again. */
export const CLI_UPDATE_CHECK_TTL_MILLIS = 24 * 60 * 60 * 1000;

/** The npm dist-tags of the Claude Code package: `{ latest, stable, next }`. */
export const CLAUDE_CODE_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags";

const VERSION_TIMEOUT_MILLIS = 5_000;
const REGISTRY_TIMEOUT_MILLIS = 5_000;
/** `claude update` downloads a release; give it time. */
const UPDATE_TIMEOUT_MILLIS = 5 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const VERSION = /^\d+\.\d+\.\d+$/;
const isVersion = (value: unknown): value is string =>
  typeof value === "string" && VERSION.test(value);

/** The `major.minor.patch` in `claude --version` output (`2.1.312 (Claude Code)`). */
export function parseInstalledCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)(?=\s|$)/.exec(output.trim())?.[1];
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareCliVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Read the registry's dist-tags; anything without a `latest` version is nothing. */
export function parsePublishedCliVersions(text: string): PublishedCliVersions | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isVersion(parsed.latest)) return undefined;
  return { latest: parsed.latest, stable: isVersion(parsed.stable) ? parsed.stable : undefined };
}

/** The release channel a Claude Code `settings.json` picks; `latest` unless it says `stable`. */
export function parseCliReleaseChannel(settingsText: string | undefined): CliReleaseChannel {
  if (settingsText === undefined) return "latest";
  try {
    const parsed: unknown = JSON.parse(settingsText);
    return isRecord(parsed) && parsed.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

/** The installation's `settings.json`: under its config directory, else `~/.claude`. */
export function claudeSettingsFile(
  env: Readonly<Record<string, string | undefined>> = providerEnv(),
): string {
  const configured =
    claudeConfigEnvironment(env).CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR?.trim();
  const directory =
    configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".claude");
  return join(directory, "settings.json");
}

/** The environment a launch gives the CLI: subscription login, same installation. */
const cliEnvironment = (): Record<string, string | undefined> => ({
  ...withoutSubscriptionOverrides(providerEnv()),
  ...claudeConfigEnvironment(),
});

/**
 * The installed CLI's version.
 *
 * @returns Undefined when there is no CLI or its output has no version.
 *   Rejects only when `signal` aborts.
 */
export function probeInstalledCliVersion(signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      claudeCommand(),
      ["--version"],
      {
        env: cliEnvironment(),
        timeout: VERSION_TIMEOUT_MILLIS,
        killSignal: "SIGKILL",
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        if (signal?.aborted === true) return reject(signal.reason);
        resolve(error === null ? parseInstalledCliVersion(String(stdout)) : undefined);
      },
    );
  });
}

/**
 * The newest published versions, from the npm registry.
 *
 * @returns Undefined when the registry cannot be reached or answers
 *   something unreadable. Rejects only when `signal` aborts.
 */
export async function fetchPublishedCliVersions(
  signal?: AbortSignal,
): Promise<PublishedCliVersions | undefined> {
  const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MILLIS);
  try {
    const response = await fetch(CLAUDE_CODE_DIST_TAGS_URL, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: { accept: "application/json" },
    });
    return response.ok ? parsePublishedCliVersions(await response.text()) : undefined;
  } catch {
    if (signal?.aborted === true) throw signal.reason;
    return undefined;
  }
}

/** What `claude update` did. */
export interface CliUpdateResult {
  readonly ok: boolean;
  /** The last lines of its output, for the user when it failed. */
  readonly output: string;
}

/** Run `claude update` with the environment a launch gives the CLI. */
export function runCliUpdate(signal?: AbortSignal): Promise<CliUpdateResult> {
  return new Promise((resolve) => {
    execFile(
      claudeCommand(),
      ["update"],
      {
        env: cliEnvironment(),
        timeout: UPDATE_TIMEOUT_MILLIS,
        killSignal: "SIGKILL",
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        const output = `${String(stdout)}\n${String(stderr)}`
          .trim()
          .split("\n")
          .slice(-5)
          .join("\n");
        resolve({ ok: error === null, output });
      },
    );
  });
}

/** `$XDG_STATE_HOME/pi-claude-cli/cli-update.json`, or under `~/.local/state`. */
export function defaultCliUpdateFile(
  env: Readonly<Record<string, string | undefined>> = providerEnv(),
): string {
  const state = env.XDG_STATE_HOME?.trim();
  // Another installation (PI_CLAUDE_CLI_COMMAND / _CONFIG_DIR) keeps its own.
  const installation = claudeInstallationKey(env);
  const name =
    installation === undefined
      ? "cli-update.json"
      : `cli-update-${createHash("sha256").update(installation).digest("hex").slice(0, 12)}.json`;
  return join(
    state !== undefined && state.length > 0 ? state : join(homedir(), ".local", "state"),
    "pi-claude-cli",
    name,
  );
}

/** Where the check keeps its state between pi starts. */
export interface CliUpdateStore {
  /** The file's text, or undefined when there is none. */
  readonly read: () => Promise<string | undefined>;
  /** Replace the file's text; may reject, which the check ignores. */
  readonly write: (text: string) => Promise<void>;
}

/** A store in one owner-only file; failures read as nothing kept. */
export function fileCliUpdateStore(path: string): CliUpdateStore {
  return {
    read: () => readFile(path, "utf8").catch(() => undefined),
    write: async (text) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const partial = `${path}.${process.pid}.tmp`;
      await writeFile(partial, text, { mode: 0o600 });
      await chmod(partial, 0o600);
      await rename(partial, path);
    },
  };
}

/** The kept state: the published versions, when they were asked, what was declined. */
interface StoredCliUpdate {
  readonly checkedAt?: number;
  readonly published?: PublishedCliVersions;
  readonly declined?: string;
}

function readStored(text: string | undefined): StoredCliUpdate {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const published = isRecord(parsed.published)
    ? parsePublishedCliVersions(JSON.stringify(parsed.published))
    : undefined;
  return {
    ...(typeof parsed.checkedAt === "number" ? { checkedAt: parsed.checkedAt } : {}),
    ...(published === undefined ? {} : { published }),
    ...(isVersion(parsed.declined) ? { declined: parsed.declined } : {}),
  };
}

/** What a check asks; a subset, so tests can supply it. */
export interface CliUpdateProbes {
  readonly installedVersion: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly publishedVersions: (signal?: AbortSignal) => Promise<PublishedCliVersions | undefined>;
  /** The installation's `settings.json` text, or undefined when there is none. */
  readonly settings: () => Promise<string | undefined>;
}

/** The default probes: the installed CLI, the npm registry, the CLI's settings. */
export const defaultCliUpdateProbes = (): CliUpdateProbes => ({
  installedVersion: probeInstalledCliVersion,
  publishedVersions: fetchPublishedCliVersions,
  settings: () => readFile(claudeSettingsFile(), "utf8").catch(() => undefined),
});

/** The update check, served from the store and kept current. */
export interface CliUpdateChecker {
  /**
   * Compare the installed CLI with the newest published one. npm is asked
   * when the kept versions are a day old or `force` is set.
   *
   * @returns Undefined when there is no CLI or no published version is
   *   known. Rejects only when `signal` aborts.
   */
  readonly check: (options?: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  }) => Promise<CliUpdateCheck | undefined>;
  /** Remember that the user declined updating to `version`. */
  readonly decline: (version: string) => Promise<void>;
}

/** Build the checker over its probes and a store. */
export function createCliUpdateChecker(
  probes: CliUpdateProbes,
  store: CliUpdateStore,
  now: () => number = Date.now,
): CliUpdateChecker {
  const save = (state: StoredCliUpdate) =>
    store.write(JSON.stringify(state)).catch(() => undefined);

  return {
    check: async ({ force = false, signal } = {}) => {
      const installed = await probes.installedVersion(signal);
      if (installed === undefined) return undefined;
      let stored = readStored(await store.read());
      const age = stored.checkedAt === undefined ? Infinity : now() - stored.checkedAt;
      const fresh = age >= 0 && age < CLI_UPDATE_CHECK_TTL_MILLIS;
      if (force || !fresh || stored.published === undefined) {
        const published = await probes.publishedVersions(signal);
        if (published !== undefined) {
          stored = { ...stored, published, checkedAt: now() };
          await save(stored);
        }
      }
      if (stored.published === undefined) return undefined;
      const channel = parseCliReleaseChannel(await probes.settings());
      const available =
        channel === "stable"
          ? (stored.published.stable ?? stored.published.latest)
          : stored.published.latest;
      return {
        installed,
        available,
        channel,
        updateAvailable: compareCliVersions(available, installed) > 0,
        declined: stored.declined === available,
      };
    },
    decline: async (version) => {
      await save({ ...readStored(await store.read()), declined: version });
    },
  };
}

/** What the user is told about a check, and how serious it is. */
export function describeCliUpdate(check: CliUpdateCheck | undefined): {
  readonly level: "info" | "warning";
  readonly message: string;
} {
  if (check === undefined)
    return {
      level: "info",
      message: "Could not tell whether a newer Claude Code is out.",
    };
  if (!check.updateAvailable)
    return {
      level: "info",
      message: `Claude Code ${check.installed} is the newest on the ${check.channel} channel.`,
    };
  return {
    level: "warning",
    message:
      `Claude Code ${check.installed} is installed; ${check.available} is out (${check.channel} channel). ` +
      "pi-claude-cli lists only the models the installed CLI knows, so newer models stay hidden until it is updated.",
  };
}
