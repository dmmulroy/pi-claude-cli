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
import type { EpisodeOptions } from "../../src/episode.ts";
import { nodeFileSystemLayer } from "../../src/node-platform.ts";
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
  // A JSON Schema object is what pi's tools carry at runtime.
  parameters: Schema.toJsonSchemaDocument(
    Schema.Struct({ path: Schema.String }),
  ).schema as Tool["parameters"],
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
  const answerToolCalls = (text: string) =>
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
          content: [{ type: "text", text }],
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
      const tools = yield* readStubFile("tools.jsonl");
      yield* expect(
        tools.trim() === JSON.stringify(["read", "bash"]),
        `expected the CLI to be offered exactly pi's tools, got ${tools}`,
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

  "changed-tools": (session) =>
    Effect.gen(function* () {
      yield* session.say("hello");
      yield* session.update((current) => ({
        ...current,
        tools: [tool("read")],
      }));
      yield* expectDone(yield* session.say("again"), "PORT-OK");
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
          seen.includes('"disableAutoCompact":"1"'),
        `expected the child-only environment, got ${seen}`,
      );
    }),
};

/** The private runtime directory, read from the path the CLI was launched with. */
const stagedPromptDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const argv = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  )((yield* readStubFile("argv.jsonl")).trim().split("\n")[0]);
  const promptFile = argv[argv.indexOf("--system-prompt-file") + 1] ?? "";
  return path.dirname(promptFile);
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
