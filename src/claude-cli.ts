/**
 * Launching the Claude Code CLI so that pi owns the prompt and the tools.
 *
 * Every launch replaces Claude Code's system prompt with pi's, disables the
 * native tools, session persistence and every user/project setting source,
 * and advertises pi's tools through the in-band MCP server. Subscription
 * OAuth is kept: `--bare` is never used, and the variables that would move
 * the CLI off the subscription login are removed from its environment.
 */

import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  type PlatformError,
  Ref,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  isSupportedCliVersion,
  MIN_SUPPORTED_CLI_VERSION,
  parseCliVersion,
} from "./cli-requirements.ts";
import { CliRequirementError, CliSpawnError } from "./errors.ts";
import { INBAND_MCP_CONFIG_JSON } from "./mcp-inband.ts";
import { nodeChildProcessSpawnerLayer } from "./node-platform.ts";
import { ProviderConfig, providerConfigLayer } from "./provider-config.ts";
import {
  claudeCommand,
  claudeConfigEnvironment,
  SUBSCRIPTION_OVERRIDE_ENV_VARS,
} from "./subscription-env.ts";
import { type CliThinking, thinkingSpawnArgs } from "./thinking-config.ts";

/** How long `claude --version` and `claude auth status` may take. */
const CLI_PROBE_TIMEOUT = Duration.seconds(5);

/** What one CLI process is launched with. */
export interface ClaudeCliLaunch {
  /** Provider-minted id for this process; never pi's session id. */
  readonly cliSessionId: string;
  readonly modelId: string;
  /** File holding pi's system prompt, which replaces Claude Code's. */
  readonly systemPromptFile: string;
  readonly cwd: string;
  /** The thinking the process starts with; later turns may change it. */
  readonly thinking: CliThinking;
  /** The process's stdin; ending the stream closes it. */
  readonly stdin: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  /** The turn relay's route, as `ANTHROPIC_BASE_URL`; none talks to the API directly. */
  readonly baseUrl: Option.Option<string>;
}

/** Defines the Claude Code CLI launcher. */
export interface IClaudeCli {
  /**
   * Start a CLI process that lives until the scope closes; whatever is still
   * running then is killed.
   *
   * @returns The process handle, `CliRequirementError` when the CLI is
   *   missing, too old or in a restricted mode, or `CliSpawnError` when it
   *   could not be started.
   */
  readonly spawn: (
    launch: ClaudeCliLaunch,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    CliRequirementError | CliSpawnError,
    Scope.Scope
  >;
  /** The installed CLI's version, once a launch has established it. */
  readonly version: Effect.Effect<Option.Option<string>>;
}

/** Provides the Claude Code CLI launcher. */
export class ClaudeCli extends Context.Service<ClaudeCli, IClaudeCli>()(
  "pi-claude-cli/ClaudeCli",
) {}

const notInstalled = new CliRequirementError({
  reason: "NotInstalled",
  message:
    "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\nThen authenticate by running `claude` and using `/login`.",
});

const AuthStatus = Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean }));
const decodeAuthStatus = Schema.decodeOption(AuthStatus);

/** The launch flags. pi's prompt and session id are the only variable values. */
const launchArguments = (
  launch: ClaudeCliLaunch,
  settingsPath: Option.Option<string>,
): ReadonlyArray<string> => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model",
  launch.modelId,
  "--permission-prompt-tool",
  "stdio",
  // Not auto mode: it puts Claude Code's own working instructions ("## Auto
  // Mode Active") into pi's conversation. Permission requests still come to
  // the provider over stdio.
  "--permission-mode",
  "default",
  // Only the in-band server carrying pi's tools; the user's personal and
  // project MCP servers stay out.
  "--strict-mcp-config",
  // No user/project/local settings: hooks, CLAUDE.md memory, permission
  // allowlists. Explicit host --settings and managed policy still apply.
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-chrome",
  // No native tools: every tool is pi's.
  "--tools",
  "",
  "--session-id",
  launch.cliSessionId,
  // The process is a disposable cache of pi's history and is never resumed.
  "--no-session-persistence",
  // The `-file` suffix is required: the unsuffixed flag takes a literal
  // string, so handing it a path would make the path the prompt.
  "--system-prompt-file",
  launch.systemPromptFile,
  ...Option.match(settingsPath, {
    onNone: () => [],
    onSome: (path) => ["--settings", path],
  }),
  ...thinkingSpawnArgs(launch.thinking),
  "--mcp-config",
  INBAND_MCP_CONFIG_JSON,
];

/**
 * Child-only environment: what Claude Code must not do on its own. The names
 * are Claude Code's documented ones (code.claude.com/docs/en/env-vars) and
 * were checked on the wire against claude 2.1.292.
 */
export const launchEnvironment = (
  mcpToolTimeoutMillis: string,
): Record<string, string | undefined> => ({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  // pi owns compaction: no automatic compaction, and no `/compact` either.
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  // pi owns retries: a failed API request is reported to pi at once, which
  // retries with its own backoff. The CLI's default is 10 attempts of its
  // own, during which pi sees a silent stream.
  CLAUDE_CODE_MAX_RETRIES: "0",
  // No auto-update, telemetry, error reporting, release notes or
  // availability checks from a process pi is driving. This also turns off
  // feature-flag fetching, so the CLI runs on its built-in flag defaults.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ENABLE_TOOL_SEARCH: "false",
  // No `<total_tokens>N tokens left</total_tokens>` countdown in the
  // conversation: pi owns the context, and the CLI's own budget is not pi's.
  // `off` is the value the CLI reads (checked in claude 2.1.299).
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
  MCP_TOOL_TIMEOUT: mcpToolTimeoutMillis,
  // `undefined` removes the variable from the inherited environment.
  ...Object.fromEntries(SUBSCRIPTION_OVERRIDE_ENV_VARS.map((name) => [name, undefined])),
  // The unattended-session watchdog retries capacity errors indefinitely
  // and overrides the retry count above.
  CLAUDE_CODE_RETRY_WATCHDOG: undefined,
  // JSON merged into every API request body: a host's setting for its own
  // Claude Code would change the requests pi's turns make.
  CLAUDE_CODE_EXTRA_BODY: undefined,
  // Belt and braces over NONESSENTIAL_TRAFFIC, as pi-claude-code sets them.
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  // The installation PI_CLAUDE_CLI_CONFIG_DIR selects, if any.
  ...claudeConfigEnvironment(),
});

/** Constructs the CLI launcher over the contextual process spawner. */
export const makeClaudeCli = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ProviderConfig;
  const knownVersion = yield* Ref.make(Option.none<string>());
  const authChecked = yield* Ref.make(false);
  const serviceScope = yield* Effect.scope;

  const probe = (args: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(claudeCommand(), args, {
          extendEnv: true,
          env: claudeConfigEnvironment(),
          stdin: "ignore",
          detached: false,
          killSignal: "SIGKILL",
        }),
      )
      .pipe(Effect.timeoutOption(CLI_PROBE_TIMEOUT));

  /** The installed version, asked once per runtime and only cached once known. */
  const supportedVersion = Effect.fn("ClaudeCli.checkVersion")(function* () {
    const known = yield* Ref.get(knownVersion);
    if (Option.isSome(known)) return known.value;
    const output = yield* probe(["--version"]).pipe(
      Effect.catchTag("PlatformError", () => Effect.fail(notInstalled)),
    );
    const version = Option.flatMap(output, parseCliVersion);
    yield* Effect.annotateCurrentSpan({
      version: Option.getOrElse(version, () => "unknown"),
    });
    if (Option.isNone(version) || !isSupportedCliVersion(version.value))
      return yield* new CliRequirementError({
        reason: "VersionTooOld",
        message: `pi-claude-cli requires Claude Code ${MIN_SUPPORTED_CLI_VERSION}+ (found ${Option.getOrElse(version, () => "an unrecognized version")}). Update Claude Code.`,
      });
    yield* Ref.set(knownVersion, version);
    return version.value;
  });

  /**
   * Record whether the CLI is logged in. Advisory only: an unauthenticated
   * CLI reports the problem itself in the turn's result.
   */
  const checkAuth = Effect.fn("ClaudeCli.checkAuth")(function* () {
    const output = yield* probe(["auth", "status"]).pipe(
      Effect.catchTag("PlatformError", () => Effect.succeed(Option.none<string>())),
    );
    const loggedIn = output.pipe(
      Option.flatMap((text) => decodeAuthStatus(text.trim())),
      Option.map((status) => status.loggedIn),
    );
    yield* Effect.annotateCurrentSpan({
      loggedIn: Option.getOrElse(loggedIn, () => "unknown"),
    });
    if (Option.contains(loggedIn, false))
      yield* Effect.logWarning("Claude CLI is not authenticated. Run `claude` and use `/login`.");
  });

  return ClaudeCli.of({
    version: Ref.get(knownVersion),
    spawn: Effect.fn("ClaudeCli.spawn")(function* (launch: ClaudeCliLaunch) {
      const version = yield* supportedVersion();
      if (config.restrictedMode)
        return yield* new CliRequirementError({
          reason: "RestrictedMode",
          message:
            "Unset CLAUDE_CODE_SIMPLE/CLAUDE_CODE_SAFE_MODE: pi-claude-cli requires subscription authentication and the in-band MCP tool server.",
        });
      if (!(yield* Ref.getAndSet(authChecked, true)))
        yield* Effect.forkIn(checkAuth(), serviceScope);

      const args = launchArguments(launch, config.settingsPath);
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(claudeCommand(), args, {
            cwd: launch.cwd,
            extendEnv: true,
            env: {
              ...launchEnvironment(config.mcpToolTimeoutMillis),
              // The provider's own relay, never an inherited override.
              ...Option.match(launch.baseUrl, {
                onNone: () => ({}),
                onSome: (url) => ({ ANTHROPIC_BASE_URL: url }),
              }),
            },
            stdin: launch.stdin,
            // Same process group as pi, so Ctrl-C in `pi -p` reaches the CLI.
            // A CLI in a group of its own survives that Ctrl-C with its model
            // request still running (seen on claude 2.1.292): closing stdin
            // does not stop a turn in progress. The CLI starts no processes
            // of its own (no native tools), so a group kill would gain nothing.
            detached: false,
            // The process scope's own finalizer asks the CLI to exit first;
            // whatever is still running after that is killed outright.
            killSignal: "SIGKILL",
          }),
        )
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              error.reason._tag === "NotFound"
                ? notInstalled
                : new CliSpawnError({
                    message: `The Claude CLI could not be started: ${error.message}`,
                  }),
            ),
          ),
        );
      yield* Effect.annotateCurrentSpan({
        pid: handle.pid,
        version,
        model: launch.modelId,
        cliSession: launch.cliSessionId,
        thinking: launch.thinking.kind,
        relay: Option.isSome(launch.baseUrl),
        flags: args.filter((arg) => arg.startsWith("-")).join(" "),
      });
      return handle;
    }),
  });
});

/** Provides the CLI launcher without selecting a spawner or configuration. */
export const claudeCliLayerWithoutDependencies = Layer.effect(ClaudeCli, makeClaudeCli);

/** Provides the CLI launcher over Node's spawner and the process environment. */
export const claudeCliLayer = claudeCliLayerWithoutDependencies.pipe(
  Layer.provide(Layer.mergeAll(nodeChildProcessSpawnerLayer, providerConfigLayer)),
);
