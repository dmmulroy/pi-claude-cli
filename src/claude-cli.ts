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
import { crossSpawnSpawnerLayer } from "./cross-spawn-spawner.ts";
import { CliRequirementError, CliSpawnError } from "./errors.ts";
import { INBAND_MCP_CONFIG_JSON } from "./mcp-inband.ts";
import { ProviderConfig, providerConfigLayer } from "./provider-config.ts";
import { type CliThinking, thinkingSpawnArgs } from "./thinking-config.ts";

/** The CLI binary, resolved on PATH. */
const CLAUDE_COMMAND = "claude";

/** How long `claude --version` and `claude auth status` may take. */
const CLI_PROBE_TIMEOUT = Duration.seconds(5);

/**
 * Environment variables that redirect the CLI away from its subscription
 * login. Never forwarded: turns would bill an API account, or fail against a
 * gateway that was meant for another tool.
 */
export const SUBSCRIPTION_OVERRIDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

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

const AuthStatus = Schema.fromJsonString(
  Schema.Struct({ loggedIn: Schema.Boolean }),
);
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

/** Child-only environment: what Claude Code must not do on its own. */
const launchEnvironment = (
  mcpToolTimeoutMillis: string,
): Record<string, string | undefined> => ({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  // pi owns compaction.
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  ENABLE_TOOL_SEARCH: "false",
  MCP_TOOL_TIMEOUT: mcpToolTimeoutMillis,
  // `undefined` removes the variable from the inherited environment.
  ...Object.fromEntries(
    SUBSCRIPTION_OVERRIDE_ENV_VARS.map((name) => [name, undefined]),
  ),
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
        ChildProcess.make(CLAUDE_COMMAND, args, {
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
      Effect.catchTag("PlatformError", () =>
        Effect.succeed(Option.none<string>()),
      ),
    );
    const loggedIn = output.pipe(
      Option.flatMap((text) => decodeAuthStatus(text.trim())),
      Option.map((status) => status.loggedIn),
    );
    yield* Effect.annotateCurrentSpan({
      loggedIn: Option.getOrElse(loggedIn, () => "unknown"),
    });
    if (Option.contains(loggedIn, false))
      yield* Effect.logWarning(
        "Claude CLI is not authenticated. Run `claude` and use `/login`.",
      );
  });

  return ClaudeCli.of({
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
          ChildProcess.make(CLAUDE_COMMAND, args, {
            cwd: launch.cwd,
            extendEnv: true,
            env: launchEnvironment(config.mcpToolTimeoutMillis),
            stdin: launch.stdin,
            // Same process group as pi, so Ctrl-C in `pi -p` reaches the CLI.
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
        flags: args.filter((arg) => arg.startsWith("-")).join(" "),
      });
      return handle;
    }),
  });
});

/** Provides the CLI launcher without selecting a spawner or configuration. */
export const claudeCliLayerWithoutDependencies = Layer.effect(
  ClaudeCli,
  makeClaudeCli,
);

/** Provides the CLI launcher over `cross-spawn` and the process environment. */
export const claudeCliLayer = claudeCliLayerWithoutDependencies.pipe(
  Layer.provide(Layer.mergeAll(crossSpawnSpawnerLayer, providerConfigLayer)),
);
