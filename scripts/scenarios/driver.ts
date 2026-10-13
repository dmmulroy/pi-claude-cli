/**
 * Scenario driver: runs one named sequence of pi model calls against the
 * provider runtime, with the stub CLI first on PATH.
 *
 *   node scripts/scenarios/driver.ts <scenario>
 *
 * Run through `scripts/scenarios.ts`, which sets the environment, records the
 * trace and asserts on it. The driver itself only checks what a trace cannot
 * show: the terminal event pi received and files on disk.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import {
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
} from "effect";
import { Type } from "typebox";
import type { EpisodeOptions } from "../../src/episode.ts";
import { nodeFileSystemLayer } from "../../src/node-platform.ts";
import { isClaudeToolUseId } from "../../src/tool-call-id.ts";
import {
  providerLayer,
  type ProviderRuntime,
  startProviderRuntime,
} from "../../src/provider-runtime.ts";

/** The driver saw something other than what the scenario expects. */
class ScenarioExpectationFailed extends Data.TaggedError(
  "ScenarioExpectationFailed",
)<{ readonly message: string }> {}

const expect = (condition: boolean, message: string) =>
  condition
    ? Effect.void
    : Effect.fail(new ScenarioExpectationFailed({ message }));

// ---- a pi conversation -----------------------------------------------------

const SESSION_ID = "scenario-session";

const tool = (name: string): Tool => ({
  name,
  description: `Stub ${name} tool`,
  parameters: Type.Object({ path: Type.String() }),
});

const builtinHaiku = getBuiltinModels("anthropic").find(
  (model) => model.id === "claude-haiku-4-5",
);

/** The model as pi hands it to this provider. */
const scenarioModel = Effect.gen(function* () {
  if (builtinHaiku === undefined)
    return yield* new ScenarioExpectationFailed({
      message: "pi-ai no longer lists claude-haiku-4-5",
    });
  const model: Model<Api> = {
    ...builtinHaiku,
    provider: "pi-claude-cli",
    api: "pi-claude-cli",
  };
  return model;
});

interface Conversation {
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly messages: ReadonlyArray<Message>;
}

const textOf = (message: AssistantMessage): string =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** One runtime and one conversation, driven the way pi drives a provider. */
const scenarioSession = Effect.fn("ScenarioDriver.session")(function* (
  runtime: ProviderRuntime,
) {
  const model = yield* scenarioModel;
  const conversation = yield* Ref.make<Conversation>({
    systemPrompt: "You are a scenario.",
    tools: [tool("read"), tool("bash")],
    messages: [],
  });
  const append = (message: Message) =>
    Ref.update(conversation, (current) => ({
      ...current,
      messages: [...current.messages, message],
    }));

  /**
   * One pi model call over the current conversation; appends the answer.
   * `onEvent` sees each stream event as pi would.
   */
  const call = (
    options: EpisodeOptions = {},
    onEvent: (event: AssistantMessageEvent) => void = () => undefined,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(conversation);
      const answer = yield* Effect.promise(async () => {
        const stream = createAssistantMessageEventStream();
        runtime.startEpisode(
          stream,
          model,
          {
            systemPrompt: current.systemPrompt,
            tools: [...current.tools],
            messages: [...current.messages],
          },
          { sessionId: SESSION_ID, ...options },
        );
        for await (const event of stream) onEvent(event);
        return stream.result();
      });
      yield* append(answer);
      yield* Console.log(
        `  ${answer.stopReason}: ${answer.errorMessage ?? textOf(answer)}`,
      );
      return answer;
    });

  const user = (text: string) =>
    append({ role: "user", content: text, timestamp: Date.now() });

  /** Say something and get the model's answer. */
  const say = (
    text: string,
    options?: EpisodeOptions,
    onEvent?: (event: AssistantMessageEvent) => void,
  ) => Effect.andThen(user(text), call(options, onEvent));

  /** Answer every tool call of the latest assistant message, as pi would. */
  const answerToolCalls = (text: string | ((toolName: string) => string)) =>
    Effect.gen(function* () {
      const { messages } = yield* Ref.get(conversation);
      const latest = messages[messages.length - 1];
      if (latest?.role !== "assistant") return;
      for (const block of latest.content) {
        if (block.type !== "toolCall") continue;
        yield* append({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [
            {
              type: "text",
              text: typeof text === "string" ? text : text(block.name),
            },
          ],
          isError: false,
          timestamp: Date.now(),
        });
      }
    });

  return {
    say,
    call,
    user,
    append,
    answerToolCalls,
    update: (change: (current: Conversation) => Conversation) =>
      Ref.update(conversation, change),
    retireParked: Effect.promise(() => runtime.retireParkedProcesses()),
    messages: Effect.map(Ref.get(conversation), (current) => current.messages),
  };
});

type ScenarioSession = Effect.Success<ReturnType<typeof scenarioSession>>;

const expectDone = (answer: AssistantMessage, text: string) =>
  expect(
    answer.stopReason === "stop" && textOf(answer).includes(text),
    `expected a completed answer containing "${text}", got ${answer.stopReason}: ${answer.errorMessage ?? textOf(answer)}`,
  );

const expectError = (
  answer: AssistantMessage,
  reason: "error" | "aborted",
  text: string,
) =>
  expect(
    answer.stopReason === reason && (answer.errorMessage ?? "").includes(text),
    `expected ${reason} mentioning "${text}", got ${answer.stopReason}: ${answer.errorMessage ?? textOf(answer)}`,
  );

// ---- scenarios -------------------------------------------------------------

const scenarioDirectory = Config.String("SCENARIO_TMP");

const readStubFile = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(yield* scenarioDirectory, name));
  });

/** The pid of the process the stub started for the `orphan` keyword. */
const stubChildPid = Effect.gen(function* () {
  const pid = Number((yield* readStubFile("child.pid")).trim());
  yield* expect(
    Number.isInteger(pid) && pid > 0,
    `expected the stub to record its child's pid, got ${pid}`,
  );
  return pid;
});

const isProcessRunning = (pid: number) =>
  Effect.sync(() => {
    try {
      // Signal 0 only checks that the process exists.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** The process is gone within the time a background retire may take. */
const expectProcessGone = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!(yield* isProcessRunning(pid))) return;
      yield* Effect.sleep("50 millis");
    }
    // Do not leave it behind when the expectation fails.
    yield* Effect.sync(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore);
    yield* new ScenarioExpectationFailed({
      message: `expected process ${pid}, started by the CLI, to die with it`,
    });
  });

/** A tool call id as another provider mints it: too long and with `|`. */
const FOREIGN_TOOL_CALL_ID = `call_${"x".repeat(70)}|fc_scenario`;

/**
 * A finished exchange another provider served: a tool call with an id Claude
 * would reject, its result, and the answer.
 */
const foreignToolExchange = (session: ScenarioSession) =>
  Effect.gen(function* () {
    const foreign = {
      api: "openai-responses",
      provider: "openai",
      model: "gpt-scenario",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    } as const;
    yield* session.user("read the file");
    yield* session.append({
      ...foreign,
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: FOREIGN_TOOL_CALL_ID,
          name: "read",
          arguments: { path: "notes.txt" },
        },
      ],
      stopReason: "toolUse",
    });
    yield* session.answerToolCalls("NOTES");
    yield* session.append({
      ...foreign,
      role: "assistant",
      content: [{ type: "text", text: "The file says NOTES." }],
      stopReason: "stop",
    });
  });

const StdinFrame = Schema.Struct({
  type: Schema.String,
  held: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      tool_use_id: Schema.optional(Schema.String),
      signature: Schema.optional(Schema.String),
      thinking: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
});

/** Every user and assistant message the CLI processes read from stdin. */
const stdinFrames = Effect.gen(function* () {
  const lines = (yield* readStubFile("frames.jsonl")).trim().split("\n");
  return yield* Effect.forEach(lines, (line) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(StdinFrame))(line),
  );
});

const toolRoundTrip = (session: ScenarioSession) =>
  Effect.gen(function* () {
    const asked = yield* session.say("please tool:read");
    yield* expect(
      asked.stopReason === "toolUse" &&
        asked.content.some(
          (block) => block.type === "toolCall" && block.name === "read",
        ),
      `expected a read toolCall, got ${asked.stopReason}`,
    );
    yield* session.answerToolCalls("FILE-CONTENT");
    return yield* session.call();
  });

/** What the CLI was told its tools are, one entry per `tools/list`. */
const expectToolLists = (expected: ReadonlyArray<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const listed = (yield* readStubFile("tools.jsonl")).trim();
    const wanted = expected.map((names) => JSON.stringify(names)).join("\n");
    yield* expect(
      listed === wanted,
      `expected the CLI to list its tools as ${wanted}, got ${listed}`,
    );
  });

/** A turn, a different tool list, another turn. */
const changedToolsBetweenTurns = (session: ScenarioSession) =>
  Effect.gen(function* () {
    yield* session.say("hello");
    yield* session.update((current) => ({ ...current, tools: [tool("read")] }));
    yield* expectDone(yield* session.say("again"), "PORT-OK");
    // The same two lists whether one process listed twice or two listed once.
    yield* expectToolLists([["read", "bash"], ["read"]]);
  });

const toolCallNames = (message: AssistantMessage): ReadonlyArray<string> =>
  message.content.flatMap((block) =>
    block.type === "toolCall" ? [block.name] : [],
  );

const expectToolCalls = (
  answer: AssistantMessage,
  names: ReadonlyArray<string>,
) =>
  expect(
    answer.stopReason === "toolUse" &&
      [...toolCallNames(answer)].sort().join() === [...names].sort().join(),
    `expected one message calling ${names.join(" and ")}, got ${answer.stopReason}: ${
      toolCallNames(answer).join() || (answer.errorMessage ?? textOf(answer))
    }`,
  );

const scenarios: Record<
  string,
  (
    session: ScenarioSession,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>
> = {
  "fresh-spawn": (session) =>
    Effect.gen(function* () {
      yield* expectDone(yield* session.say("hello"), "PORT-OK");
    }),

  "warm-turn": (session) =>
    Effect.gen(function* () {
      yield* expectDone(yield* session.say("hello"), "PORT-OK");
      yield* expectDone(yield* session.say("again"), "PORT-OK");
    }),

  "tool-handoff": (session) =>
    Effect.gen(function* () {
      yield* expectDone(
        yield* toolRoundTrip(session),
        "TOOL-DONE FILE-CONTENT",
      );
      yield* expectToolLists([["read", "bash"]]);
    }),

  "tool-handoff-parallel": (session) =>
    Effect.gen(function* () {
      const asked = yield* session.say("please tools:read,bash");
      const names = asked.content.flatMap((block) =>
        block.type === "toolCall" ? [block.name] : [],
      );
      yield* expect(
        asked.stopReason === "toolUse" && names.join() === "read,bash",
        `expected read and bash toolCalls in one message, got ${asked.stopReason}: ${names.join()}`,
      );
      // Each result must reach the call that asked for it.
      yield* session.answerToolCalls((toolName) => `${toolName}-RESULT`);
      yield* expectDone(
        yield* session.call(),
        "TOOL-DONE read-RESULT|bash-RESULT",
      );
    }),

  "tool-abandoned": (session) =>
    Effect.gen(function* () {
      yield* session.say("please tool:read");
      // pi moves on without answering the tool call.
      yield* expectDone(yield* session.say("never mind"), "PORT-OK");
      yield* Effect.sleep("300 millis");
    }),

  "handoff-proxy-off": (session) =>
    Effect.gen(function* () {
      const asked = yield* session.say("please tool:read");
      yield* expect(
        asked.stopReason === "toolUse",
        `expected toolUse, got ${asked.stopReason}`,
      );
      yield* session.answerToolCalls("FILE-CONTENT");
      yield* expectDone(yield* session.call(), "PORT-OK");
    }),

  "changed-history": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      // A branch edit: the first user message is no longer what was sent.
      yield* session.update((current) => ({
        ...current,
        messages: current.messages.map((message, index) =>
          index === 0 && message.role === "user"
            ? { ...message, content: "hello, edited" }
            : message,
        ),
      }));
      yield* expectDone(yield* session.say("again"), "PORT-OK");
    }),

  "changed-prompt": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      yield* session.update((current) => ({
        ...current,
        systemPrompt: "You are a different scenario.",
      }));
      yield* expectDone(yield* session.say("again"), "PORT-OK");
    }),

  "changed-tools": (session) => changedToolsBetweenTurns(session),
  "changed-tools-refused": (session) => changedToolsBetweenTurns(session),

  "changed-tools-handoff": (session) =>
    Effect.gen(function* () {
      yield* session.say("please tool:read");
      // pi's tool run changed the active tools before its result came back.
      yield* session.update((current) => ({
        ...current,
        tools: [...current.tools, tool("grep")],
      }));
      yield* session.answerToolCalls("FILE-CONTENT");
      yield* expectDone(yield* session.call(), "TOOL-DONE FILE-CONTENT");
      yield* expectToolLists([
        ["read", "bash"],
        ["read", "bash", "grep"],
      ]);
    }),

  "foreign-provider": (session) =>
    Effect.gen(function* () {
      const first = yield* session.say("hello");
      yield* session.user("asked of another provider");
      yield* session.append({
        ...first,
        api: "anthropic-messages",
        provider: "anthropic",
        content: [{ type: "text", text: "answered elsewhere" }],
      });
      yield* expectDone(yield* session.say("back again"), "PORT-OK");
    }),

  "thinking-change": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      yield* expectDone(
        yield* session.say("think harder", { reasoning: "high" }),
        "PORT-OK",
      );
    }),

  "thinking-refused": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      yield* expectDone(
        yield* session.say("think harder", { reasoning: "high" }),
        "PORT-OK",
      );
    }),

  "abort-mid-stream": (session) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      // Abort once the first text has reached pi.
      const answer = yield* session.say(
        "hang",
        { signal: controller.signal },
        (event) => {
          if (event.type === "text_delta") controller.abort();
        },
      );
      yield* expectError(answer, "aborted", "Request aborted");
      yield* expect(
        textOf(answer).includes("PARTIAL"),
        "expected the aborted message to keep what was already streamed",
      );
      // The process is retired in the background, after `aborted`.
      yield* Effect.sleep("400 millis");
    }),

  "abort-during-launch": (session) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.sleep("30 millis").pipe(
        Effect.andThen(Effect.sync(() => controller.abort())),
        Effect.forkChild,
      );
      yield* expectError(
        yield* session.say("hello", { signal: controller.signal }),
        "aborted",
        "Request aborted",
      );
      yield* Effect.sleep("400 millis");
    }),

  "already-aborted": (session) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort();
      yield* expectError(
        yield* session.say("hello", { signal: controller.signal }),
        "aborted",
        "Request aborted",
      );
    }),

  "inactivity-timeout": (session) =>
    Effect.gen(function* () {
      yield* expectError(yield* session.say("hang"), "error", "timed out");
      yield* Effect.sleep("300 millis");
    }),

  "idle-control-traffic": (session) =>
    Effect.gen(function* () {
      yield* expectDone(yield* session.say("chatter"), "PORT-OK");
    }),

  "process-group-killed": (session) =>
    Effect.gen(function* () {
      yield* expectError(yield* session.say("orphan"), "error", "timed out");
      yield* expectProcessGone(yield* stubChildPid);
    }),

  "abort-kills-process-group": (session) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const answer = yield* session.say(
        "orphan",
        { signal: controller.signal },
        (event) => {
          if (event.type === "text_delta") controller.abort();
        },
      );
      yield* expectError(answer, "aborted", "Request aborted");
      yield* expectProcessGone(yield* stubChildPid);
    }),

  "structured-import": (session) =>
    Effect.gen(function* () {
      yield* foreignToolExchange(session);
      // Keepalive is off, so this call imports the whole history afresh.
      yield* expectDone(yield* session.say("and now?"), "PORT-OK");
      const frames = yield* stdinFrames;
      const imported = frames.slice(-5);
      yield* expect(
        imported
          .map((frame) => `${frame.type}${frame.held ? ":held" : ""}`)
          .join(" ") === "user:held assistant user:held assistant user",
        `expected the history as five ordered messages, got ${JSON.stringify(frames.map((frame) => [frame.type, frame.held]))}`,
      );
      const [, call, result] = imported;
      const toolUse = call?.content.find((block) => block.type === "tool_use");
      const toolResult = result?.content.find(
        (block) => block.type === "tool_result",
      );
      yield* expect(
        toolUse?.name === "mcp__custom-tools__read" &&
          toolUse.id !== undefined &&
          toolUse.id !== FOREIGN_TOOL_CALL_ID &&
          isClaudeToolUseId(toolUse.id) &&
          toolResult?.tool_use_id === toolUse.id,
        `expected the foreign tool call id replaced by one valid id on both sides, got ${JSON.stringify([toolUse, toolResult])}`,
      );
      yield* expect(
        call?.model === "claude-haiku-4-5",
        `expected the replayed assistant message to name the process's model, got ${call?.model}`,
      );
      // pi's own messages keep the id pi stored.
      yield* expect(
        JSON.stringify(yield* session.messages).includes(FOREIGN_TOOL_CALL_ID),
        "expected pi's history to keep its own tool call id",
      );
    }),

  "structured-import-refused": (session) =>
    Effect.gen(function* () {
      yield* foreignToolExchange(session);
      yield* expectDone(yield* session.say("and now?"), "PORT-OK");
      yield* Effect.sleep("300 millis");
    }),

  "flat-import-default": (session) =>
    Effect.gen(function* () {
      yield* expectDone(yield* session.say("hello"), "PORT-OK");
      yield* expectDone(yield* session.say("and now?"), "PORT-OK");
      const frames = yield* stdinFrames;
      yield* expect(
        frames.every((frame) => frame.type === "user" && !frame.held),
        `expected only plain user messages, got ${JSON.stringify(frames.map((frame) => [frame.type, frame.held]))}`,
      );
    }),

  "process-dies": (session) =>
    Effect.gen(function* () {
      const answer = yield* session.say("die");
      yield* expectError(answer, "error", "simulated crash");
      yield* expectError(answer, "error", "code 3");
      yield* Effect.sleep("200 millis");
    }),

  "turn-fails": (session) =>
    Effect.gen(function* () {
      yield* expectError(
        yield* session.say("failturn"),
        "error",
        "stub: the turn failed",
      );
      yield* Effect.sleep("200 millis");
    }),

  "idle-expiry": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      yield* Effect.sleep("900 millis");
      yield* expectDone(yield* session.say("again"), "PORT-OK");
    }),

  "no-session": (session) =>
    Effect.gen(function* () {
      yield* expectDone(
        yield* session.say("hello", { sessionId: undefined }),
        "PORT-OK",
      );
      yield* Effect.sleep("200 millis");
    }),

  "lifecycle-retire": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      // What `session_compact`, `model_select` and the rest do.
      yield* session.retireParked;
      yield* expectDone(yield* session.say("again"), "PORT-OK");
    }),

  "launch-flags": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      const argv = yield* launchArgv;
      const after = (flag: string) => argv[argv.indexOf(flag) + 1];
      yield* expect(
        after("--settings") === "/host/guards.json",
        `expected the host settings file to be passed through, got ${after("--settings")}`,
      );
      // Empty arguments must survive the launch: a shell would drop them.
      yield* expect(
        after("--tools") === "" && after("--setting-sources") === "",
        `expected --tools "" and --setting-sources "", got ${JSON.stringify(argv)}`,
      );
      for (const forbidden of [
        "--bare",
        "--safe-mode",
        "--resume",
        "--dangerously-skip-permissions",
      ])
        yield* expect(
          !argv.includes(forbidden),
          `expected the launch never to use ${forbidden}`,
        );
      yield* expect(
        argv.includes("--no-session-persistence") &&
          argv.includes("--strict-mcp-config"),
        "expected session persistence off and a strict MCP config",
      );
      const seen = yield* readStubFile("env.json");
      // The host's own isolation setting is overridden for the child only,
      // and its account selection is kept.
      yield* expect(
        seen.includes('"disableClaudeMds":"1"') &&
          seen.includes('"secureStorageDir":"/account/selected"'),
        `expected the child-only overrides and the host's account selection, got ${seen}`,
      );
    }),

  live: (session) =>
    Effect.gen(function* () {
      const asked = yield* session.say(
        'Call the read tool once with path "a.txt". After its result, answer with the single word DONE.',
      );
      yield* expect(
        asked.stopReason === "toolUse" &&
          asked.content.some(
            (block) => block.type === "toolCall" && block.name === "read",
          ),
        `expected a read toolCall from the model, got ${asked.stopReason}: ${asked.errorMessage ?? textOf(asked)}`,
      );
      yield* session.answerToolCalls("the file says: hello");
      yield* expectDone(yield* session.call(), "");
      yield* expectDone(
        yield* session.say("Answer with the single word OK."),
        "",
      );
    }),

  "live-parallel-tools": (session) =>
    Effect.gen(function* () {
      const asked = yield* session.say(
        'In one response, call both tools in parallel: read with path "a.txt" and bash with path "b.txt". Do not wait for one result before making the other call. After both results, reply with exactly: read=<the read result> bash=<the bash result>',
      );
      yield* expectToolCalls(asked, ["read", "bash"]);
      // Distinct results: each must reach the call that asked for it.
      yield* session.answerToolCalls((toolName) =>
        toolName === "read" ? "ALPHA-17" : "BRAVO-42",
      );
      const answer = yield* session.call();
      yield* expectDone(answer, "read=ALPHA-17");
      yield* expectDone(answer, "bash=BRAVO-42");
    }),

  "live-tools-change": (session) =>
    Effect.gen(function* () {
      yield* expectDone(
        yield* session.say("Answer with the single word OK."),
        "",
      );
      // A tool added between turns.
      yield* session.update((current) => ({
        ...current,
        tools: [...current.tools, tool("lookup")],
      }));
      yield* expectToolCalls(
        yield* session.say(
          'Call the lookup tool with path "x". A tool named fetch becomes available once lookup has returned: call it then with path "y", or answer NO-SUCH-TOOL if you still have no such tool. After the fetch result, answer with the single word DONE.',
        ),
        ["lookup"],
      );
      // A tool added while the lookup call is open.
      yield* session.update((current) => ({
        ...current,
        tools: [...current.tools, tool("fetch")],
      }));
      yield* session.answerToolCalls("lookup-result");
      yield* expectToolCalls(yield* session.call(), ["fetch"]);
      yield* session.answerToolCalls("fetch-result");
      yield* expectDone(yield* session.call(), "DONE");
      // A tool removed between turns. Only that the process takes the change
      // is checked here: a model asked about a tool it has just used answers
      // from the conversation, not from its tool definitions. What the CLI
      // offers after a removal is the spike's to show (`list-removed`).
      yield* session.update((current) => ({
        ...current,
        tools: current.tools.filter((each) => each.name !== "fetch"),
      }));
      yield* expectDone(
        yield* session.say("Answer with the single word OK."),
        "OK",
      );
    }),

  "env-stripping": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      const seen = yield* readStubFile("env.json");
      yield* expect(
        seen.includes('"anthropic":[]'),
        `expected no ANTHROPIC_* variables in the CLI's environment, got ${seen}`,
      );
      yield* expect(
        seen.includes('"mcpToolTimeout":"3600000"') &&
          seen.includes('"disableAutoCompact":"1"') &&
          seen.includes('"disableCompact":"1"'),
        `expected the child-only environment, got ${seen}`,
      );
      // pi owns retries, whatever the host's environment asks for.
      yield* expect(
        seen.includes('"maxRetries":"0"') &&
          seen.includes('"retryWatchdog":null') &&
          seen.includes('"disableNonessentialTraffic":"1"'),
        `expected no CLI retries and no non-essential traffic, got ${seen}`,
      );
    }),
};

/** The arguments the first CLI process was launched with. */
const launchArgv = Effect.gen(function* () {
  const first = (yield* readStubFile("argv.jsonl")).trim().split("\n")[0];
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  )(first);
});

/** The private runtime directory, read from the path the CLI was launched with. */
const stagedPromptDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const argv = yield* launchArgv;
  return path.dirname(argv[argv.indexOf("--system-prompt-file") + 1] ?? "");
});

/** `session_shutdown`: disposing ends the parked process and removes the directory. */
const shutdownScenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runtime = startProviderRuntime();
  const session = yield* scenarioSession(runtime);
  yield* expectDone(yield* session.say("hello"), "PORT-OK");
  const directory = yield* stagedPromptDirectory;
  yield* expect(
    yield* fs.exists(directory),
    `expected the runtime directory ${directory} to exist while the runtime is up`,
  );
  yield* Effect.promise(() => runtime.dispose());
  yield* expect(
    !(yield* fs.exists(directory)),
    `expected the runtime directory ${directory} to be removed on dispose`,
  );
});

/** A layer that fails to build: every call still gets its `error` event. */
const layerBuildFailureScenario = Effect.gen(function* () {
  const runtime = startProviderRuntime(
    providerLayer.pipe(
      Layer.provideMerge(
        Layer.effectDiscard(
          Effect.fail(new Error("scenario: the provider layer cannot build")),
        ),
      ),
    ),
  );
  const session = yield* scenarioSession(runtime);
  for (const text of ["hello", "again"])
    yield* expectError(
      yield* session.say(text).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () =>
            Effect.fail(
              new ScenarioExpectationFailed({
                message: "the call hung instead of ending with an error",
              }),
            ),
        }),
      ),
      "error",
      "the provider layer cannot build",
    );
  yield* Effect.promise(() => runtime.dispose());
});

const runScenario = (name: string) => {
  if (name === "session-shutdown") return shutdownScenario;
  if (name === "layer-build-failure") return layerBuildFailureScenario;
  const scenario = scenarios[name];
  if (scenario === undefined)
    return Effect.fail(
      new ScenarioExpectationFailed({
        message: `unknown scenario "${name}"; known: ${[...Object.keys(scenarios), "session-shutdown", "layer-build-failure"].join(", ")}`,
      }),
    );
  return Effect.gen(function* () {
    const runtime = startProviderRuntime();
    const session = yield* scenarioSession(runtime);
    yield* scenario(session).pipe(
      Effect.ensuring(Effect.promise(() => runtime.dispose())),
    );
  });
};

const main = Effect.gen(function* () {
  const name = process.argv[2] ?? "";
  yield* Console.log(`scenario ${name}`);
  yield* runScenario(name);
}).pipe(
  Effect.tapError((error) =>
    Console.error(
      `scenario FAILED: ${error instanceof Error ? error.message : String(error)}`,
    ),
  ),
  Effect.provide(nodeFileSystemLayer),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
