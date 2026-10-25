/**
 * Whether the Claude CLI is installed and logged in, and with what plan, as
 * `claude auth status` reports it. pi asks this through the provider's auth
 * check, which decides whether pi offers the provider's models and whether
 * it labels their cost as a subscription's.
 *
 * pi waits for every provider's auth check before it chooses the startup
 * model, and launching the CLI takes about 150 ms. So the last answer is
 * kept in a small file under the state directory (`auth-status.json`: the
 * three facts below and when they were checked, no account details), served
 * at once, and checked again in the background. Only a first start, or one
 * after a day without pi, waits for the CLI.
 *
 * Pure apart from the probe and the file, and free of Effect imports:
 * `index.ts` loads this at pi start.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthCheck } from "@earendil-works/pi-ai";
import { withoutSubscriptionOverrides } from "./subscription-env.ts";

/** What `claude auth status` says about the CLI's login. */
export interface CliAuthStatus {
  /** False when there is no `claude` executable to ask. */
  readonly installed: boolean;
  /** Undefined when the CLI's answer could not be read. */
  readonly loggedIn: boolean | undefined;
  /** The Claude plan (`pro`, `max`, …) of a subscription login. */
  readonly subscriptionType: string | undefined;
}

/** A status as kept in the file: the status and when it was checked. */
interface StoredCliAuthStatus extends CliAuthStatus {
  readonly checkedAt: number;
}

/** How long a kept status is served before pi waits for the CLI again. */
export const CLI_AUTH_STATUS_TTL_MILLIS = 24 * 60 * 60 * 1000;

/** How long `claude auth status` may take. */
const AUTH_STATUS_TIMEOUT_MILLIS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read `claude auth status` output; anything unreadable is "unknown". */
export function parseCliAuthStatus(stdout: string): CliAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  const loggedIn = isRecord(parsed) ? parsed.loggedIn : undefined;
  const plan = isRecord(parsed) ? parsed.subscriptionType : undefined;
  return {
    installed: true,
    loggedIn: typeof loggedIn === "boolean" ? loggedIn : undefined,
    subscriptionType:
      loggedIn === true && typeof plan === "string" && plan.length > 0 ? plan : undefined,
  };
}

/**
 * Ask the installed CLI, with the environment a launch gives it, so a host
 * API key does not make an API login look like the subscription's.
 *
 * @returns The status; a CLI that is missing reads as not installed, and one
 *   that fails or times out as installed with an unknown login. Rejects only
 *   when `signal` aborts.
 */
export function probeCliAuthStatus(signal?: AbortSignal): Promise<CliAuthStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      ["auth", "status"],
      {
        env: withoutSubscriptionOverrides(process.env),
        timeout: AUTH_STATUS_TIMEOUT_MILLIS,
        killSignal: "SIGKILL",
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        if (signal?.aborted === true) return reject(signal.reason);
        if (error?.code === "ENOENT")
          return resolve({
            installed: false,
            loggedIn: undefined,
            subscriptionType: undefined,
          });
        // A logged-out CLI answers and exits non-zero: its output still counts.
        resolve(parseCliAuthStatus(String(stdout)));
      },
    );
  });
}

/** `$XDG_STATE_HOME/pi-claude-cli/auth-status.json`, or under `~/.local/state`. */
export function defaultCliAuthStatusFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const state = env.XDG_STATE_HOME?.trim();
  return join(
    state !== undefined && state.length > 0 ? state : join(homedir(), ".local", "state"),
    "pi-claude-cli",
    "auth-status.json",
  );
}

/** Where a status is kept between pi starts. */
export interface CliAuthStatusStore {
  /** The file's text, or undefined when there is none. */
  readonly read: () => Promise<string | undefined>;
  /** Replace the file's text; may reject, which the cache ignores. */
  readonly write: (text: string) => Promise<void>;
}

/** A store in one owner-only file; failures read as nothing kept. */
export function fileCliAuthStatusStore(path: string): CliAuthStatusStore {
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

function readStored(text: string | undefined): StoredCliAuthStatus | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { installed, loggedIn, subscriptionType, checkedAt } = parsed;
  if (
    typeof installed !== "boolean" ||
    (loggedIn !== undefined && typeof loggedIn !== "boolean") ||
    (subscriptionType !== undefined && typeof subscriptionType !== "string") ||
    typeof checkedAt !== "number"
  )
    return undefined;
  return { installed, loggedIn, subscriptionType, checkedAt };
}

/** The CLI's login, served from memory or the store and kept current. */
export interface CliAuthStatusCache {
  /**
   * The status pi should go by now: the one in memory, else a fresh one from
   * the store (checked again in the background), else the CLI's answer.
   * Rejects only when `signal` aborts.
   */
  readonly status: (signal?: AbortSignal) => Promise<CliAuthStatus>;
  /** Ask the CLI now and keep its answer. Rejects only when `signal` aborts. */
  readonly refresh: (signal?: AbortSignal) => Promise<CliAuthStatus>;
}

/** `promise`, or a rejection with the abort reason once `signal` aborts. */
function untilAborted<A>(promise: Promise<A>, signal?: AbortSignal): Promise<A> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Build the cache over a probe and a store.
 *
 * Callers share one CLI launch: pi asks for the status of every provider at
 * once, and more than once while it starts. The launch is not tied to any
 * caller's abort signal; its answer is kept even when the caller that
 * started it has gone.
 */
export function createCliAuthStatusCache(
  probe: () => Promise<CliAuthStatus>,
  store: CliAuthStatusStore,
  now: () => number = Date.now,
): CliAuthStatusCache {
  let current: CliAuthStatus | undefined;
  /** The CLI launch in flight, which every caller joins. */
  let probing: Promise<CliAuthStatus> | undefined;
  /** The first answer while it is being looked up. */
  let loading: Promise<CliAuthStatus> | undefined;
  let checkedInBackground = false;

  const probeOnce = (): Promise<CliAuthStatus> =>
    (probing ??= (async () => {
      try {
        const status = await probe();
        current = status;
        const stored: StoredCliAuthStatus = { ...status, checkedAt: now() };
        await store.write(JSON.stringify(stored)).catch(() => undefined);
        return status;
      } finally {
        probing = undefined;
      }
    })());

  const load = async (): Promise<CliAuthStatus> => {
    const stored = readStored(await store.read());
    const age = stored === undefined ? Infinity : now() - stored.checkedAt;
    if (stored === undefined || age < 0 || age >= CLI_AUTH_STATUS_TTL_MILLIS) return probeOnce();
    current ??= {
      installed: stored.installed,
      loggedIn: stored.loggedIn,
      subscriptionType: stored.subscriptionType,
    };
    // Once per cache: the next start goes by today's answer.
    if (!checkedInBackground) {
      checkedInBackground = true;
      probeOnce().catch(() => undefined);
    }
    return current;
  };

  return {
    status: (signal) =>
      current !== undefined
        ? Promise.resolve(current)
        : untilAborted(
            (loading ??= load().finally(() => {
              loading = undefined;
            })),
            signal,
          ),
    refresh: (signal) => untilAborted(probeOnce(), signal),
  };
}

/**
 * The provider's auth check: configured when the CLI is installed and not
 * known to be logged out; a subscription login reports as OAuth-shaped, so
 * pi labels its list-price cost "(sub)".
 */
export function providerAuthCheck(status: CliAuthStatus): AuthCheck | undefined {
  if (!status.installed || status.loggedIn === false) return undefined;
  return status.subscriptionType === undefined
    ? { type: "api_key", source: "Claude Code CLI" }
    : { type: "oauth", source: `Claude Code ${status.subscriptionType}` };
}

/** What the status command tells the user, and how serious it is. */
export function describeCliAuthStatus(status: CliAuthStatus): {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
} {
  if (!status.installed)
    return {
      level: "error",
      message:
        "Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude auth login`.",
    };
  if (status.loggedIn === false)
    return {
      level: "error",
      message: "Claude Code is installed but not logged in. Run `claude auth login` and try again.",
    };
  if (status.loggedIn === undefined)
    return {
      level: "warning",
      message:
        "Claude Code is installed, but `claude auth status` gave no answer pi-claude-cli could read.",
    };
  return status.subscriptionType === undefined
    ? {
        level: "warning",
        message:
          "Claude Code is logged in without a Claude subscription: model calls are not billed to a Pro or Max plan.",
      }
    : {
        level: "info",
        message: `Claude Code is logged in with a Claude ${status.subscriptionType} subscription.`,
      };
}
