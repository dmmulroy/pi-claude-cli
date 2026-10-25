#!/usr/bin/env node
/**
 * Deterministic Claude Code CLI stub for pi-claude-cli scenarios and e2e.
 * Speaks enough of the stream-json protocol to drive every provider path
 * without credentials or a model call:
 *
 *   claude --version            -> version string
 *   claude auth status          -> JSON auth blob
 *   claude -p ... stream-json   -> a long-lived process, like the real CLI:
 *     - asks the in-band MCP server (`"type": "sdk"`) for its tools at start
 *     - answers each user message, then waits for the next one
 *     - exits when stdin closes
 *
 * The last user text picks the behaviour by keyword:
 *   (default)       streams "PORT-OK" and ends the turn
 *   tool:<name>     streams a tool_use for pi's tool <name>, asks permission,
 *                   calls it through MCP, and after pi's answer streams
 *                   "TOOL-DONE <result text>" and ends the turn
 *   tools:<a>,<b>   the same with several tool_use blocks in one message and
 *                   every call open at once; results are joined with "|"
 *   think           streams a signed thinking block ("STUB-THOUGHT",
 *                   signature "STUB-SIGNATURE"), then "PORT-OK"
 *   hang            starts a message and never finishes it
 *   chatter         stays silent on the model stream for 600 ms while
 *                   pinging the in-band MCP server every 100 ms, then
 *                   answers "PORT-OK"
 *   die             starts a message, writes to stderr, exits with code 3
 *   failturn        ends the turn with an error result
 *   refuse          the model refuses: stop_reason "refusal", explained as
 *                   "STUB-REFUSAL"
 *   mismatch        streams "PORT-OK" but records "PORT-KO" for it in the
 *                   CLI's own `assistant` envelope
 *   overage         combined with any of the above: every API call's
 *                   rate_limit_event says it was charged to usage credits
 *
 * Like the real CLI (2.1.299), every API message has an id, every content
 * block is recorded in an `assistant` envelope before its
 * content_block_stop, and every API call ends with a `rate_limit_event`
 * after its message_stop.
 *
 * Environment:
 *   CLAUDE_STUB_ARGV_FILE   append this process's argv as a JSON line
 *   CLAUDE_STUB_ENV_FILE    write what this process sees of the environment
 *                           the provider controls
 *   CLAUDE_STUB_TOOLS_FILE  append the tool names the MCP server listed
 *   CLAUDE_STUB_PID_FILE    write this process's pid once a turn starts
 *   CLAUDE_STUB_MODELS      JSON for `models` in the `initialize` response
 *   CLAUDE_STUB_FRAMES_FILE append each user and assistant message read from
 *                           stdin, with whether it was held
 *   CLAUDE_STUB_QUERY_HELD=1  answer a held user message (`shouldQuery:
 *                           false`) with a model turn, as a CLI that does
 *                           not know the field would
 *   CLAUDE_STUB_REFUSE_CONTROL=1  refuse thinking control requests
 *   CLAUDE_STUB_IGNORE_TOOLS_CHANGED=1  acknowledge a tools/list_changed
 *                           notification without listing the tools again,
 *                           as Claude Code 2.1.263 does
 */
const fs = require("node:fs");

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code stub)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, method: "stub" }));
  process.exit(0);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (process.env.CLAUDE_STUB_ARGV_FILE) {
  fs.appendFileSync(
    process.env.CLAUDE_STUB_ARGV_FILE,
    JSON.stringify(args) + "\n",
  );
}
if (process.env.CLAUDE_STUB_ENV_FILE) {
  fs.writeFileSync(
    process.env.CLAUDE_STUB_ENV_FILE,
    JSON.stringify({
      anthropic: Object.keys(process.env).filter((key) =>
        key.startsWith("ANTHROPIC_"),
      ),
      mcpToolTimeout: process.env.MCP_TOOL_TIMEOUT ?? null,
      disableAutoCompact: process.env.DISABLE_AUTO_COMPACT ?? null,
      disableCompact: process.env.DISABLE_COMPACT ?? null,
      maxRetries: process.env.CLAUDE_CODE_MAX_RETRIES ?? null,
      retryWatchdog: process.env.CLAUDE_CODE_RETRY_WATCHDOG ?? null,
      disableNonessentialTraffic:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
      disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
      secureStorageDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,
      providerSwitches: Object.keys(process.env).filter((key) =>
        key.startsWith("CLAUDE_CODE_USE_"),
      ),
      extraBody: process.env.CLAUDE_CODE_EXTRA_BODY ?? null,
      totalTokensReminder:
        process.env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER ?? null,
    }),
  );
}

// ---- in-band MCP client ------------------------------------------------------

const sdkServer = (() => {
  const index = args.indexOf("--mcp-config");
  if (index === -1) return undefined;
  try {
    const servers = JSON.parse(args[index + 1]).mcpServers ?? {};
    return Object.keys(servers).find((name) => servers[name].type === "sdk");
  } catch {
    return undefined;
  }
})();

let controlSeq = 0;
let rpcSeq = 0;
/** Our control requests awaiting the provider's control_response. */
const controlWaiters = new Map();

/** Send one MCP message to the in-band server; resolves with its response. */
const mcp = (method, params, notification = false) =>
  new Promise((resolve) => {
    const requestId = `stub-${++controlSeq}`;
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    if (!notification) message.id = rpcSeq++;
    controlWaiters.set(requestId, (response) =>
      resolve({ rpcId: message.id, response: response?.mcp_response }),
    );
    emit({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "mcp_message", server_name: sdkServer, message },
    });
  });

const askPermission = (toolName, toolUseId, input) =>
  new Promise((resolve) => {
    const requestId = `stub-${++controlSeq}`;
    controlWaiters.set(requestId, resolve);
    emit({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        input,
        tool_use_id: toolUseId,
      },
    });
  });

/** Ask the in-band server for its tools, as at start and after a change. */
const listTools = async () => {
  const listed = await mcp("tools/list");
  if (process.env.CLAUDE_STUB_TOOLS_FILE) {
    fs.appendFileSync(
      process.env.CLAUDE_STUB_TOOLS_FILE,
      JSON.stringify(
        (listed.response?.result?.tools ?? []).map((tool) => tool.name),
      ) + "\n",
    );
  }
};

/** MCP startup; like the real CLI, no turn starts before its tools are listed. */
let mcpReady = Promise.resolve();
if (sdkServer) {
  mcpReady = (async () => {
    await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-stub", version: "9.9.9" },
    });
    await mcp("notifications/initialized", undefined, true);
    await listTools();
  })();
}

// ---- turns -------------------------------------------------------------------

const streamEvent = (event) => emit({ type: "stream_event", event });

let messageSeq = 0;
/** The id of the API message being streamed. */
let messageId;
/** The current turn's keywords that change what is streamed or reported. */
let turnFlags = { overage: false, mismatch: false };

const messageStart = () => {
  messageId = `msg_stub_${process.pid}_${++messageSeq}`;
  streamEvent({
    type: "message_start",
    message: {
      id: messageId,
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        cache_creation_input_tokens: 7,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 7,
        },
      },
    },
  });
};

/** The CLI's own record of a finished block, written before its stop. */
const recordBlock = (block) =>
  emit({
    type: "assistant",
    message: {
      id: messageId,
      role: "assistant",
      model: "stub",
      content: [block],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: "stub-session",
  });

const messageEnd = (stopReason, stopDetails = null) => {
  streamEvent({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_details: stopDetails },
    usage: { output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
  });
  streamEvent({ type: "message_stop" });
  emit({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1792971000,
      rateLimitType: "five_hour",
      overageStatus: turnFlags.overage ? "allowed" : "rejected",
      isUsingOverage: turnFlags.overage,
    },
    uuid: "stub-rate-limit",
    session_id: "stub-session",
  });
};

const textBlock = (index, text) => {
  streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
  streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
  recordBlock({
    type: "text",
    text: turnFlags.mismatch ? text.replace("OK", "KO") : text,
  });
  streamEvent({ type: "content_block_stop", index });
};

/** One assistant cycle: message_start … message_stop, streaming `text`. */
const cycle = (text) => {
  messageStart();
  textBlock(0, text);
  messageEnd("end_turn");
};

const success = () =>
  emit({ type: "result", subtype: "success", is_error: false });

let turnActive = false;
let toolSeq = 0;
/** Rejects the in-flight tool turn when the provider interrupts it. */
let interruptTurn;

const endInterruptedTurn = () => {
  turnActive = false;
  emit({ type: "result", subtype: "error_during_execution", is_error: true });
};

/** One assistant message asking for each named pi tool, then their calls. */
const toolTurn = async (piToolNames) => {
  const input = { path: "stub.txt" };
  const uses = piToolNames.map((piToolName, index) => ({
    index,
    piToolName,
    toolUseId: `toolu_stub_${process.pid}_${++toolSeq}`,
    name: `mcp__${sdkServer}__${piToolName}`,
  }));
  messageStart();
  for (const use of uses) {
    streamEvent({
      type: "content_block_start",
      index: use.index,
      content_block: {
        type: "tool_use",
        id: use.toolUseId,
        name: use.name,
        input: {},
      },
    });
    streamEvent({
      type: "content_block_delta",
      index: use.index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    recordBlock({ type: "tool_use", id: use.toolUseId, name: use.name, input });
    streamEvent({ type: "content_block_stop", index: use.index });
  }

  const interrupted = new Promise((_, reject) => (interruptTurn = reject));
  const permissions = Promise.all(
    uses.map((use) => askPermission(use.name, use.toolUseId, input)),
  );
  messageEnd("tool_use");
  const decisions = await Promise.race([permissions, interrupted]);
  if (decisions.some((decision) => decision?.behavior !== "allow")) {
    // Denied: the real CLI feeds the model the denial; the provider is
    // expected to interrupt the turn instead of letting it continue.
    await interrupted;
    return;
  }
  // Every call is open at once, the hardest case for matching results.
  const calls = Promise.all(
    uses.map((use) =>
      mcp("tools/call", {
        name: use.piToolName,
        arguments: input,
        _meta: { "claudecode/toolUseId": use.toolUseId, progressToken: rpcSeq },
      }),
    ),
  );
  const answers = await Promise.race([calls, interrupted]);
  const text = answers
    .map((answer) =>
      (answer.response?.result?.content ?? [])
        .map((block) => block.text ?? "")
        .join(""),
    )
    .join("|");
  emit({ type: "user", message: { role: "user", content: [] } });
  cycle(`TOOL-DONE ${text}`);
  turnActive = false;
  success();
};

const startTurn = (text) => {
  turnActive = true;
  if (process.env.CLAUDE_STUB_PID_FILE)
    fs.writeFileSync(process.env.CLAUDE_STUB_PID_FILE, String(process.pid));
  emit({ type: "system", subtype: "init", session_id: "stub-session" });
  turnFlags = {
    overage: text.includes("overage"),
    mismatch: text.includes("mismatch"),
  };
  const tool = /tools?:([A-Za-z0-9_,-]+)/.exec(text);
  if (tool) {
    toolTurn(tool[1].split(",")).catch(endInterruptedTurn);
    return;
  }
  if (text.includes("think")) {
    messageStart();
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "STUB-THOUGHT" },
    });
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "STUB-SIGNATURE" },
    });
    recordBlock({
      type: "thinking",
      thinking: "STUB-THOUGHT",
      signature: "STUB-SIGNATURE",
    });
    streamEvent({ type: "content_block_stop", index: 0 });
    textBlock(1, "PORT-OK");
    messageEnd("end_turn");
    turnActive = false;
    success();
    return;
  }
  if (text.includes("chatter")) {
    // Alive, but with nothing for pi's stream: only control traffic.
    let pings = 0;
    const ping = () => {
      mcp("ping");
      if (++pings < 6) return setTimeout(ping, 100);
      cycle("PORT-OK");
      turnActive = false;
      success();
    };
    setTimeout(ping, 100);
    return;
  }
  if (text.includes("hang")) {
    messageStart();
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "PARTIAL" },
    });
    interruptTurn = () => endInterruptedTurn();
    return;
  }
  if (text.includes("die")) {
    messageStart();
    process.stderr.write("stub: fatal: simulated crash\n");
    setTimeout(() => process.exit(3), 20);
    return;
  }
  if (text.includes("refuse")) {
    messageStart();
    messageEnd("refusal", {
      type: "refusal",
      category: "stub",
      explanation: "STUB-REFUSAL",
    });
    turnActive = false;
    success();
    return;
  }
  if (text.includes("failturn")) {
    turnActive = false;
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "stub: the turn failed",
    });
    return;
  }
  cycle("PORT-OK");
  turnActive = false;
  success();
};

/** The text of a user message: the last text block names the behaviour. */
const userText = (message) => {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((block) => block.type === "text")
    .map((block) => block.text);
  return texts[texts.length - 1] ?? "";
};

const handleLine = (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_response") {
    const waiter = controlWaiters.get(msg.response?.request_id);
    controlWaiters.delete(msg.response?.request_id);
    if (waiter) waiter(msg.response?.response);
    return;
  }
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "interrupt") {
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id },
      });
      if (turnActive && interruptTurn) {
        const interrupt = interruptTurn;
        interruptTurn = undefined;
        interrupt(new Error("interrupted"));
      }
      return;
    }
    if (msg.request?.subtype === "initialize") {
      // The handshake: what the account offers, as Claude Code reports it.
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            models: process.env.CLAUDE_STUB_MODELS
              ? JSON.parse(process.env.CLAUDE_STUB_MODELS)
              : [
                  {
                    value: "default",
                    resolvedModel: "claude-sonnet-5",
                    displayName: "Default (recommended)",
                  },
                  {
                    value: "haiku",
                    resolvedModel: "claude-haiku-4-5-20251001",
                    displayName: "Haiku",
                  },
                ],
          },
        },
      });
      return;
    }
    if (msg.request?.subtype === "mcp_message") {
      // A notification from the in-band server: acknowledged, then acted on.
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id },
      });
      if (
        msg.request.message?.method === "notifications/tools/list_changed" &&
        process.env.CLAUDE_STUB_IGNORE_TOOLS_CHANGED !== "1"
      )
        listTools();
      return;
    }
    // Thinking changes on a live process: acknowledge, as the CLI does.
    emit({
      type: "control_response",
      response:
        process.env.CLAUDE_STUB_REFUSE_CONTROL === "1"
          ? {
              subtype: "error",
              request_id: msg.request_id,
              error: "stub refuses control requests",
            }
          : { subtype: "success", request_id: msg.request_id },
    });
    return;
  }
  if (msg.type === "user" || msg.type === "assistant") {
    if (process.env.CLAUDE_STUB_FRAMES_FILE)
      fs.appendFileSync(
        process.env.CLAUDE_STUB_FRAMES_FILE,
        JSON.stringify({
          type: msg.type,
          held: msg.shouldQuery === false,
          model: msg.message?.model ?? null,
          content: msg.message?.content,
        }) + "\n",
      );
  }
  // A replayed assistant message is appended to the conversation; no answer.
  if (msg.type === "assistant") return;
  if (
    msg.type === "user" &&
    msg.shouldQuery === false &&
    process.env.CLAUDE_STUB_QUERY_HELD !== "1"
  ) {
    // Held: added to the conversation without a model call, then confirmed
    // with an empty result, as Claude Code 2.1.292 does.
    mcpReady.then(() => {
      emit({ type: "system", subtype: "init", session_id: "stub-session" });
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
      });
    });
    return;
  }
  if (msg.type === "user") mcpReady.then(() => startTurn(userText(msg)));
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handleLine(line);
  }
});
// Like the real CLI in print mode: closing stdin ends the process.
// Like the real CLI, a closed stdin does not stop a turn in progress: the
// process exits once it is idle.
process.stdin.on("end", () => {
  const exitWhenIdle = () =>
    turnActive ? setTimeout(exitWhenIdle, 50) : process.exit(0);
  exitWhenIdle();
});
