/**
 * Staging of pi's tool schemas and the per-process `--mcp-config` files that
 * point the CLI at the schema-only MCP server (src/mcp-schema-server.cjs).
 *
 * Schema files are content-addressed: each distinct tool surface gets its own
 * file named by a hash of its JSON, and a file is never rewritten. A request
 * therefore always spawns against exactly the surface it asked for, even when
 * another request with a different surface (a tool-less title-generation
 * call, say) runs at the same moment. A shared path rewritten in place let
 * that second request clobber the first one's tools before its schema server
 * had read them (upstream issue #49). `version` identifies the surface, so a
 * parked CLI process spawned against a different one can be retired (its tool
 * list is what the CLI advertised at connect time).
 *
 * Config files are per CLI process: each carries the process's session id so
 * the schema server can route proxied `tools/call` requests back to the pi
 * call that owns it over the handoff socket (src/handoff-broker.ts).
 *
 * Every file here is staged in this process's private 0700 runtime directory
 * and written 0600. A session config names the handoff socket and the CLI
 * session id.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";

/** One of pi's tools, in the shape MCP `tools/list` returns. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Where a tool surface is staged, and whether this call staged it. */
export interface SchemaFileWrite {
  schemaPath: string;
  changed: boolean;
  /**
   * Identifies the tool surface: equal surfaces get equal versions, distinct
   * surfaces distinct ones. Numbered in first-seen order, starting at 1.
   */
  version: number;
}

/** Every tool surface staged so far, by content hash. Never rewritten. */
const stagedSchemas = new Map<
  string,
  { schemaPath: string; version: number }
>();
/** Per-session config files this process wrote, for exit cleanup. */
const sessionConfigPaths = new Map<string, string>();

/** Where this process stages one tool surface, named by its content hash. */
function schemaFilePath(contentHash: string): string {
  return runtimeFile(`mcp-schemas-${contentHash}.json`);
}

function sessionConfigFilePath(cliSessionId: string): string {
  // The session id reaches us from the CLI. Keep it out of the path so a
  // hostile value cannot traverse out of the runtime directory.
  return runtimeFile(`mcp-config-${safeFileSegment(cliSessionId)}.json`);
}

/** Reduce an id to characters that cannot escape or confuse a path. */
function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session";
}

/** Resolve the schema server .cjs (sibling of this module). */
function serverPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "mcp-schema-server.cjs");
}

/**
 * Stage the tool schemas. Safe to call on every request, including
 * concurrent requests with different tool surfaces: each surface is written
 * once to its own content-addressed file and never touched again.
 *
 * `changed` is true the first time this process sees a surface.
 */
export function writeSchemaFile(toolDefs: McpToolDef[]): SchemaFileWrite {
  const schemaJson = JSON.stringify(toolDefs);
  const contentHash = createHash("sha256")
    .update(schemaJson)
    .digest("hex")
    .slice(0, 32);
  const staged = stagedSchemas.get(contentHash);
  if (staged) return { ...staged, changed: false };
  const schemaPath = schemaFilePath(contentHash);
  writeFileSync(schemaPath, schemaJson, { mode: RUNTIME_FILE_MODE });
  const entry = { schemaPath, version: stagedSchemas.size + 1 };
  stagedSchemas.set(contentHash, entry);
  return { ...entry, changed: true };
}

/**
 * Write the `--mcp-config` file for ONE CLI session. The schema server gets
 * the handoff socket and the session id so its `tools/call` requests reach
 * the pi session that owns this CLI process. Written once per session id.
 *
 * `secretPath` points at the broker's shared secret. It is a path and not the
 * secret itself because these args become the schema server's argv, which
 * every local user can read with `ps`.
 */
export function writeSessionMcpConfig(
  cliSessionId: string,
  schemaPath: string,
  handoffSocketPath?: string,
  secretPath?: string,
): string {
  const existing = sessionConfigPaths.get(cliSessionId);
  if (existing) return existing;
  const configPath = sessionConfigFilePath(cliSessionId);
  const args = handoffSocketPath
    ? [serverPath(), schemaPath, handoffSocketPath, cliSessionId, secretPath]
    : [serverPath(), schemaPath];
  const config = {
    mcpServers: {
      "custom-tools": { command: "node", args: args.filter(Boolean) },
    },
  };
  writeFileSync(configPath, JSON.stringify(config), {
    mode: RUNTIME_FILE_MODE,
  });
  sessionConfigPaths.set(cliSessionId, configPath);
  return configPath;
}

/** Remove one session's config file (the session will not be spawned again). */
export function removeSessionMcpConfig(cliSessionId: string): void {
  const path = sessionConfigPaths.get(cliSessionId);
  if (!path) return;
  sessionConfigPaths.delete(cliSessionId);
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Remove every temp file. Registered on `process.on("exit")`, so it must stay
 * synchronous. A SIGKILLed process still leaks them, inside its private
 * runtime directory.
 */
export function cleanupMcpConfigFiles(): void {
  const paths = [
    ...[...stagedSchemas.values()].map((staged) => staged.schemaPath),
    ...sessionConfigPaths.values(),
  ];
  sessionConfigPaths.clear();
  stagedSchemas.clear();
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Never written, or already gone — ignore
    }
  }
}

/** Test seam: forget what this process has already written. */
export function resetMcpConfigCache(): void {
  stagedSchemas.clear();
  sessionConfigPaths.clear();
}
