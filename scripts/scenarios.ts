/**
 * Scenario runner: the gate for the provider's Effect services.
 *
 *   node scripts/scenarios.ts                 run every stub scenario
 *   node scripts/scenarios.ts warm-turn ...   run the named ones
 *   node scripts/scenarios.ts --list
 *   node scripts/scenarios.ts --live          also run the live scenario
 *                                             (spends subscription tokens)
 *
 * A scenario runs real provider code against the stub CLI under `trace run`,
 * then checks the recorded trace with `trace assert`. It passes when the
 * command exits zero and every assertion holds. `--keep` leaves the trace
 * files in place and prints their paths.
 */

import { delimiter } from "node:path";
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import {
  Console,
  Data,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { nodeChildProcessSpawnerLayer, nodeFileSystemLayer } from "../src/node-platform.ts";

/** One or more scenarios did not pass. */
class ScenariosFailed extends Data.TaggedError("ScenariosFailed")<{
  readonly names: ReadonlyArray<string>;
}> {
  readonly [Runtime.errorExitCode] = 1;
}

/** What a scenario runs: the driver, real pi in print mode, or a script. */
type ScenarioCommand =
  | { readonly _tag: "Driver"; readonly scenario: Option.Option<string> }
  | { readonly _tag: "Pi"; readonly prompt: string }
  | { readonly _tag: "Script"; readonly path: string };

interface Scenario {
  readonly name: string;
  readonly about: string;
  readonly command: ScenarioCommand;
  /** Extra environment for the run. */
  readonly env: Readonly<Record<string, string>>;
  /** Each entry is the arguments of one `trace assert`. */
  readonly asserts: ReadonlyArray<ReadonlyArray<string>>;
  /** Spends subscription tokens; only with `--live`. */
  readonly live: boolean;
}

const scenario = (
  name: string,
  about: string,
  asserts: ReadonlyArray<ReadonlyArray<string>>,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly command?: ScenarioCommand;
    readonly live?: boolean;
  } = {},
): Scenario => ({
  name,
  about,
  asserts: [...asserts, ["--no-open"]],
  env: options.env ?? {},
  command: options.command ?? { _tag: "Driver", scenario: Option.none() },
  live: options.live ?? false,
});

const episode = (...attrs: ReadonlyArray<string>) => [
  "--name",
  "episode",
  ...attrs.flatMap((attr) => ["--attr", attr]),
];
const span = (name: string, ...attrs: ReadonlyArray<string>) => [
  "--name",
  name,
  ...attrs.flatMap((attr) => ["--attr", attr]),
];
const count = (n: number) => ["--count", String(n)];

const SCENARIOS: ReadonlyArray<Scenario> = [
  scenario(
    "trace-sink",
    "the sink records starts, ends, events and the three statuses",
    [
      [...episode(), ...count(3)],
      [...episode("outcome=done"), "--status", "ok", ...count(1)],
      [...episode("outcome=error"), "--status", "error", ...count(1)],
      [...episode("mode=turn"), "--status", "interrupted", ...count(1)],
      [
        ...span("ClaudeCli.spawn", "pid=4242"),
        "--under",
        "episode[mode=spawn]",
        "--event",
        "spawned",
        ...count(2),
        "--max-ms",
        "500",
      ],
      ["--order", "episode[outcome=done],episode[outcome=error]:end,episode[mode=turn]"],
    ],
    { command: { _tag: "Script", path: "scripts/scenarios/trace-sample.ts" } },
  ),
  scenario("fresh-spawn", "a first call launches a process, streams, and parks it", [
    [...episode("mode=spawn", "outcome=done", "spawnReason=noParked"), ...count(1)],
    [...span("ClaudeCli.spawn"), "--under", "episode", ...count(1)],
    [...span("ClaudeProcessPool.park", "idleMs=3600000"), ...count(1)],
    [...span("ProviderRuntime.build", "toolBridge=inband"), ...count(1)],
    [...span("ClaudeProcess"), "--status", "ok", ...count(1)],
  ]),
  scenario("warm-turn", "a follow-up reuses the parked process and sends only the new turn", [
    [...episode(), ...count(2), "--same", "pid"],
    [...episode("mode=spawn"), ...count(1)],
    [...episode("mode=turn", "outcome=done"), ...count(1)],
    [...span("ClaudeCli.spawn"), ...count(1)],
    [...span("ClaudeProcessPool.take", "hit=true"), ...count(1)],
    ["--order", "episode[mode=spawn],episode[mode=turn]"],
  ]),
  scenario(
    "tool-handoff",
    "a tool call is held open while pi runs the tool, then answered in-process",
    [
      [...episode(), ...count(2), "--same", "pid"],
      [...episode("mode=spawn", "outcome=toolUse"), ...count(1)],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...span("ClaudeProcessPool.park", "idleMs=1800000"), ...count(1)],
      [...span("toolCall", "tool=read", "outcome=ok"), "--status", "ok", ...count(1)],
      [...span("toolCall"), "--under", "ClaudeProcess", ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(1)],
      [
        "--order",
        "episode[outcome=toolUse]:end,episode[mode=handoff],toolCall:end,episode[mode=handoff]:end",
      ],
    ],
  ),
  scenario(
    "tool-handoff-parallel",
    "several tool calls in one message are each answered with their own result",
    [
      [...episode(), ...count(2), "--same", "pid"],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...span("toolCall", "outcome=ok"), ...count(2), "--distinct", "tool"],
      [...span("toolCall", "outcome=ok"), ...count(2), "--distinct", "toolUseId"],
      [...span("ClaudeCli.spawn"), ...count(1)],
    ],
  ),
  scenario(
    "tool-handoff-partial",
    "results for only some of the open tool calls retire the blocked process instead of answering it",
    [
      [...episode("mode=spawn", "spawnReason=handoffMismatch"), ...count(1)],
      [...episode("mode=handoff"), "--max-count", "0"],
      [...span("ClaudeProcess.retire", "cause=history"), ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(2)],
    ],
  ),
  scenario(
    "tool-name-alias",
    "a pi tool name the CLI would rewrite reaches the model as an alias and pi under its own name",
    [
      [...episode(), ...count(2), "--same", "pid"],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...span("toolCall", "outcome=ok"), ...count(1)],
    ],
  ),
  scenario(
    "concurrent-session",
    "a call that overlaps another of the same session gets its own process, retired when it ends",
    [
      [...span("ClaudeProcessPool.take", "leased=false"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=concurrent"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=replaced"), "--max-count", "0"],
      [...episode("mode=turn"), ...count(2), "--same", "pid"],
      [...span("ClaudeCli.spawn"), ...count(2)],
    ],
  ),
  scenario(
    "parked-cap",
    "parking past SCENARIO_MAX_PARKED retires the longest-parked process",
    [
      // Each session's parking evicts the other's process.
      [...span("ClaudeProcess.retire", "cause=evicted"), ...count(2)],
      [...episode("spawnReason=noParked"), ...count(3)],
      [...span("ClaudeCli.spawn"), ...count(3)],
    ],
    { env: { SCENARIO_MAX_PARKED: "1" } },
  ),
  scenario(
    "tool-abandoned",
    "a new user message instead of the tool result retires the blocked process",
    [
      [...episode("mode=spawn", "spawnReason=handoffMismatch"), ...count(1)],
      [
        ...span("ClaudeProcess.retire", "cause=history", "ended=exited"),
        ...count(1),
        "--max-ms",
        "1500",
      ],
      [...span("toolCall"), "--status", "interrupted", ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(2)],
    ],
  ),
  scenario(
    "no-session-tool",
    "without a pi session the turn is interrupted at the tool call and the next call reimports",
    [
      [...episode("outcome=toolUse", "mode=spawn"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=interrupted"), ...count(1)],
      [...episode("outcome=done", "spawnReason=noSession"), ...count(1)],
      [...span("toolCall"), "--max-count", "0"],
      [...span("ClaudeCli.spawn"), ...count(2)],
    ],
  ),
  scenario(
    "changed-history",
    "an edited history retires the process and imports pi's history afresh",
    [
      [...episode("mode=spawn", "spawnReason=history"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=history"), ...count(1)],
      [...episode(), ...count(2), "--distinct", "pid"],
    ],
  ),
  scenario("changed-prompt", "a changed system prompt retires the process", [
    [...episode("mode=spawn", "spawnReason=signature.prompt"), ...count(1)],
    [...span("ClaudeProcess.retire", "cause=signature"), ...count(1)],
    [...episode(), ...count(2), "--distinct", "pid"],
  ]),
  scenario("changed-tools", "a changed tool surface is applied to the live process", [
    [
      ...span("ClaudeProcess.applyTools", "acknowledged=true", "from=2", "to=1", "midTurn=false"),
      ...count(1),
    ],
    [...episode("mode=turn", "outcome=done", "tools=1"), ...count(1)],
    [...span("ClaudeCli.spawn"), ...count(1)],
    [...episode(), ...count(2), "--same", "pid"],
  ]),
  scenario(
    "changed-tools-handoff",
    "tools that change while a tool call is open are applied before its result",
    [
      [
        ...span("ClaudeProcess.applyTools", "acknowledged=true", "to=3", "midTurn=true"),
        ...count(1),
      ],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(1)],
      [...episode(), ...count(2), "--same", "pid"],
      ["--order", "ClaudeProcess.applyTools:end,toolCall:end"],
    ],
  ),
  scenario(
    "changed-tools-refused",
    "a CLI that does not list its tools again is replaced by a fresh process",
    [
      [...span("ClaudeProcess.applyTools", "acknowledged=false"), ...count(1), "--min-ms", "2500"],
      [...episode("mode=spawn", "spawnReason=tools"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=tools"), ...count(1)],
      [...episode(), ...count(2), "--distinct", "pid"],
    ],
    { env: { CLAUDE_STUB_IGNORE_TOOLS_CHANGED: "1" } },
  ),
  scenario("foreign-provider", "a turn answered by another provider retires the process", [
    [...episode("mode=spawn", "spawnReason=foreignProvider"), ...count(1)],
    [...span("ClaudeProcess.retire", "cause=history"), ...count(1)],
    [...episode(), ...count(2), "--distinct", "pid"],
  ]),
  scenario("thinking-change", "a new thinking level is applied to the live process", [
    [
      ...span(
        "ClaudeProcess.applyThinking",
        "acknowledged=true",
        "from=disabled",
        "to=enabled",
        "controls=2",
      ),
      ...count(1),
    ],
    [...episode("mode=turn"), ...count(1)],
    [...span("ClaudeCli.spawn"), ...count(1)],
    [...episode(), ...count(2), "--same", "pid"],
  ]),
  scenario(
    "thinking-refused",
    "a refused thinking change falls back to a fresh process",
    [
      [...span("ClaudeProcess.applyThinking", "acknowledged=false"), ...count(1)],
      [...episode("mode=spawn", "spawnReason=thinking"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=thinking"), ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(2)],
    ],
    { env: { CLAUDE_STUB_REFUSE_CONTROL: "1" } },
  ),
  scenario(
    "abort-mid-stream",
    "an abort ends the stream at once and retires the process afterwards",
    [
      [...episode("outcome=aborted"), "--status", "interrupted", ...count(1)],
      [
        ...span("ClaudeProcess.retire", "cause=abort", "ended=exited"),
        ...count(1),
        "--max-ms",
        "1500",
      ],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
      [...episode("wire.stream_event=3"), ...count(1)],
      ["--order", "episode[outcome=aborted]:end,ClaudeProcess.retire[cause=abort]:end"],
    ],
  ),
  scenario(
    "abort-during-launch",
    "an abort that lands while the CLI is starting still retires the process",
    [
      [...episode("outcome=aborted"), "--status", "interrupted", ...count(1)],
      [...span("ClaudeProcess.retire", "cause=abort"), ...count(1)],
      [...span("ClaudeProcess"), "--status", "ok", ...count(1)],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    ],
  ),
  scenario(
    "already-aborted",
    "a call whose signal is already aborted ends as aborted without a process",
    [
      [...span("ClaudeCli.spawn"), "--max-count", "0"],
      [...span("ProviderRuntime.dispose"), ...count(1)],
    ],
  ),
  scenario(
    "inactivity-timeout",
    "a silent CLI fails the episode and is killed without a grace period",
    [
      [...episode("outcome=error"), "--status", "error", ...count(1), "--min-ms", "300"],
      [
        ...span("ClaudeProcess.retire", "cause=timeout", "ended=killed"),
        ...count(1),
        "--max-ms",
        "400",
      ],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    ],
    { env: { SCENARIO_TIMEOUT_MS: "350" } },
  ),
  scenario(
    "idle-control-traffic",
    "a CLI that is silent on the model stream but busy on the control channel is not stalled",
    [
      [...episode("outcome=done"), ...count(1), "--min-ms", "500"],
      [...span("ClaudeProcess.retire", "cause=timeout"), "--max-count", "0"],
    ],
    { env: { SCENARIO_TIMEOUT_MS: "350" } },
  ),
  scenario(
    "structured-import",
    "a fresh process gets pi's history as messages, with valid tool call ids",
    [
      [...episode("mode=spawn", "import=structured", "importFrames=5"), ...count(1)],
      [...span("ClaudeProcess.importHistory", "frames=5", "acknowledged=true"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=import"), "--max-count", "0"],
    ],
    {
      env: {
        SCENARIO_KEEPALIVE_MS: "0",
      },
    },
  ),
  scenario(
    "structured-import-long",
    "a long history is imported one held message at a time, as a CLI that confirms queued messages together requires",
    [
      [...episode("mode=spawn", "import=structured", "importFrames=81"), ...count(1)],
      [
        ...span("ClaudeProcess.importHistory", "acknowledged=true"),
        ...count(1),
        "--max-ms",
        "5000",
      ],
      [...span("ClaudeProcess.retire", "cause=import"), "--max-count", "0"],
    ],
    { env: { SCENARIO_KEEPALIVE_MS: "0" } },
  ),
  scenario(
    "signed-thinking-replay",
    "a fresh process gets signed thinking back only while pi's message is unchanged",
    [
      [...episode("mode=spawn", "import=structured"), ...count(3)],
      [...span("ClaudeProcess.importHistory", "acknowledged=true"), ...count(3)],
    ],
    {
      env: {
        SCENARIO_KEEPALIVE_MS: "0",
      },
    },
  ),
  scenario(
    "structured-import-refused",
    "a CLI that answers a held message is retired and the history imported as text into a fresh process",
    [
      [...span("ClaudeProcess.importHistory", "acknowledged=false"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=import"), ...count(1)],
      [...episode("import=flat", "importRefused=true", "outcome=done"), ...count(1)],
    ],
    {
      env: {
        SCENARIO_KEEPALIVE_MS: "0",
        CLAUDE_STUB_QUERY_HELD: "1",
      },
    },
  ),
  scenario("process-dies", "a process that dies mid-turn fails the episode with its stderr", [
    [...episode("outcome=error"), "--status", "error", ...count(1)],
    [...span("ClaudeProcess", "exitCode=3"), ...count(1)],
    [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    [...span("ClaudeProcess.retire"), ...count(1)],
  ]),
  scenario("turn-fails", "an error result fails the episode and retires the process", [
    [...episode("outcome=error"), "--status", "error", ...count(1)],
    [...span("ClaudeProcess.retire", "cause=failure", "ended=exited"), ...count(1)],
    [...span("ClaudeProcessPool.park"), "--max-count", "0"],
  ]),
  scenario(
    "usage-credits-guard",
    "a call charged to usage credits ends with a billing error and its process is retired",
    [
      [
        ...episode("outcome=error", "rateLimit.usageCredits=true"),
        "--status",
        "error",
        ...count(1),
      ],
      [...span("ClaudeProcess.retire", "cause=failure"), ...count(1)],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    ],
  ),
  scenario(
    "usage-credits-allowed",
    "PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1 lets a call charged to usage credits end normally",
    [
      [...episode("outcome=done", "rateLimit.usageCredits=true"), ...count(1)],
      [...span("ClaudeProcessPool.park"), ...count(1)],
    ],
    { env: { PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS: "1" } },
  ),
  scenario(
    "usage-credits-after-handoff",
    "a usage-credit charge reported after a tool call stops the next call before the tool result is sent",
    [
      [...episode("mode=spawn", "outcome=toolUse", "rateLimit.usageCredits"), "--max-count", "0"],
      [...episode("mode=handoff", "outcome=error", "rateLimit.usageCredits=true"), ...count(1)],
      [...span("toolCall", "outcome=ok"), "--max-count", "0"],
      [...span("ClaudeProcess.retire", "cause=failure"), ...count(1)],
    ],
  ),
  scenario(
    "model-refusal",
    "a refusal ends with the model's explanation as an error and retires the process",
    [
      [...episode("outcome=error"), "--status", "error", ...count(1)],
      [...span("ClaudeProcess.retire", "cause=failure"), ...count(1)],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    ],
  ),
  scenario(
    "stream-mismatch",
    "a stream that differs from the CLI's own record of the message fails the episode",
    [
      [...episode("outcome=error"), "--status", "error", ...count(1)],
      [...span("ClaudeProcess.retire", "cause=failure"), ...count(1)],
    ],
  ),
  scenario(
    "response-fields",
    "pi's message carries the response id, raw stop reason, usage breakdown and diagnostics",
    [
      [
        ...episode("outcome=done", "rateLimit.status=allowed", "rateLimit.usageCredits=false"),
        ...count(1),
      ],
    ],
  ),
  scenario("session-retire", "pi's cleanup of a session retires the process parked for it", [
    [...span("ClaudeProcessPool.retireSession", "hit=true"), ...count(1)],
    // One by the cleanup, one by the runtime's disposal at the end.
    [...span("ClaudeProcess.retire", "cause=shutdown"), ...count(2)],
    [...episode("mode=spawn", "spawnReason=noParked"), ...count(2)],
    [
      "--order",
      "ClaudeProcessPool.retireSession,ClaudeProcess.retire[cause=shutdown]:end,episode[spawnReason=noParked]",
    ],
  ]),
  scenario(
    "idle-expiry",
    "a parked process is retired when nobody comes back within the keepalive",
    [
      [...span("ClaudeProcess.retire", "cause=idle", "ended=exited"), ...count(1)],
      [...span("ClaudeProcessPool.park", "idleMs=300"), ...count(2)],
      [...episode("mode=spawn"), ...count(2)],
      [...span("ClaudeProcessPool.take", "hit=false"), ...count(2)],
      [
        "--order",
        "ClaudeProcessPool.park,ClaudeProcess.retire[cause=idle],episode[spawnReason=noParked]",
      ],
    ],
    { env: { SCENARIO_KEEPALIVE_MS: "300" } },
  ),
  scenario(
    "no-session",
    "a call without a pi session is served and its process ended, not parked",
    [
      [...episode("mode=spawn", "spawnReason=noSession", "outcome=done"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=unparked"), ...count(1)],
      [...span("ClaudeProcessPool.park"), "--max-count", "0"],
    ],
  ),
  scenario("lifecycle-retire", "a pi lifecycle event retires the parked process", [
    [...span("ClaudeProcess.retire", "cause=shutdown", "ended=exited"), ...count(2)],
    [...episode("mode=spawn", "spawnReason=noParked"), ...count(2)],
    [...span("ClaudeProcessPool.retireAll", "count=1"), ...count(2)],
  ]),
  scenario(
    "session-shutdown",
    "disposing the runtime ends the parked process and removes the directory",
    [
      [...span("ProviderRuntime.dispose"), "--status", "ok", ...count(1)],
      [
        ...span("ClaudeProcess.retire", "cause=shutdown", "ended=exited"),
        "--under",
        "ClaudeProcess",
        ...count(1),
      ],
      ["--order", "episode:end,ProviderRuntime.dispose,ClaudeProcess:end"],
    ],
  ),
  scenario(
    "layer-build-failure",
    "a runtime that cannot build still ends every call with an error event",
    [[...episode(), "--max-count", "0"]],
  ),
  scenario(
    "cli-command",
    "PI_CLAUDE_CLI_COMMAND picks the executable and PI_CLAUDE_CLI_CONFIG_DIR its configuration",
    [[...episode("outcome=done"), ...count(1)]],
    {
      env: {
        PI_CLAUDE_CLI_COMMAND: "claude-alt",
        PI_CLAUDE_CLI_CONFIG_DIR: "/tmp/pi-claude-scenario-config",
      },
    },
  ),
  scenario(
    "env-stripping",
    "the CLI never sees the variables that would move it off the subscription, and never retries or compacts on its own",
    [[...episode("outcome=done"), ...count(1)]],
    {
      env: {
        ANTHROPIC_API_KEY: "sk-scenario-must-not-leak",
        ANTHROPIC_AUTH_TOKEN: "scenario-must-not-leak",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_FOUNDRY_API_KEY: "scenario-must-not-leak",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_EXTRA_BODY: '{"scenario":"must-not-leak"}',
        CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "padded-countdown",
        CLAUDE_CODE_MAX_RETRIES: "10",
        CLAUDE_CODE_RETRY_WATCHDOG: "1",
      },
    },
  ),
  scenario(
    "launch-flags",
    "the launch keeps host guards and account selection and never uses --bare",
    [[...span("ClaudeCli.spawn"), ...count(1)]],
    {
      env: {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/account/selected",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
      },
    },
  ),
  scenario(
    "wire-counts",
    "by default the wire is recorded as counts and time to first token only",
    [
      [...episode("wire.stream_event=6", "wire.result=1", "ttftMs"), ...count(1)],
      ["--event", "wire *", "--max-count", "0"],
    ],
    { command: { _tag: "Driver", scenario: Option.some("fresh-spawn") } },
  ),
  scenario(
    "wire-events",
    "PI_CLAUDE_CLI_TRACE_WIRE=1 adds one event per wire message, without content",
    [
      [...episode(), "--event", "wire stream_event", "--event", "wire result", ...count(1)],
      ["--event", "wire raw", "--max-count", "0"],
    ],
    {
      env: { PI_CLAUDE_CLI_TRACE_WIRE: "1" },
      command: { _tag: "Driver", scenario: Option.some("fresh-spawn") },
    },
  ),
  scenario(
    "wire-raw",
    "PI_CLAUDE_CLI_TRACE_WIRE=raw records the raw lines on the process span",
    [[...span("ClaudeProcess"), "--event", "wire raw", ...count(1)]],
    {
      env: { PI_CLAUDE_CLI_TRACE_WIRE: "raw" },
      command: { _tag: "Driver", scenario: Option.some("fresh-spawn") },
    },
  ),
  scenario(
    "model-probe",
    "the account's models come from one initialize request to a short-lived CLI process",
    [
      [
        ...span("ModelProbe.requestAccountModels", "models=2"),
        "--status",
        "ok",
        ...count(1),
        "--max-ms",
        "5000",
      ],
      [...span("ModelProbe.requestAccountModels", "models=0"), ...count(1)],
      // The probe never serves a model call.
      [...episode(), "--max-count", "0"],
    ],
    {
      command: { _tag: "Script", path: "scripts/scenarios/model-probe.ts" },
      env: {
        ANTHROPIC_API_KEY: "sk-scenario-must-not-leak",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
    },
  ),
  scenario(
    "trace-default-location",
    "with no PI_CLAUDE_CLI_TRACE the sink writes a private daily file and prunes old ones",
    [],
    { command: { _tag: "Script", path: "scripts/scenarios/trace-default.ts" } },
  ),
  scenario(
    "print-mode-exit",
    "real pi in print mode loads the provider lazily and exits with a process parked",
    [
      [...episode("mode=spawn", "outcome=done"), ...count(1)],
      [...span("ClaudeProcessPool.park", "idleMs=3600000"), ...count(1)],
      [...span("ProviderRuntime.dispose"), ...count(1)],
      [...span("ClaudeProcess.retire", "cause=shutdown", "ended=exited"), ...count(1)],
    ],
    { command: { _tag: "Pi", prompt: "magic word" } },
  ),
  scenario(
    "live",
    "LIVE: one turn, one tool call, one warm follow-up against the real CLI",
    [
      [...episode(), ...count(3), "--same", "pid"],
      [...episode("mode=spawn", "outcome=toolUse"), ...count(1)],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...episode("mode=turn", "outcome=done"), ...count(1)],
      [...span("toolCall", "outcome=ok"), ...count(1)],
      [...span("ClaudeCli.spawn"), ...count(1)],
    ],
    { live: true },
  ),
  scenario(
    "live-structured-import",
    "LIVE: a history with an open tool call and signed thinking, imported as messages into fresh processes",
    [
      [...episode("mode=spawn", "import=structured"), ...count(3)],
      [...episode("mode=spawn", "import=structured", "outcome=done"), ...count(2)],
      [...span("ClaudeProcess.importHistory", "acknowledged=true"), ...count(3)],
      [...span("ClaudeProcess.retire", "cause=import"), "--max-count", "0"],
      [...span("ClaudeCli.spawn"), ...count(3)],
    ],
    { live: true },
  ),
  scenario(
    "live-parallel-tools",
    "LIVE: two tool calls in one message, each answered with its own result",
    [
      [...episode(), ...count(2), "--same", "pid"],
      [...episode("mode=spawn", "outcome=toolUse"), ...count(1)],
      [...episode("mode=handoff", "outcome=done"), ...count(1)],
      [...span("toolCall", "outcome=ok"), ...count(2), "--distinct", "tool"],
      [...span("toolCall", "outcome=ok"), ...count(2), "--distinct", "toolUseId"],
      [...span("ClaudeCli.spawn"), ...count(1)],
    ],
    { live: true },
  ),
  scenario(
    "live-tools-change",
    "LIVE: tools added between turns and mid-call, then removed, on one process",
    [
      [...episode(), ...count(5), "--same", "pid"],
      [...span("ClaudeCli.spawn"), ...count(1)],
      [...span("ClaudeProcess.applyTools", "acknowledged=true"), ...count(3), "--max-ms", "1000"],
      [...span("ClaudeProcess.applyTools", "midTurn=true", "to=4"), ...count(1)],
      [...span("ClaudeProcess.applyTools", "from=4", "to=3"), ...count(1)],
      [...span("toolCall", "outcome=ok"), ...count(2), "--distinct", "tool"],
      [...episode("mode=handoff"), ...count(2)],
      [...episode("mode=turn"), ...count(2)],
    ],
    { live: true },
  ),
];

// ---- running ----------------------------------------------------------------

/** How long one scenario's command may run before it counts as hung. */
const SCENARIO_TIMEOUT = Duration.seconds(90);

interface ScenarioRun {
  readonly scenario: Scenario;
  readonly failures: ReadonlyArray<string>;
  readonly traceFile: string;
}

const runScenario = Effect.fn("Scenarios.run")(function* (
  scenario: Scenario,
  setup: {
    readonly repoRoot: string;
    readonly stubDirectory: string;
    readonly workRoot: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const work = path.join(setup.workRoot, scenario.name);
  const cwd = path.join(work, "cwd");
  yield* fs.makeDirectory(cwd, { recursive: true });
  const traceFile = path.join(work, "trace.ndjson");
  const traceCli = path.join(setup.repoRoot, "scripts", "trace.ts");

  const command = (() => {
    switch (scenario.command._tag) {
      case "Driver":
        return [
          process.execPath,
          path.join(setup.repoRoot, "scripts", "scenarios", "driver.ts"),
          Option.getOrElse(scenario.command.scenario, () => scenario.name),
        ];
      case "Script":
        return [process.execPath, path.join(setup.repoRoot, scenario.command.path)];
      case "Pi":
        // `-ne` so an installed copy of this package cannot win the
        // provider name over the working tree.
        return [
          "pi",
          "-ne",
          "-e",
          setup.repoRoot,
          "-p",
          "--model",
          "pi-claude-cli/claude-haiku-4-5",
          scenario.command.prompt,
        ];
    }
  })();

  /** Run a command to completion and collect what it printed. */
  const run = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
    Effect.gen(function* () {
      const [program = "", ...args] = argv;
      const handle = yield* spawner.spawn(
        ChildProcess.make(program, args, {
          cwd,
          extendEnv: true,
          env,
          // Print mode reads stdin: an inherited pipe that never closes
          // would keep pi waiting for EOF.
          stdin: "ignore",
          detached: false,
          killSignal: "SIGKILL",
        }),
      );
      const output = yield* Stream.mkString(Stream.decodeText(handle.all)).pipe(Effect.forkChild);
      const exitCode = Number(yield* handle.exitCode);
      return { exitCode, output: yield* Fiber.join(output) };
    }).pipe(
      Effect.scoped,
      Effect.catchTag("PlatformError", (error) =>
        Effect.succeed({ exitCode: 127, output: error.message }),
      ),
      Effect.timeoutOption(SCENARIO_TIMEOUT),
    );

  const failures: Array<string> = [];
  const ran = yield* run(
    [process.execPath, traceCli, "run", "--quiet", "--file", traceFile, "--", ...command],
    {
      // The stub stands in for `claude`, except in the live scenario.
      PATH: scenario.live
        ? (process.env.PATH ?? "")
        : `${setup.stubDirectory}${delimiter}${process.env.PATH ?? ""}`,
      // Nothing a scenario records may land in the user's own trace directory.
      XDG_STATE_HOME: path.join(work, "state"),
      SCENARIO_TMP: work,
      CLAUDE_STUB_ARGV_FILE: path.join(work, "argv.jsonl"),
      CLAUDE_STUB_ENV_FILE: path.join(work, "env.json"),
      CLAUDE_STUB_TOOLS_FILE: path.join(work, "tools.jsonl"),
      CLAUDE_STUB_FRAMES_FILE: path.join(work, "frames.jsonl"),
      ...scenario.env,
    },
  );
  if (Option.isNone(ran))
    failures.push(`the command did not exit within ${Duration.toSeconds(SCENARIO_TIMEOUT)}s`);
  else if (ran.value.exitCode !== 0)
    failures.push(`the command exited ${ran.value.exitCode}\n${ran.value.output.trim()}`);

  for (const assertion of scenario.asserts) {
    const checked = yield* run(
      [process.execPath, traceCli, "assert", "--quiet", "--file", traceFile, ...assertion],
      {},
    );
    if (Option.isNone(checked) || checked.value.exitCode !== 0)
      failures.push(
        `trace assert ${assertion.join(" ")}\n${Option.match(checked, {
          onNone: () => "(timed out)",
          onSome: (result) => result.output.trim(),
        })}`,
      );
  }
  return { scenario, failures, traceFile } satisfies ScenarioRun;
});

const scenariosCommand = Command.make(
  "scenarios",
  {
    names: Argument.String("scenario").pipe(
      Argument.withDescription("Scenarios to run (default: every stub scenario)"),
      Argument.variadic(),
    ),
    list: Flag.Boolean("list").pipe(
      Flag.withDescription("List the scenarios and exit"),
      Flag.withDefault(false),
    ),
    live: Flag.Boolean("live").pipe(
      Flag.withDescription("Also run the live scenario (spends tokens)"),
      Flag.withDefault(false),
    ),
    keep: Flag.Boolean("keep").pipe(
      Flag.withDescription("Keep the trace files and print their paths"),
      Flag.withDefault(false),
    ),
    concurrency: Flag.Int("concurrency").pipe(Flag.withDefault(4)),
  },
  Effect.fn("Scenarios.main")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.list) {
      for (const each of SCENARIOS) yield* Console.log(`${each.name.padEnd(22)} ${each.about}`);
      return;
    }
    const unknown = input.names.filter((name) => !SCENARIOS.some((each) => each.name === name));
    if (unknown.length > 0) {
      yield* Console.error(`unknown scenario: ${unknown.join(", ")}`);
      return yield* new ScenariosFailed({ names: unknown });
    }
    const selected = SCENARIOS.filter((each) =>
      input.names.length > 0 ? input.names.includes(each.name) : input.live || !each.live,
    );

    const repoRoot = path.resolve(import.meta.dirname, "..");
    const workRoot = input.keep
      ? yield* fs.makeTempDirectory({ prefix: "pi-claude-scenarios-" })
      : yield* fs.makeTempDirectoryScoped({ prefix: "pi-claude-scenarios-" });
    // The stub must be found as `claude` on PATH.
    const stubDirectory = path.join(workRoot, "bin");
    yield* fs.makeDirectory(stubDirectory, { recursive: true });
    yield* fs.copyFile(
      path.join(repoRoot, "tests", "e2e", "claude-stub.cjs"),
      path.join(stubDirectory, "claude"),
    );
    yield* fs.chmod(path.join(stubDirectory, "claude"), 0o755);
    // The same stub under another name, for PI_CLAUDE_CLI_COMMAND.
    yield* fs.copyFile(
      path.join(repoRoot, "tests", "e2e", "claude-stub.cjs"),
      path.join(stubDirectory, "claude-alt"),
    );
    yield* fs.chmod(path.join(stubDirectory, "claude-alt"), 0o755);

    const runs = yield* Effect.forEach(
      selected,
      (each) =>
        runScenario(each, { repoRoot, stubDirectory, workRoot }).pipe(
          Effect.tap((run) =>
            Console.log(
              run.failures.length === 0
                ? `ok    ${each.name}`
                : `FAIL  ${each.name}\n${run.failures
                    .map((failure) => `      ${failure.replace(/\n/g, "\n      ")}`)
                    .join("\n")}`,
            ),
          ),
        ),
      { concurrency: input.concurrency },
    );
    const failed = runs.filter((run) => run.failures.length > 0);
    yield* Console.log(`\n${runs.length - failed.length} of ${runs.length} scenarios passed`);
    if (input.keep)
      for (const run of runs) yield* Console.log(`  ${run.scenario.name}: ${run.traceFile}`);
    if (failed.length > 0)
      return yield* new ScenariosFailed({
        names: failed.map((run) => run.scenario.name),
      });
  }, Effect.scoped),
).pipe(
  Command.withDescription("Run provider scenarios against the stub CLI and assert on their traces"),
);

const scenariosLayer = Layer.mergeAll(
  nodeFileSystemLayer,
  NodeStdio.layer,
  NodeTerminal.layer,
  nodeChildProcessSpawnerLayer,
);

NodeRuntime.runMain(
  Command.run(scenariosCommand, { version: "1" }).pipe(Effect.provide(scenariosLayer)),
  { disableErrorReporting: true },
);
