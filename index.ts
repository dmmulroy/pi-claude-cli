/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers the `pi-claude-cli` provider, which serves pi model calls through
 * the Claude Code CLI so they run on the user's Claude subscription. pi owns
 * the prompt, tools and conversation.
 *
 * This file stays free of Effect imports. The provider's runtime is loaded on
 * the first model call: importing Effect at the top would cost every pi
 * start about 135 ms and 60 MB, used or not.
 */

import {
  type Api,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBridge } from "./src/event-bridge.ts";
import { rewriteOverflowMessage } from "./src/overflow.ts";
import type { ProviderRuntime } from "./src/provider-runtime.ts";
import { endStreamWithError } from "./src/terminal-event.ts";
import { cliThinkingLevelMap } from "./src/thinking-config.ts";

const PROVIDER_ID = "pi-claude-cli";

type StartEpisode = ProviderRuntime["startEpisode"];

/** End a stream whose provider runtime could not even be loaded. */
function failStream(
  piStream: AssistantMessageEventStream,
  model: Model<Api>,
  cause: unknown,
): void {
  const reason = cause instanceof Error ? cause.message : String(cause);
  endStreamWithError(
    piStream,
    createEventBridge(piStream, model).getOutput(),
    "error",
    `pi-claude-cli could not start its provider runtime: ${reason}`,
  );
}

export default function (pi: ExtensionAPI) {
  try {
    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      // pi's own per-model map, less `minimal` on adaptive models (it would
      // send what `low` sends), so the selector offers only levels the model
      // has, and each maps to the effort pi uses.
      thinkingLevelMap: cliThinkingLevelMap(model),
    }));

    // One runtime per extension instance: pi calls this factory once per
    // session and emits `session_shutdown` before tearing it down.
    let loaded: Promise<ProviderRuntime> | undefined;
    const provider = (): Promise<ProviderRuntime> =>
      (loaded ??= import("./src/provider-runtime.ts").then((module) =>
        module.startProviderRuntime(),
      ));

    // pi needs the stream back synchronously, so the episode starts once the
    // runtime has loaded and the stream is returned at once.
    const streamSimple = (
      model: Parameters<StartEpisode>[1],
      context: Parameters<StartEpisode>[2],
      options?: Parameters<StartEpisode>[3],
    ): AssistantMessageEventStream => {
      const piStream = createAssistantMessageEventStream();
      provider().then(
        (runtime) => runtime.startEpisode(piStream, model, context, options),
        (cause) => failStream(piStream, model, cause),
      );
      return piStream;
    };

    // A parked process is a cache of the history it acknowledged. Every event
    // that replaces or rewrites that history retires it; the next call
    // imports pi's current history into a fresh process. Nothing is loaded
    // just to retire nothing.
    const retireParked = async () => {
      await (await loaded?.catch(() => undefined))?.retireParkedProcesses();
    };
    pi.on("session_start", retireParked);
    pi.on("model_select", retireParked);
    pi.on("session_tree", retireParked);
    pi.on("session_compact", retireParked);

    // Disposing ends every CLI process and timer, which is what lets print
    // mode exit. A disposed runtime cannot be reused, so the next call
    // builds a fresh one.
    pi.on("session_shutdown", async () => {
      const current = loaded;
      loaded = undefined;
      await (await current?.catch(() => undefined))?.dispose();
    });

    // pi.registerProvider() feeds pi's provider composer, but pi's default
    // stream fn resolves model.api against pi-ai's global api registry
    // instead; print mode and nested agent loops take that path. Register
    // the custom api id there too.
    registerApiProvider(
      { api: PROVIDER_ID, stream: streamSimple, streamSimple },
      PROVIDER_ID,
    );

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).
    pi.on("message_end", (event, ctx) =>
      rewriteOverflowMessage(event.message, ctx.model?.provider),
    );

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple,
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
