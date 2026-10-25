/**
 * Spike: Claude Code's in-band MCP server (`"type": "sdk"`), probed directly.
 *
 * This is the experiment that decided the provider's tool bridge, kept so it
 * can be repeated against a new Claude Code version. It launches the real
 * `claude` with the provider's flags, plays the MCP server on the control
 * channel by hand, and prints what the CLI sends with timings.
 *
 *   node scripts/spikes/inband-mcp.ts probe          # no model call, no tokens
 *   node scripts/spikes/inband-mcp.ts round-trip     # 2 turns: held call, interrupt
 *   node scripts/spikes/inband-mcp.ts timeout        # 1 turn, MCP_TOOL_TIMEOUT=2000
 *   node scripts/spikes/inband-mcp.ts list-changed   # 2 turns: new tool mid-session
 *   node scripts/spikes/inband-mcp.ts list-changed-mid-call  # 1 turn: new tool during a call
 *   node scripts/spikes/inband-mcp.ts list-removed   # 2 turns: a tool taken away
 *   node scripts/spikes/inband-mcp.ts probe --claude /path/to/older/claude
 *
 * Every mode but `probe` spends subscription tokens (haiku, tiny prompts).
 * Findings are recorded in effect-rewrite.md, "Decide the tool bridge first".
 */

import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import {
  type Cause,
  Clock,
  Console,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SUBSCRIPTION_OVERRIDE_ENV_VARS } from "../../src/subscription-env.ts";
import { INBAND_MCP_CONFIG_JSON, INBAND_MCP_SERVER_NAME } from "../../src/mcp-inband.ts";
import {
  nodeChildProcessSpawnerLayer,
  nodeCryptoLayer,
  nodeFileSystemLayer,
} from "../../src/node-platform.ts";

// ---- the wire, loosely -------------------------------------------------------

const JsonRpcId = Schema.Union([Schema.String, Schema.Number]);

/** Every field this spike reads from a stdout line; all optional. */
const WireLine = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  request_id: Schema.optional(Schema.String),
  request: Schema.optional(
    Schema.Struct({
      subtype: Schema.optional(Schema.String),
      tool_name: Schema.optional(Schema.String),
      tool_use_id: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Unknown),
      message: Schema.optional(
        Schema.Struct({
          id: Schema.optional(JsonRpcId),
          method: Schema.optional(Schema.String),
          params: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
  response: Schema.optional(
    Schema.Struct({
      subtype: Schema.optional(Schema.String),
      request_id: Schema.optional(Schema.String),
      response: Schema.optional(Schema.Unknown),
    }),
  ),
  event: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      content_block: Schema.optional(
        Schema.Struct({
          type: Schema.String,
          id: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.NullOr(Schema.String)),
  tools: Schema.optional(Schema.Array(Schema.String)),
});
type WireLine = typeof WireLine.Type;

const decodeWireLine = Schema.decodeOption(Schema.fromJsonString(WireLine));

interface ProbeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, never>;
  };
}

const probeTool = (name: string, description: string): ProbeTool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

/** One `tools/call` the CLI made and is waiting on. */
interface OpenToolCall {
  readonly requestId: string;
  readonly rpcId: string | number;
  readonly toolName: string;
}

const SYSTEM_PROMPT =
  "You are a test harness. When asked to call a tool, call it exactly once, then reply with one word.";

// ---- one CLI process, with the MCP server played by hand ---------------------

const launchProbe = Effect.fn("Spike.launch")(function* (options: {
  readonly claude: string;
  readonly mcpToolTimeoutMillis: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "pi-claude-spike-",
  });
  const promptFile = path.join(directory, "prompt.txt");
  yield* fs.writeFileString(promptFile, SYSTEM_PROMPT);

  const startedAt = yield* Clock.currentTimeMillis;
  const log = (text: string) =>
    Effect.gen(function* () {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      yield* Console.log(`+${String(elapsed).padStart(5)}ms  ${text}`);
    });

  const outbound = yield* Queue.unbounded<string, Cause.Done>();
  const send = (value: unknown) => Queue.offer(outbound, JSON.stringify(value) + "\n");
  const tools = yield* Ref.make<ReadonlyArray<ProbeTool>>([
    probeTool("probe_tool", "Returns the probe value."),
  ]);
  const toolCalls = yield* Queue.unbounded<OpenToolCall>();
  const results = yield* Queue.unbounded<WireLine>();
  const controlResponses = yield* Queue.unbounded<WireLine>();

  const mcpResponse = (requestId: string, response: unknown) =>
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { mcp_response: response },
      },
    });

  const handleMcp = Effect.fnUntraced(function* (
    requestId: string,
    message: NonNullable<NonNullable<WireLine["request"]>["message"]>,
  ) {
    const method = message.method ?? "(none)";
    const detail =
      method === "tools/call" || method.startsWith("notifications/")
        ? ` ${JSON.stringify(message.params)}`
        : "";
    yield* log(`CLI → mcp ${method} id=${message.id ?? "-"}${detail}`);
    if (message.id === undefined)
      return yield* mcpResponse(requestId, {
        jsonrpc: "2.0",
        id: 0,
        result: {},
      });
    const id = message.id;
    if (method === "initialize")
      return yield* mcpResponse(requestId, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: INBAND_MCP_SERVER_NAME, version: "1.0.0" },
        },
      });
    if (method === "tools/list")
      return yield* mcpResponse(requestId, {
        jsonrpc: "2.0",
        id,
        result: { tools: yield* Ref.get(tools) },
      });
    if (method === "tools/call") {
      const params = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))(
        message.params,
      );
      return yield* Queue.offer(toolCalls, {
        requestId,
        rpcId: id,
        toolName: Option.match(params, {
          onNone: () => "(unknown)",
          onSome: (decoded) => decoded.name,
        }),
      });
    }
    return yield* mcpResponse(requestId, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not supported" },
    });
  });

  const handleLine = Effect.fnUntraced(function* (line: WireLine) {
    if (line.type === "control_request" && line.request_id !== undefined) {
      const request = line.request;
      if (request?.subtype === "mcp_message" && request.message !== undefined)
        return yield* handleMcp(line.request_id, request.message);
      if (request?.subtype === "can_use_tool") {
        yield* log(`CLI → can_use_tool ${request.tool_name} tool_use_id=${request.tool_use_id}`);
        return yield* send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: line.request_id,
            response: { behavior: "allow", updatedInput: request.input ?? {} },
          },
        });
      }
      return yield* log(`CLI → control_request ${request?.subtype}`);
    }
    if (line.type === "control_response") {
      yield* log(
        `CLI → control_response ${line.response?.subtype} ${line.response?.request_id} ${JSON.stringify(line.response?.response ?? null).slice(0, 300)}`,
      );
      return yield* Queue.offer(controlResponses, line);
    }
    if (line.type === "system" && line.subtype === "init")
      return yield* log(`CLI → system init tools=${JSON.stringify(line.tools)}`);
    if (line.type === "stream_event") {
      const block = line.event?.content_block;
      if (line.event?.type === "content_block_start" && block?.type === "tool_use")
        yield* log(`CLI → tool_use ${block.name} ${block.id}`);
      else if (line.event?.type === "message_stop") yield* log("CLI → message_stop");
      return;
    }
    if (line.type === "result") {
      yield* log(
        `CLI → result ${line.subtype} is_error=${line.is_error} ${JSON.stringify(line.result ?? "")}`,
      );
      return yield* Queue.offer(results, line);
    }
  });

  const handle = yield* spawner.spawn(
    ChildProcess.make(
      options.claude,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "claude-haiku-4-5",
        "--permission-prompt-tool",
        "stdio",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-chrome",
        "--tools",
        "",
        "--session-id",
        yield* crypto.randomUUIDv4(),
        "--no-session-persistence",
        "--system-prompt-file",
        promptFile,
        "--thinking",
        "disabled",
        "--mcp-config",
        INBAND_MCP_CONFIG_JSON,
      ],
      {
        cwd: directory,
        extendEnv: true,
        env: {
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          DISABLE_AUTO_COMPACT: "1",
          DISABLE_COMPACT: "1",
          ENABLE_TOOL_SEARCH: "false",
          MCP_TOOL_TIMEOUT: Option.getOrUndefined(options.mcpToolTimeoutMillis),
          ...Object.fromEntries(SUBSCRIPTION_OVERRIDE_ENV_VARS.map((name) => [name, undefined])),
        },
        stdin: Stream.fromQueue(outbound).pipe(Stream.encodeText),
        detached: false,
        killSignal: "SIGKILL",
      },
    ),
  );
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((text) =>
      Option.match(decodeWireLine(text), {
        onNone: () => Effect.void,
        onSome: handleLine,
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Queue.end(outbound));

  return {
    log,
    send,
    tools,
    user: (text: string) =>
      Effect.andThen(
        log(`→ user: ${text}`),
        send({ type: "user", message: { role: "user", content: text } }),
      ),
    control: (requestId: string, request: unknown) =>
      Effect.andThen(
        send({ type: "control_request", request_id: requestId, request }),
        Queue.take(controlResponses),
      ),
    nextToolCall: Queue.take(toolCalls),
    nextResult: Queue.take(results),
    answerToolCall: (call: OpenToolCall, text: string) =>
      Effect.andThen(
        log(`→ answer ${call.toolName}: ${text}`),
        mcpResponse(call.requestId, {
          jsonrpc: "2.0",
          id: call.rpcId,
          result: { content: [{ type: "text", text }] },
        }),
      ),
    /** Tell the CLI's MCP client the tool list changed, as a server would. */
    notifyToolsChanged: Effect.gen(function* () {
      yield* log("→ notifications/tools/list_changed");
      yield* send({
        type: "control_request",
        request_id: "spike-list-changed",
        request: {
          subtype: "mcp_message",
          server_name: INBAND_MCP_SERVER_NAME,
          message: {
            jsonrpc: "2.0",
            method: "notifications/tools/list_changed",
          },
        },
      });
      yield* Queue.take(controlResponses);
    }),
  };
});

// ---- modes -------------------------------------------------------------------

const HOLD = Duration.seconds(3);

const modes = {
  /** No user message is ever written: no model call, no tokens. */
  probe: (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("3 seconds");
      yield* probe.control("spike-status", { subtype: "mcp_status" });
      yield* Ref.update(probe.tools, (tools) => [
        ...tools,
        probeTool("second_tool", "Returns the second value."),
      ]);
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("2 seconds");
      yield* probe.control("spike-status-2", { subtype: "mcp_status" });
      // A removal travels the same way as an addition.
      yield* Ref.update(probe.tools, (tools) => tools.filter((tool) => tool.name !== "probe_tool"));
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("2 seconds");
      yield* probe.control("spike-status-3", { subtype: "mcp_status" });
    }),

  /** A call held open while "pi runs the tool", then an interrupt mid-call. */
  "round-trip": (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 seconds");
      yield* probe.user("Call the probe_tool.");
      const first = yield* probe.nextToolCall;
      yield* Effect.sleep(HOLD);
      yield* probe.answerToolCall(first, "probe-value-42");
      yield* probe.nextResult;

      yield* probe.user("Call the probe_tool once more.");
      const second = yield* probe.nextToolCall;
      yield* Effect.sleep("1 second");
      yield* probe.log("→ interrupt (mid-call)");
      yield* probe.send({
        type: "control_request",
        request_id: "spike-interrupt",
        request: { subtype: "interrupt" },
      });
      yield* probe.nextResult;
      yield* Effect.sleep("1 second");
      yield* probe.answerToolCall(second, "late");
      yield* Effect.sleep("1 second");
    }),

  /** The call is held past MCP_TOOL_TIMEOUT. */
  timeout: (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 seconds");
      yield* probe.user("Call the probe_tool.");
      yield* probe.nextToolCall;
      yield* probe.nextResult;
    }),

  /** Does the model see a tool added mid-session through list_changed? */
  "list-changed": (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 seconds");
      yield* probe.user("Call the probe_tool.");
      yield* probe.answerToolCall(yield* probe.nextToolCall, "probe-value-42");
      yield* probe.nextResult;

      yield* Ref.update(probe.tools, (tools) => [
        ...tools,
        probeTool("second_tool", "Returns the second value."),
      ]);
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("1 second");
      yield* probe.user(
        "Call the second_tool. If you have no tool by that name, reply NO-SUCH-TOOL.",
      );
      const outcome = yield* Effect.raceFirst(
        Effect.map(probe.nextToolCall, (call) => Option.some(call)),
        Effect.as(probe.nextResult, Option.none<OpenToolCall>()),
      );
      if (Option.isNone(outcome))
        return yield* probe.log("FINDING: the model did not call second_tool");
      yield* probe.log(`FINDING: the model called ${outcome.value.toolName} on the live process`);
      yield* probe.answerToolCall(outcome.value, "second-value-7");
      yield* probe.nextResult;
    }),

  /** Is a tool removed mid-session gone from what the model is offered? */
  "list-removed": (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 seconds");
      yield* Ref.update(probe.tools, (tools) => [
        ...tools,
        probeTool("second_tool", "Returns the second value."),
      ]);
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("1 second");
      yield* probe.user("Call the second_tool.");
      yield* probe.answerToolCall(yield* probe.nextToolCall, "second-value-7");
      yield* probe.nextResult;

      yield* Ref.update(probe.tools, (tools) =>
        tools.filter((tool) => tool.name !== "second_tool"),
      );
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("1 second");
      // The `system init` line of this turn lists what the model is offered.
      yield* probe.user(
        "Call the second_tool again. If you have no tool by that name, reply NO-SUCH-TOOL.",
      );
      const outcome = yield* Effect.raceFirst(
        Effect.map(probe.nextToolCall, (call) => Option.some(call)),
        Effect.as(probe.nextResult, Option.none<OpenToolCall>()),
      );
      if (Option.isNone(outcome))
        return yield* probe.log("FINDING: no tools/call for the removed tool reached the server");
      yield* probe.log(`FINDING: the CLI still called the removed ${outcome.value.toolName}`);
      yield* probe.answerToolCall(outcome.value, "second-value-7");
      yield* probe.nextResult;
    }),

  /**
   * Does a tool added while a `tools/call` is open reach the model in the
   * same turn, on the model request that follows the tool result?
   */
  "list-changed-mid-call": (probe) =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 seconds");
      yield* probe.user(
        "Call the probe_tool. After its result, call the second_tool; if you then have no tool by that name, reply NO-SUCH-TOOL.",
      );
      const first = yield* probe.nextToolCall;
      yield* Ref.update(probe.tools, (tools) => [
        ...tools,
        probeTool("second_tool", "Returns the second value."),
      ]);
      yield* probe.notifyToolsChanged;
      yield* Effect.sleep("1 second");
      yield* probe.answerToolCall(first, "probe-value-42");
      const outcome = yield* Effect.raceFirst(
        Effect.map(probe.nextToolCall, (call) => Option.some(call)),
        Effect.as(probe.nextResult, Option.none<OpenToolCall>()),
      );
      if (Option.isNone(outcome))
        return yield* probe.log("FINDING: the turn ended without a second_tool call");
      yield* probe.log(`FINDING: the model called ${outcome.value.toolName} in the same turn`);
      yield* probe.answerToolCall(outcome.value, "second-value-7");
      yield* probe.nextResult;
    }),
} satisfies Record<
  string,
  (probe: Effect.Success<ReturnType<typeof launchProbe>>) => Effect.Effect<void>
>;

const MODE_NAMES = [
  "probe",
  "round-trip",
  "timeout",
  "list-changed",
  "list-changed-mid-call",
  "list-removed",
] as const;

const spikeCommand = Command.make(
  "inband-mcp",
  {
    mode: Argument.Literals("mode", MODE_NAMES).pipe(
      Argument.withDescription("probe spends no tokens; the others run one or two haiku turns"),
    ),
    claude: Flag.String("claude").pipe(
      Flag.withDescription("The Claude Code binary to probe"),
      Flag.withDefault("claude"),
    ),
  },
  Effect.fn("Spike.main")(function* (input) {
    const probe = yield* launchProbe({
      claude: input.claude,
      mcpToolTimeoutMillis: input.mode === "timeout" ? Option.some("2000") : Option.none(),
    });
    yield* modes[input.mode](probe).pipe(Effect.timeoutOption("90 seconds"));
  }, Effect.scoped),
).pipe(
  Command.withDescription("Probe Claude Code's in-band MCP server on the stdio control channel"),
);

NodeRuntime.runMain(
  Command.run(spikeCommand, { version: "1" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        nodeFileSystemLayer,
        nodeCryptoLayer,
        nodeChildProcessSpawnerLayer,
        NodeStdio.layer,
        NodeTerminal.layer,
      ),
    ),
  ),
);
