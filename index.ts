/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers the `pi-claude-cli` provider, which serves pi model calls through
 * the Claude Code CLI subprocess (stream-json NDJSON) so they run on the
 * user's Claude subscription. pi owns the prompt, tools and conversation.
 */

import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import {
  writeSchemaFile,
  cleanupMcpConfigFiles,
  type McpToolDef,
} from "./src/mcp-config.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { cliThinkingLevelMap } from "./src/thinking-config.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import { piContext } from "./src/pi-context.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);
// Remove the schema/config temp files this process staged
process.on("exit", cleanupMcpConfigFiles);
// Close the handoff socket and remove its file
process.on("exit", stopHandoffBroker);
// Last: take the private runtime directory itself, socket and secret included.
process.on("exit", cleanupRuntimeDir);
// Parked CLI processes hold their stdin from us: ending pi ends them (the
// pipe closes and the CLI exits), but retire cleanly when we can.
process.on("beforeExit", () => {
  void retireAllCliProcesses();
});

const PROVIDER_ID = "pi-claude-cli";

/**
 * Stage the tool schemas this request advertises, for the CLI's schema-only
 * MCP server to read at spawn.
 *
 * The request, not pi's tool registry, is authoritative: inactive tools stay
 * inactive, and a tool-less call (title generation) advertises none. Called
 * on every request; a surface already staged costs one hash.
 *
 * A changed surface gets a different `version`, which retires the session's
 * parked process (its tool list is what it advertised at connect time); the
 * next call imports pi's history into a fresh one.
 *
 * @throws when the schema file cannot be written: without it the model would
 *   run with no tools and say so only by failing to call them
 */
function stageRequestToolSchemas(context: Parameters<typeof piContext>[0]): {
  schemaPath: string;
  version: number;
} {
  const toolDefs: McpToolDef[] = piContext(context).tools.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  const { schemaPath, version } = writeSchemaFile(toolDefs);
  return { schemaPath, version };
}

/**
 * The handoff socket the schema server calls back into. Started once, on the
 * first turn; a failure to bind logs once and leaves proxied handoffs off (the
 * provider then interrupts the turn at each tool call and reimports pi's
 * history afterwards).
 */
let handoffSocket: string | undefined;
let handoffSocketAttempted = false;
async function ensureHandoffSocket(): Promise<string | undefined> {
  if (handoffSocket || handoffSocketAttempted) return handoffSocket;
  handoffSocketAttempted = true;
  try {
    handoffSocket = await startHandoffBroker();
  } catch (err) {
    console.warn(
      "[pi-claude-cli] handoff socket unavailable, tool calls fall back to interrupt-and-reimport:",
      err,
    );
  }
  return handoffSocket;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

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
      // has, and each maps to the effort pi uses (resolveCliThinking reads
      // it).
      thinkingLevelMap: cliThinkingLevelMap(model),
    }));

    // A parked process is a cache of the history it acknowledged. Every event
    // that replaces or rewrites that history retires it; the next call
    // imports pi's current history into a fresh process.
    const retire = async () => {
      await retireAllCliProcesses();
    };
    pi.on("session_start", retire);
    pi.on("model_select", retire);
    pi.on("session_shutdown", retire);
    pi.on("session_tree", retire);
    pi.on("session_compact", retire);

    const streamFn = (
      model: Parameters<typeof streamViaCli>[0],
      context: Parameters<typeof streamViaCli>[1],
      options?: Parameters<typeof streamViaCli>[2],
    ) => {
      const schema = stageRequestToolSchemas(context);
      // The socket start is async; the provider awaits it inside its own
      // driver so streamSimple still returns the stream synchronously.
      return streamViaCli(model, context, {
        ...options,
        mcpConfig: { ...schema, handoffSocket: ensureHandoffSocket() },
      });
    };

    // pi.registerProvider() feeds pi's provider composer, but pi's default
    // stream fn (pi-agent-core setDefaultStreamFn) resolves model.api against
    // pi-ai's global api registry instead — print mode and nested agent loops
    // take that path and would throw "No API provider registered for api:
    // pi-claude-cli". Register the custom api id there too.
    registerApiProvider(
      { api: PROVIDER_ID as any, stream: streamFn, streamSimple: streamFn },
      PROVIDER_ID,
    );

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).
    (pi.on as any)("message_end", (event: any, ctx: any) => {
      return rewriteOverflowMessage(event?.message ?? {}, ctx?.model?.provider);
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: streamFn,
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
