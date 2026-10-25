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

import * as piAi from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  accountModelsEnabled,
  builtinProviderModels,
  createModelRefresh,
  type ProviderModel,
} from "./src/account-models.ts";
import {
  type CliAuthStatusCache,
  createCliAuthStatusCache,
  defaultCliAuthStatusFile,
  describeCliAuthStatus,
  fileCliAuthStatusStore,
  probeCliAuthStatus,
  providerAuthCheck,
} from "./src/cli-auth.ts";
import { createEventBridge } from "./src/event-bridge.ts";
import { rewriteOverflowMessage } from "./src/overflow.ts";
import type { ProviderRuntime } from "./src/provider-runtime.ts";
import { endStreamWithError } from "./src/terminal-event.ts";

const PROVIDER_ID = "pi-claude-cli";

/** What pi's `/login` says for this provider: the CLI owns the login. */
const LOGIN_HINT =
  "Claude Code manages its own login. Run `claude auth login` in a terminal; pi-claude-cli uses it automatically. `/pi-claude-cli-status` shows what it finds.";

/** One of the provider's models as pi's model list holds it. */
const piModel = (model: ProviderModel): Model<Api> => ({
  ...model,
  api: PROVIDER_ID,
  provider: PROVIDER_ID,
  baseUrl: PROVIDER_ID,
});

type StartEpisode = ProviderRuntime["startEpisode"];

let sharedCliAuthStatus: CliAuthStatusCache | undefined;
/**
 * The CLI's login, one cache for the whole pi process: pi runs this factory
 * once per session (sub-agents included), and each would otherwise read the
 * file and launch `claude auth status` again.
 */
const cliAuthStatus = (): CliAuthStatusCache =>
  (sharedCliAuthStatus ??= createCliAuthStatusCache(
    probeCliAuthStatus,
    fileCliAuthStatusStore(defaultCliAuthStatusFile()),
  ));

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
    const catalogue = getModels("anthropic");
    // Until pi has refreshed (and on a pi without dynamic models) the list
    // is pi's whole Anthropic catalogue.
    let models = builtinProviderModels(catalogue).map(piModel);
    // The probe is loaded on demand: it brings Effect with it.
    const probe = () => import("./src/model-probe.ts");
    const refreshModels = createModelRefresh(catalogue, {
      version: async (signal) => (await probe()).probeCliVersion(signal),
      models: async (signal) => (await probe()).probeAccountModels(signal),
    });
    const authStatus = cliAuthStatus();

    // One runtime per extension instance: pi calls this factory once per
    // session and emits `session_shutdown` before tearing it down.
    let loaded: Promise<ProviderRuntime> | undefined;
    const provider = (): Promise<ProviderRuntime> =>
      (loaded ??= import("./src/provider-runtime.ts").then((module) =>
        module.startProviderRuntime(),
      ));
    /** The runtime if one was ever loaded; nothing is loaded just to ask. */
    const loadedRuntime = async () => await loaded?.catch(() => undefined);

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
      await (await loadedRuntime())?.retireParkedProcesses();
    };
    pi.on("session_start", retireParked);
    pi.on("model_select", retireParked);
    pi.on("session_tree", retireParked);
    pi.on("session_compact", retireParked);

    // pi disposes a session's resources by its id, also for sessions that
    // are not this extension's own, such as a sub-agent's that called this
    // provider through pi-ai: its parked process goes with it rather than
    // waiting out the keepalive. A pi-ai older than the hook has no such
    // export, which a namespace import reads as undefined.
    const registerCleanup: typeof piAi.registerSessionResourceCleanup | undefined =
      piAi.registerSessionResourceCleanup;
    const unregisterCleanup =
      typeof registerCleanup === "function"
        ? registerCleanup((sessionId) => {
            void loadedRuntime().then((runtime) => runtime?.retireSession(sessionId));
          })
        : undefined;

    // Disposing ends every CLI process and timer, which is what lets print
    // mode exit. A disposed runtime cannot be reused, so the next call
    // builds a fresh one.
    pi.on("session_shutdown", async () => {
      unregisterCleanup?.();
      const current = loaded;
      loaded = undefined;
      await (await current?.catch(() => undefined))?.dispose();
    });

    // pi.registerProvider() feeds pi's provider composer, but pi's default
    // stream fn resolves model.api against pi-ai's global api registry
    // instead; print mode and nested agent loops take that path. Register
    // the custom api id there too.
    registerApiProvider({ api: PROVIDER_ID, stream: streamSimple, streamSimple }, PROVIDER_ID);

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).
    pi.on("message_end", (event, ctx) =>
      rewriteOverflowMessage(event.message, ctx.model?.provider),
    );

    pi.registerCommand("pi-claude-cli-status", {
      description: "Check that Claude Code is installed and logged in",
      handler: async (_args, ctx) => {
        const { level, message } = describeCliAuthStatus(await authStatus.refresh());
        ctx.ui.notify(message, level);
      },
    });

    const nativeProvider: Provider = {
      id: PROVIDER_ID,
      name: PROVIDER_ID,
      baseUrl: PROVIDER_ID,
      auth: {
        // The CLI owns the credentials; nothing here reads or stores them.
        // pi offers the models while the CLI is installed and not logged
        // out, and a subscription login reports as OAuth so pi labels the
        // list-price cost "(sub)".
        apiKey: {
          name: "Claude Code login",
          check: async ({ signal }) => providerAuthCheck(await authStatus.status(signal)),
          resolve: async () => ({
            auth: { apiKey: "unused" },
            source: "Claude Code CLI",
          }),
        },
        // Present only so pi knows the OAuth-shaped check above is a
        // subscription. It never logs in: `claude auth login` does.
        oauth: {
          name: "Claude subscription (managed by Claude Code)",
          isSubscription: true,
          login: async () => {
            throw new Error(LOGIN_HINT);
          },
          refresh: async (credential) => credential,
          toAuth: async () => ({ apiKey: "unused" }),
        },
      },
      getModels: () => models,
      // pi 1.x refreshes dynamic lists; `PI_CLAUDE_CLI_MODELS=builtin`
      // keeps the built-in catalogue above.
      ...(accountModelsEnabled()
        ? {
            refreshModels: async (context) => {
              const refreshed = (await refreshModels(context)).map(piModel);
              if (context.signal.aborted) return;
              await context.publish({
                update: () => {
                  models = refreshed;
                },
              });
            },
          }
        : {}),
      // Only this provider's own api reaches here, whose options are pi's
      // stream options; pi's composer serves `stream` with `streamSimple`
      // for extension providers in the same way.
      stream: (model, context, options) =>
        streamSimple(model, context, options as Parameters<StartEpisode>[3] | undefined),
      streamSimple,
    };
    pi.registerProvider(nativeProvider);
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
