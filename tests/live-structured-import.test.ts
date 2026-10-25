/**
 * Live: does a fresh CLI process given pi's history as messages (the
 * structured import) send the model what the warm process would have sent,
 * signed thinking included? The prompt cache it reuses is reported, not
 * asserted: on Claude Code 2.1.299 it is none (see the last assertion).
 *
 * One conversation is held in a warm process: a tool call with thinking, its
 * result, a follow-up. Then the last call is made again, from the same pi
 * history, in a fresh process: once with the structured import and once
 * with the text import as the baseline. A `claude` wrapper points the CLI at
 * a local proxy that forwards to api.anthropic.com and records, per request,
 * the shape of the messages (roles, block types, whether thinking carries a
 * signature, a hash of the body) and the usage the API reports. It never
 * records headers.
 *
 * Runs only with PI_OWNED_LIVE=1 and an authenticated Claude Code.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  type Api,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";
import type { EpisodeOptions } from "../src/episode";
import { startProviderRuntime } from "../src/provider-runtime";
import { readSignedThinking } from "../src/signed-thinking";

interface WireRequest {
  /** One string per message: role and block types, `thinking+sig` when signed. */
  shape: string[];
  /** Hash of each message, to find where two requests part. */
  messageHashes: string[];
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  status?: number;
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

function describeMessages(messages: any[]): Pick<WireRequest, "shape" | "messageHashes"> {
  return {
    shape: messages.map(
      (m) =>
        `${m.role}[${(typeof m.content === "string" ? [{ type: "text" }] : m.content)
          .map((b: any) => (b.type === "thinking" && b.signature ? "thinking+sig" : b.type))
          .join(",")}]`,
    ),
    messageHashes: messages.map(hash),
  };
}

/** The usage of `message_start` in a streamed (possibly compressed) response. */
function usageOf(body: Buffer, encoding: string | undefined) {
  const text = (
    encoding === "gzip"
      ? zlib.gunzipSync(body)
      : encoding === "br"
        ? zlib.brotliDecompressSync(body)
        : encoding === "deflate"
          ? zlib.inflateSync(body)
          : body
  ).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5));
      if (event.type === "message_start") return event.message?.usage;
    } catch {
      /* not an event */
    }
  }
  return undefined;
}

async function startProxy() {
  const requests: WireRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let record: WireRequest | undefined;
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (
          Array.isArray(parsed?.messages) &&
          Array.isArray(parsed?.tools) &&
          parsed.tools.length > 0
        ) {
          record = describeMessages(parsed.messages);
          requests.push(record);
          // Debugging aid: full bodies (prompt text, no headers) to a directory.
          if (process.env.PCC_DUMP_DIR)
            writeFileSync(
              join(process.env.PCC_DUMP_DIR, `request-${requests.length}.json`),
              JSON.stringify(parsed, null, 1),
            );
        }
      } catch {
        /* not JSON: forward untouched */
      }
      const upstream = https.request(
        {
          host: "api.anthropic.com",
          port: 443,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: "api.anthropic.com" },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          const response: Buffer[] = [];
          up.on("data", (c) => response.push(c));
          up.on("end", () => {
            if (!record) return;
            record.status = up.statusCode;
            try {
              record.usage = usageOf(Buffer.concat(response), up.headers["content-encoding"]);
            } catch {
              /* undecodable: usage stays unknown */
            }
          });
          up.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        console.error(`proxy: ${req.method} ${req.url}: ${error.message}`);
        res.destroy();
      });
      upstream.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A `claude` first on PATH that runs the real one against the proxy. */
function wrapClaude(dir: string, proxyUrl: string): string {
  const real = execSync("command -v claude", { encoding: "utf8" }).trim();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nANTHROPIC_BASE_URL="${proxyUrl}" HOME="${userInfo().homedir}" exec "${real}" "$@"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

const haiku = getBuiltinModels("anthropic").find((m) => m.id === "claude-haiku-4-5")!;
const model: Model<Api> = {
  ...haiku,
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
};
const tools: Tool[] = [
  {
    name: "read",
    description: "Read a file and return its contents.",
    parameters: Type.Object({ path: Type.String() }),
  },
];
// Long enough to be cached: the API caches nothing under ~2k tokens on Haiku.
const SYSTEM_PROMPT = `You are a careful assistant in a test harness. ${"Follow instructions exactly and keep answers short. ".repeat(400)}`;

/** One provider runtime with the given import mode; calls like pi does. */
function session(importMode: "structured" | "flat", keepalive: boolean) {
  process.env.PI_CLAUDE_CLI_IMPORT = importMode;
  process.env.PI_CLAUDE_CLI_KEEPALIVE_MS = keepalive ? "600000" : "0";
  const runtime = startProviderRuntime();
  const call = async (messages: Message[], options: EpisodeOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    runtime.startEpisode(
      stream,
      model,
      { systemPrompt: SYSTEM_PROMPT, tools, messages },
      { sessionId: `live-import-${importMode}`, reasoning: "low", ...options },
    );
    for await (const _ of stream) {
      /* drain */
    }
    return stream.result();
  };
  return { call, dispose: () => runtime.dispose() };
}

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});

describe.skipIf(process.env.PI_OWNED_LIVE !== "1")("live: structured history import", () => {
  it("a fresh process sends the warm request's messages again, signatures included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcc-live-import-"));
    const proxy = await startProxy();
    const path = process.env.PATH;
    process.env.PATH = `${wrapClaude(dir, proxy.url)}:${path}`;
    process.env.XDG_STATE_HOME = join(dir, "state");
    try {
      // ---- the warm conversation, on one process ----
      const warm = session("structured", true);
      const history: Message[] = [
        user(
          'Think briefly, then call the read tool once with path "a.txt". After its result, reply with one short sentence about it.',
        ),
      ];
      const asked = await warm.call(history);
      expect(asked.stopReason, asked.errorMessage).toBe("toolUse");
      history.push(asked);
      const signed = readSignedThinking(asked);
      const call = asked.content.find((b) => b.type === "toolCall")!;
      history.push({
        role: "toolResult",
        toolCallId: call.type === "toolCall" ? call.id : "",
        toolName: "read",
        content: [{ type: "text", text: "a.txt: the launch is on Tuesday." }],
        isError: false,
        timestamp: Date.now(),
      });
      const summary = await warm.call(history);
      expect(summary.stopReason, summary.errorMessage).toBe("stop");
      history.push(summary, user("Now answer with the single word OK."));
      const warmMark = proxy.requests.length;
      const warmAnswer = await warm.call(history);
      expect(warmAnswer.stopReason, warmAnswer.errorMessage).toBe("stop");
      const warmRequest = proxy.requests[warmMark];
      await warm.dispose();

      // ---- the same last call, from the same history, in fresh processes ----
      const fresh = async (mode: "structured") => {
        const s = session(mode, false);
        const mark = proxy.requests.length;
        const answer = await s.call(history);
        await s.dispose();
        return { answer, request: proxy.requests[mark] };
      };
      const structured = await fresh("structured");

      const firstDifference = warmRequest.messageHashes.findIndex(
        (h, i) => structured.request.messageHashes[i] !== h,
      );
      const report = {
        signedBlocksStored: signed?.blocks.length ?? 0,
        warm: warmRequest,
        structured: {
          ...structured.request,
          stop: structured.answer.stopReason,
          error: structured.answer.errorMessage,
        },
        firstDifferingMessage: firstDifference,
        everyRequest: proxy.requests.map((r) => ({
          messages: r.shape.length,
          read: r.usage?.cache_read_input_tokens,
          write: r.usage?.cache_creation_input_tokens,
        })),
      };
      console.log(JSON.stringify(report, null, 1));

      expect(structured.answer.stopReason, structured.answer.errorMessage).toBe("stop");
      expect(signed?.blocks.length ?? 0).toBeGreaterThan(0);
      // The signed thinking went back to the API in the fresh process.
      expect(structured.request.shape[1]).toContain("thinking+sig");
      // Everything but plain text matches the warm request. Text differs in
      // count only: Claude Code adds its startup reminders to the first user
      // message it sends to the model, which in a fresh process is the last
      // one. That is also why the fresh request reuses none of the warm
      // prompt cache (measured on 2.1.299), whichever import is used.
      const structure = (shape: string[]) =>
        shape.map((entry) => entry.replace(/\btext,?|,text\b/g, ""));
      expect(structure(structured.request.shape)).toEqual(structure(warmRequest.shape));
    } finally {
      process.env.PATH = path;
      delete process.env.PI_CLAUDE_CLI_IMPORT;
      delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
      await proxy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
