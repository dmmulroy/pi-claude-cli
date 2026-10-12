// Wire protocol types for Claude CLI stream-json NDJSON communication

// NDJSON message types from Claude CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
}

/**
 * Per-model spend for the episode, keyed by model id.
 *
 * This is the ONLY place the CLI accounts for work done outside the main
 * agent's own transcript: sub-agents (which run inside the CLI and never
 * appear in the parent stream) and helper models such as the haiku
 * auto-titler. `result.usage` covers the main agent alone.
 *
 * Verified 2026-08-27 on a captured episode with one synchronous sub-agent:
 * main agent 74,562 cache-read / 26,808 cache-write, sub-agent 28,079 /
 * 30,112, and `modelUsage` reported exactly the two summed — 102,641 /
 * 56,920.
 */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
  session_id?: string;
  /** Cumulative usage for the MAIN agent across every cycle of the episode. */
  usage?: ClaudeUsage;
  /** Per-model spend, including sub-agents and helper models. */
  modelUsage?: Record<string, ClaudeModelUsage>;
  num_turns?: number;
  total_cost_usd?: number;
}

/**
 * Envelopes the CLI emits that carry nothing pi's stream needs: complete
 * assistant messages (duplicating the stream events), tool results it feeds
 * itself, `system` notices, and account rate-limit state. They still reset
 * the inactivity timer.
 */
export interface ClaudeIgnoredEnvelope {
  type: "assistant" | "user" | "system" | "rate_limit_event";
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    /** Claude Code 2.x: the assistant tool_use block this permission is for. */
    tool_use_id?: string;
  };
}

/**
 * The CLI's answer to a control request WE sent (an interrupt, a thinking
 * change). Claude Code 2.x nests `request_id` inside `response`.
 */
export interface ClaudeControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    error?: string;
    response?: unknown;
  };
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeControlRequest
  | ClaudeControlResponse
  | ClaudeIgnoredEnvelope;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index: number; // Claude's content_block index (resets each cycle)
  cycle: number; // Which API call of the episode this block belongs to
  /** Position in output.content, or -1 while not materialized. */
  contentIndex: number;
  /** signature_delta received before any plaintext (encrypted thinking). */
  pendingSignature?: string;
}
