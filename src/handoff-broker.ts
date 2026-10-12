/**
 * Handoff broker: the pi side of proxied tool calls.
 *
 * Every tool the model calls is one of pi's. The CLI's permission request is
 * ALLOWED and the CLI calls `tools/call` on the schema-only MCP server
 * (`mcp-schema-server.cjs`), which forwards the call here over a local socket
 * and blocks until pi has executed the tool. The CLI process never exits
 * mid-turn, so its cached prefix stays intact and pi's history does not have
 * to be imported again after every tool call.
 *
 * Wire (NDJSON, one request per connection):
 *   server → broker  {"type":"call","session":<cliSessionId>,
 *                     "toolUseId":…,"name":…,"arguments":{…}}
 *   broker → server  {"type":"result","content":[…],"isError":bool}
 *
 * Routing is by CLI session id — the config file each CLI process is spawned
 * with names its own session — so concurrent sessions in one pi process
 * never see each other's calls. A call with no registered target is answered
 * with an error immediately: the CLI must never hang on a tool pi will not
 * execute.
 *
 * Access control. Anything that can reach the socket can ask pi to run a tool,
 * so the socket is not a public surface:
 *
 *   - it lives in this process's private `0700` runtime directory under a
 *     random name (src/runtime-dir.ts), and is chmodded `0600` after bind, so
 *     no other local user can open it;
 *   - every request must carry this process's `secret`, compared in constant
 *     time. The secret is handed to the schema server as a FILE PATH, never on
 *     its command line: argv is world-readable through `ps` and `/proc`, which
 *     would hand the secret to exactly the user the socket mode keeps out.
 *
 * Windows has no mode bits for a named pipe and Node exposes no ACL, so there
 * the random pipe name and the secret are the whole defence. That is weaker
 * than the unix path and is the reason the secret check exists at all rather
 * than relying on file permissions alone.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";

/** One MCP `tools/call` waiting for pi's result. */
export interface HandoffCall {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Answer the CLI. Safe to call once; later calls are ignored. */
  respond(result: HandoffResult): void;
}

/** MCP tool result shape the schema server relays verbatim. */
export interface HandoffResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface HandoffTarget {
  onHandoffCall(call: HandoffCall): void;
}

const targets = new Map<string, HandoffTarget>();

export function registerHandoffTarget(
  cliSessionId: string,
  target: HandoffTarget,
): void {
  targets.set(cliSessionId, target);
}

export function unregisterHandoffTarget(
  cliSessionId: string,
  target?: HandoffTarget,
): void {
  if (target && targets.get(cliSessionId) !== target) return;
  targets.delete(cliSessionId);
}

/** Text result helper for error answers. */
export function errorResult(message: string): HandoffResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const NO_TARGET_MESSAGE =
  "pi is not attached to this Claude session; the tool was not executed.";

export const UNAUTHORIZED_MESSAGE =
  "unauthorized handoff request: bad or missing secret";

/**
 * The shared secret every request must carry, minted once per pi process.
 * 32 bytes: it only has to survive the lifetime of the process, but it is
 * cheap to make guessing hopeless.
 */
let secret: string | undefined;

export function handoffSecret(): string {
  if (!secret) secret = randomBytes(32).toString("hex");
  return secret;
}

let secretPath: string | undefined;

/**
 * Stage the secret in an owner-only file and return its path, for handing to
 * the schema server. Written once; the runtime directory sweep removes it.
 */
export function handoffSecretFile(): string {
  if (!secretPath) {
    const path = runtimeFile("handoff.secret");
    writeFileSync(path, handoffSecret(), { mode: RUNTIME_FILE_MODE });
    secretPath = path;
  }
  return secretPath;
}

/** Constant-time compare; length-safe (`timingSafeEqual` throws on a mismatch). */
function secretMatches(offered: unknown): boolean {
  if (typeof offered !== "string") return false;
  const expected = Buffer.from(handoffSecret(), "utf8");
  const actual = Buffer.from(offered, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Route one incoming call. Exported for tests and for the socket server
 * below; `respond` is wired by the caller.
 */
export function dispatchHandoffCall(
  session: string,
  call: HandoffCall,
): boolean {
  const target = targets.get(session);
  if (!target) {
    call.respond(errorResult(NO_TARGET_MESSAGE));
    return false;
  }
  try {
    target.onHandoffCall(call);
  } catch (err) {
    call.respond(
      errorResult(
        `pi failed to accept the tool call: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return false;
  }
  return true;
}

let server: Server | undefined;
let socketPath: string | undefined;
let starting: Promise<string> | undefined;

/**
 * Per-process socket path: a unix socket inside the private runtime directory,
 * or a named pipe on Windows. The Windows name gets random bytes because a
 * pipe cannot live in a directory we control the mode of — a pid-derived name
 * would be trivially guessable by any local process.
 */
export function defaultSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-claude-handoff-${process.pid}-${randomBytes(12).toString("hex")}`;
  }
  return runtimeFile("handoff.sock");
}

/**
 * A request line this large is not a tool call, it is a peer filling our heap.
 * Real arguments are bounded by what fits in the model's context.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * A connected peer that sends no complete request in this long is dropped.
 *
 * It bounds the REQUEST, never the call: once a request line has arrived the
 * timer stops, because what follows is pi running the tool, and that takes as
 * long as the tool takes. Under pi context every tool comes through here,
 * `bash` included, and a build or test suite runs for minutes. Before this
 * was scoped, any tool slower than a minute lost its connection and the model
 * read "pi closed the connection without a result" while pi recorded the real
 * output, so the CLI's history and pi's disagreed about what the tool said.
 */
export const HANDOFF_REQUEST_TIMEOUT_MS = 60_000;

interface IncomingCall {
  session: string;
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
  secret: unknown;
}

function parseIncoming(line: string): IncomingCall | undefined {
  try {
    const msg = JSON.parse(line);
    if (!msg || msg.type !== "call") return undefined;
    if (typeof msg.session !== "string" || typeof msg.name !== "string")
      return undefined;
    const args =
      msg.arguments &&
      typeof msg.arguments === "object" &&
      !Array.isArray(msg.arguments)
        ? (msg.arguments as Record<string, unknown>)
        : {};
    return {
      session: msg.session,
      toolUseId: typeof msg.toolUseId === "string" ? msg.toolUseId : "",
      name: msg.name,
      arguments: args,
      secret: msg.secret,
    };
  } catch {
    return undefined;
  }
}

function handleConnection(socket: Socket): void {
  let buffer = "";
  let handled = false;
  let requested = false;
  const timer = setTimeout(() => {
    if (!handled) socket.destroy();
  }, HANDOFF_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  const finish = (result: HandoffResult) => {
    if (handled) return;
    handled = true;
    clearTimeout(timer);
    try {
      socket.end(JSON.stringify({ type: "result", ...result }) + "\n");
    } catch {
      /* server went away — nothing to answer */
    }
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (handled || requested) return;
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl === -1) {
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(timer);
        socket.destroy();
      }
      return;
    }
    const line = buffer.slice(0, nl);
    buffer = "";
    // One request per connection. From here on the peer is waiting for pi,
    // not idle, so the request timer no longer applies.
    requested = true;
    clearTimeout(timer);
    const incoming = parseIncoming(line);
    if (!incoming) {
      finish(errorResult("malformed handoff request"));
      return;
    }
    // Authenticate before the session id reaches any routing table: an
    // unauthenticated peer must not learn whether a session exists, and must
    // never reach a target's `onHandoffCall`.
    if (!secretMatches(incoming.secret)) {
      finish(errorResult(UNAUTHORIZED_MESSAGE));
      return;
    }
    dispatchHandoffCall(incoming.session, {
      toolUseId: incoming.toolUseId,
      name: incoming.name,
      arguments: incoming.arguments,
      respond: finish,
    });
  });
  socket.on("error", () => {
    handled = true;
    clearTimeout(timer);
  });
  socket.on("close", () => clearTimeout(timer));
}

/**
 * Start the socket server once. Resolves to the socket path the MCP config
 * must carry. Rejects if the socket cannot be bound — callers fall back to
 * the interrupt-and-resume handoff.
 */
export function startHandoffBroker(
  path = defaultSocketPath(),
): Promise<string> {
  if (socketPath) return Promise.resolve(socketPath);
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    if (process.platform !== "win32") {
      try {
        unlinkSync(path);
      } catch {
        /* nothing stale to remove */
      }
    }
    const srv = createServer(handleConnection);
    srv.on("error", (err) => {
      starting = undefined;
      reject(err);
    });
    srv.listen(path, () => {
      // Bind honours the umask, so the socket lands 0755 on a stock Linux box
      // even inside a 0700 directory. Narrow it explicitly — the directory
      // mode is the real gate, this is the second lock on the same door.
      if (process.platform !== "win32") {
        try {
          chmodSync(path, RUNTIME_FILE_MODE);
        } catch {
          /* a platform that does not chmod sockets; the 0700 dir still holds */
        }
      }
      server = srv;
      socketPath = path;
      // The broker must never hold pi's process open on its own.
      srv.unref();
      resolve(path);
    });
  });
  return starting;
}

/** Current socket path, if the broker is up. */
export function handoffSocketPath(): string | undefined {
  return socketPath;
}

/** Stop the server and remove the socket file. Registered on process exit. */
export function stopHandoffBroker(): void {
  const path = socketPath;
  const srv = server;
  server = undefined;
  socketPath = undefined;
  starting = undefined;
  secret = undefined;
  secretPath = undefined;
  targets.clear();
  try {
    srv?.close();
  } catch {
    /* already closed */
  }
  if (path && process.platform !== "win32") {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** Test seam. */
export function resetHandoffBrokerForTests(): void {
  stopHandoffBroker();
}
