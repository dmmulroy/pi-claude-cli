import type {
  ClaudeApiEvent,
  ClaudeAssistantBlock,
  ClaudeModelUsage,
  ClaudeRateLimitInfo,
  ClaudeResultMessage,
  ClaudeUsage,
} from "./cli-protocol.ts";
import { calculateCost } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  assistantContentFingerprint,
  type SignedThinking,
  writeSignedThinking,
} from "./signed-thinking.ts";
import { createToolNameMap, isHandoffClaudeTool, type ToolNameMap } from "./tool-mapping.ts";

/** The four token counters, accumulated across the cycles of an episode. */
interface UsageCounters {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** A wire usage object with absent and null counters dropped. */
function presentCounters(usage: ClaudeUsage): Partial<UsageCounters> {
  const counters: Partial<UsageCounters> = {};
  if (usage.input_tokens != null) counters.input_tokens = usage.input_tokens;
  if (usage.output_tokens != null) counters.output_tokens = usage.output_tokens;
  if (usage.cache_read_input_tokens != null)
    counters.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null)
    counters.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  return counters;
}

/** A text or thinking block being accumulated during streaming. */
interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  /** Claude's content_block index (resets each cycle). */
  index: number;
  /** Which API call of the episode this block belongs to. */
  cycle: number;
  /** Position in output.content, or -1 while not materialized. */
  contentIndex: number;
  /** signature_delta received before any plaintext (encrypted thinking). */
  pendingSignature?: string;
  /** The whole signature, for the raw block stored beside pi's content. */
  signature?: string;
  /** Text and tool call blocks of the message that precede this block. */
  at?: number;
}

/** Index given to a block once its `content_block_stop` has arrived. */
const STOPPED_BLOCK_INDEX = -1;

/** Extended tracking for tool_use content blocks during streaming. */
interface TrackedToolBlock {
  type: "tool_use";
  index: number;
  cycle: number;
  /** Position in output.content, or -1 when not materialized. */
  contentIndex: number;
  id: string;
  name: string; // Already mapped to pi name
  arguments: ToolCall["arguments"];
  partialJson: string;
}

/** Union of tracked block types for the blocks array. */
type TrackedBlock = TrackedContentBlock | TrackedToolBlock;

/**
 * The event bridge interface returned by createEventBridge.
 * handleEvent processes each Claude API streaming event and pushes
 * the appropriate pi events to the stream.
 * getOutput returns the accumulated AssistantMessage.
 */
export interface EventBridge {
  handleEvent(event: ClaudeApiEvent): void;
  /**
   * The CLI's own record of blocks of an API message (an `assistant`
   * envelope), kept to check the stream against (`streamMismatch`).
   */
  recordAssistantBlocks(messageId: string, content: ReadonlyArray<ClaudeAssistantBlock>): void;
  /**
   * How the current API message as streamed differs from the CLI's record
   * of it, or undefined when it does not (or there is no record). Asked at
   * `message_stop`, by which time the CLI has written its record of every
   * block. Text and pi's tool calls are compared; thinking is not.
   */
  streamMismatch(): string | undefined;
  /**
   * The subscription's latest limit status, kept as a diagnostic stamped
   * with when the CLI reported it.
   */
  recordRateLimit(info: ClaudeRateLimitInfo, reportedAtMillis: number): void;
  /** The CLI effort the response ran at; undefined when thinking is not set. */
  setProviderThinkingLevel(level: string | undefined): void;
  /**
   * The final `result` envelope: authoritative cumulative usage for the
   * whole episode, plus a safety net that appends the final answer text if
   * any stream pathology kept it out of the bridged content.
   */
  applyResult(result: ClaudeResultMessage): void;
  getOutput(): AssistantMessage;
}

/**
 * Tool arguments are a JSON object or they are nothing.
 *
 * `JSON.parse` happily returns null, arrays, numbers and strings for input
 * that is valid JSON but cannot be a tool's arguments. Passing any of those
 * to pi as arguments fails its schema check.
 */
function isArgumentObject(value: unknown): value is ToolCall["arguments"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `diagnostics` type of the entry that holds the latest limit status. */
export const RATE_LIMIT_DIAGNOSTIC = "pi-claude-cli.rate-limit";

/**
 * pi's stop reason for the API's, as pi's own Anthropic provider maps it. A
 * refusal and a safety stop are errors with a message; a reason this
 * provider does not know yet ends the turn normally, since the CLI already
 * accepted it.
 */
export function mapStopReason(
  reason: string,
  explanation?: string | null,
): { readonly stopReason: StopReason; readonly errorMessage?: string } {
  switch (reason) {
    case "tool_use":
      return { stopReason: "toolUse" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage:
          explanation !== undefined && explanation !== null && explanation.length > 0
            ? explanation
            : "The model refused to complete the request",
      };
    case "sensitive":
      return {
        stopReason: "error",
        errorMessage: "Provider stopped with: sensitive",
      };
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
    default:
      return { stopReason: "stop" };
  }
}

/** JSON text with object keys sorted, so equal values have equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Text with something besides whitespace in it. */
const hasVisibleText = (text: string): boolean => text.trim().length > 0;

/** The limit status as a diagnostic's details: only the fields it has. */
function rateLimitDetails(info: ClaudeRateLimitInfo): JsonObject {
  const details: JsonObject = {};
  for (const [key, value] of Object.entries(info))
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      details[key] = value;
  return details;
}

/**
 * Create an event bridge that translates Claude API streaming events
 * into pi's AssistantMessageEventStream events.
 *
 * The bridge maintains internal state to track content blocks and
 * accumulate the final AssistantMessage. It handles:
 * - text and thinking content blocks (start/delta/stop)
 * - tool_use blocks for pi's tools (toolcall_start/delta/end)
 * - message lifecycle (message_start for usage, message_delta for stop reason)
 */
export function createEventBridge(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  /** pi's tools for the request: maps aliased names back to pi's. */
  toolNames: ToolNameMap = createToolNameMap([]),
): EventBridge {
  // Tracked content blocks indexed by Claude's content_block index
  const blocks: TrackedBlock[] = [];

  // The accumulated output message
  const output: AssistantMessage = {
    role: "assistant" as const,
    content: [] as (TextContent | ThinkingContent | ToolCall)[],
    api: "pi-claude-cli",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  let started = false;

  /** The API message id of each cycle, from its `message_start`. */
  const cycleMessageIds = new Map<number, string>();
  /** The CLI's record of each API message's blocks, by message id. */
  const recordedBlocks = new Map<string, ClaudeAssistantBlock[]>();

  /**
   * The thinking blocks of the API message as it returned them, signatures
   * included, for a later process to be given back (`src/signed-thinking.ts`).
   * Kept for an episode of one API message only: blocks of several messages
   * merged into one pi message could not be replayed as one.
   */
  const signedBlocks: Array<SignedThinking["blocks"][number]> = [];
  const visibleBlockCount = (): number =>
    output.content.filter((block) => block.type !== "thinking").length;
  const storeSignedThinking = (): void =>
    writeSignedThinking(
      output,
      cycle === 0
        ? {
            model: model.id,
            fingerprint: assistantContentFingerprint(output.content),
            blocks: signedBlocks,
          }
        : undefined,
    );

  // An episode normally holds one API call ("cycle"), but nothing stops the
  // CLI from making another before the episode ends. SSE content_block
  // indexes reset every cycle, so blocks are matched per-cycle; usage is
  // summed across cycles (each message_delta carries that cycle's final
  // numbers).
  let cycle = -1;
  const cumulativeUsage: UsageCounters = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let cycleUsage: Partial<UsageCounters> = {};
  /**
   * The 1h-lifetime share of the cache write and the thinking share of the
   * output, summed over cycles like the counters above. Undefined until the
   * API reports them. `applyResult` leaves them alone: the result's totals
   * do not split either.
   */
  let bankedCacheWrite1h: number | undefined;
  let cycleCacheWrite1h: number | undefined;
  let bankedReasoning: number | undefined;
  let cycleReasoning: number | undefined;
  const plus = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  /**
   * Context size of the most recent cycle — what the model actually saw on
   * its last call, which is NOT the episode's summed usage.
   *
   * pi reads `usage.totalTokens` as the conversation's context size
   * (`calculateContextTokens` in pi's compaction module short-circuits on it)
   * and uses it for both the context gauge and the auto-compaction trigger.
   * Every cycle re-sends the same cached prefix, so summing cycles counts
   * that prefix once per cycle: a captured 3-cycle episode sums to 82,174
   * while the model's real context never exceeded 28,243. The host then
   * showed 41% of a 200k window instead of 14%, and a long enough turn
   * crossed pi's compaction threshold at a fraction of true occupancy.
   *
   * So the four component figures stay cumulative — they are what gets
   * billed — and `totalTokens` carries the last cycle's context instead.
   */
  let lastCycleContext = 0;
  /**
   * Fold per-model spend into one `ClaudeUsage`.
   *
   * Every entry counts, including models the session did not pick: a
   * sub-agent may run a different model, and the auto-titler always does.
   * Returns undefined when the CLI sent no `modelUsage` (older versions), so
   * the caller can fall back to the main-agent-only `usage`.
   *
   * The folded tokens are priced at the SESSION's model rates by
   * `calculateCost`. That is exact for sub-agents, which inherit the session
   * model, and slightly off for a cheaper helper model — a known skew worth
   * far less than the tokens it stops hiding.
   */
  function sumModelUsage(
    modelUsage: Readonly<Record<string, ClaudeModelUsage>> | null | undefined,
  ): UsageCounters | undefined {
    if (!modelUsage) return undefined;
    const entries = Object.values(modelUsage);
    if (entries.length === 0) return undefined;
    const total = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    for (const entry of entries) {
      total.input_tokens += entry.inputTokens ?? 0;
      total.output_tokens += entry.outputTokens ?? 0;
      total.cache_read_input_tokens += entry.cacheReadInputTokens ?? 0;
      total.cache_creation_input_tokens += entry.cacheCreationInputTokens ?? 0;
    }
    return total;
  }

  /** Prompt size of one cycle: everything the model read, excluding output. */
  function contextOf(usage: Partial<UsageCounters>): number {
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    );
  }

  function recomputeUsage(): void {
    output.usage.input = cumulativeUsage.input_tokens + (cycleUsage.input_tokens ?? 0);
    output.usage.output = cumulativeUsage.output_tokens + (cycleUsage.output_tokens ?? 0);
    output.usage.cacheRead =
      cumulativeUsage.cache_read_input_tokens + (cycleUsage.cache_read_input_tokens ?? 0);
    output.usage.cacheWrite =
      cumulativeUsage.cache_creation_input_tokens + (cycleUsage.cache_creation_input_tokens ?? 0);
    // Latch the newest cycle we have numbers for. `applyResult` clears
    // cycleUsage, so a zero here means "no fresher figure", never "empty
    // context" — the last latched value must survive.
    const cycleContext = contextOf(cycleUsage);
    if (cycleContext > 0) lastCycleContext = cycleContext;
    output.usage.totalTokens =
      lastCycleContext > 0
        ? lastCycleContext
        : output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite;
    // Subsets of the totals above, never more than them.
    const cacheWrite1h = plus(bankedCacheWrite1h, cycleCacheWrite1h);
    if (cacheWrite1h !== undefined)
      output.usage.cacheWrite1h = Math.min(cacheWrite1h, output.usage.cacheWrite);
    const reasoning = plus(bankedReasoning, cycleReasoning);
    if (reasoning !== undefined) output.usage.reasoning = Math.min(reasoning, output.usage.output);
    calculateCost(model, output.usage);
  }

  /**
   * Append a complete text block through proper pi stream events. Tracked
   * blocks carry their own contentIndex, so an appended block (the
   * final-answer safety net) needs no relationship to any SSE index.
   */
  function appendTextBlock(text: string): void {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
    const contentIndex = output.content.length;
    blocks.push({ type: "text", text, index: -1, cycle: -1, contentIndex });
    output.content.push({ type: "text" as const, text: "" });
    stream.push({ type: "text_start", contentIndex, partial: output });
    (output.content[contentIndex] as TextContent).text = text;
    stream.push({
      type: "text_delta",
      contentIndex,
      delta: text,
      partial: output,
    });
    stream.push({
      type: "text_end",
      contentIndex,
      content: text,
      partial: output,
    });
  }

  /** Show the arguments parsed so far on the streaming partial. */
  function setToolCallArguments(contentIndex: number, args: ToolCall["arguments"]): void {
    const content = output.content[contentIndex];
    if (content?.type === "toolCall") content.arguments = args;
  }

  function handleEvent(event: ClaudeApiEvent): void {
    // Emit start event on first message — tells pi to begin incremental rendering
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }

    switch (event.type) {
      case "message_start":
        // New cycle: bank the finished cycle's usage before resetting.
        cumulativeUsage.input_tokens += cycleUsage.input_tokens ?? 0;
        cumulativeUsage.output_tokens += cycleUsage.output_tokens ?? 0;
        cumulativeUsage.cache_read_input_tokens += cycleUsage.cache_read_input_tokens ?? 0;
        cumulativeUsage.cache_creation_input_tokens += cycleUsage.cache_creation_input_tokens ?? 0;
        cycleUsage = {};
        bankedCacheWrite1h = plus(bankedCacheWrite1h, cycleCacheWrite1h);
        cycleCacheWrite1h = undefined;
        bankedReasoning = plus(bankedReasoning, cycleReasoning);
        cycleReasoning = undefined;
        cycle++;
        // A second API message in the episode: nothing is replayable.
        if (cycle > 0) storeSignedThinking();
        handleMessageStart(event);
        break;
      case "content_block_start":
        handleContentBlockStart(event);
        break;
      case "content_block_delta":
        handleContentBlockDelta(event);
        break;
      case "content_block_stop":
        handleContentBlockStop(event);
        break;
      case "message_delta":
        handleMessageDelta(event);
        break;
      case "message_stop":
        handleMessageStop();
        break;
      // Unknown event types are silently ignored
    }
  }

  function handleMessageStart(event: ClaudeApiEvent): void {
    const id = event.message?.id;
    if (id !== undefined) {
      cycleMessageIds.set(cycle, id);
      // The last API message of the episode is the response pi records.
      output.responseId = id;
    }
    const usage = event.message?.usage;
    if (usage) {
      cycleUsage = presentCounters(usage);
      cycleCacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined;
      recomputeUsage();
    }
  }

  function handleContentBlockStart(event: ClaudeApiEvent): void {
    const blockType = event.content_block?.type;

    if (blockType === "text") {
      const block: TrackedContentBlock = {
        type: "text",
        text: "",
        index: event.index ?? 0,
        cycle,
        contentIndex: output.content.length,
      };
      blocks.push(block);
      output.content.push({ type: "text" as const, text: "" });

      stream.push({
        type: "text_start",
        contentIndex: block.contentIndex,
        partial: output,
      });
    } else if (blockType === "thinking") {
      // Deliberately NOT materialized yet. Several Claude models (verified:
      // fable-5, opus-5, sonnet-5 at effort medium; haiku-4-5 is the
      // exception) stream ENCRYPTED thinking: a multi-kilobyte
      // signature_delta with no thinking_delta at all. Materializing on
      // start produced a thinking block with no text, which front-ends
      // faithfully rendered as an empty "thought". The block is created on
      // the first plaintext delta and dropped at block_stop if none arrives.
      const block: TrackedContentBlock = {
        type: "thinking",
        text: "",
        index: event.index ?? 0,
        cycle,
        contentIndex: -1,
        at: visibleBlockCount(),
      };
      blocks.push(block);
    } else if (blockType === "redacted_thinking") {
      // Nothing to show pi, but the API wants it back with the message.
      const data = event.content_block?.data;
      if (data !== undefined && data.length > 0) {
        signedBlocks.push({
          at: visibleBlockCount(),
          block: { type: "redacted_thinking", data },
        });
        storeSignedThinking();
      }
    } else if (blockType === "tool_use") {
      const claudeName = event.content_block!.name!;

      // Only pi's tools, advertised through the schema-only MCP server,
      // become toolCalls for pi's loop. The CLI is spawned with no native
      // tools, so anything else is a name the model invented.
      if (!isHandoffClaudeTool(claudeName)) {
        return;
      }

      const piName = toolNames(claudeName);
      const id = event.content_block!.id!;

      const block: TrackedToolBlock = {
        type: "tool_use",
        index: event.index ?? 0,
        cycle,
        contentIndex: output.content.length,
        id,
        name: piName,
        arguments: {},
        partialJson: "",
      };
      blocks.push(block);
      output.content.push({
        type: "toolCall" as const,
        id,
        name: piName,
        arguments: {},
      });

      stream.push({
        type: "toolcall_start",
        contentIndex: block.contentIndex,
        partial: output,
      });
    }
    // Unknown block types silently ignored
  }

  /** Locate the tracked block for this cycle's SSE index. */
  function trackedFor(event: ClaudeApiEvent): TrackedBlock | undefined {
    const idx = blocks.findIndex((b) => b.cycle === cycle && b.index === event.index);
    return idx === -1 ? undefined : blocks[idx];
  }

  /**
   * Create the pi content block for a thinking block that has now proven it
   * carries plaintext. Encrypted thinking never reaches this path, so it
   * never becomes an empty "thought" downstream.
   */
  function materializeThinking(block: TrackedContentBlock): void {
    block.contentIndex = output.content.length;
    output.content.push({
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: block.pendingSignature ?? "",
    });
    block.pendingSignature = undefined;
    stream.push({
      type: "thinking_start",
      contentIndex: block.contentIndex,
      partial: output,
    });
  }

  function handleContentBlockDelta(event: ClaudeApiEvent): void {
    const deltaType = event.delta?.type;
    const block = trackedFor(event);
    if (!block) return;

    if (deltaType === "text_delta" && event.delta!.text != null) {
      if (block.type !== "text") return;
      block.text += event.delta!.text;
      (output.content[block.contentIndex] as TextContent).text = block.text;
      stream.push({
        type: "text_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.text,
        partial: output,
      });
    } else if (deltaType === "thinking_delta" && event.delta!.thinking != null) {
      if (block.type !== "thinking") return;
      // Empty thinking_delta events accompany encrypted thinking (verified
      // on sonnet-5): they carry no plaintext, so they must not bring a
      // thinking block into existence.
      if (block.contentIndex === -1) {
        if (event.delta!.thinking.length === 0) return;
        materializeThinking(block);
      }
      block.text += event.delta!.thinking;
      (output.content[block.contentIndex] as ThinkingContent).thinking = block.text;
      stream.push({
        type: "thinking_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.thinking,
        partial: output,
      });
    } else if (deltaType === "input_json_delta" && event.delta!.partial_json != null) {
      if (block.type !== "tool_use") return;
      block.partialJson += event.delta!.partial_json;
      try {
        const parsed = JSON.parse(block.partialJson);
        // Only an object may overwrite the arguments. A payload that parses
        // to null/array/scalar would otherwise land on the streaming partial
        // and be shown to the user as the tool's arguments.
        if (isArgumentObject(parsed)) {
          block.arguments = parsed;
          setToolCallArguments(block.contentIndex, block.arguments);
        }
      } catch {
        // Partial JSON not yet parseable -- keep previous arguments
      }
      stream.push({
        type: "toolcall_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.partial_json,
        partial: output,
      });
    } else if (deltaType === "signature_delta" && event.delta!.signature != null) {
      if (block.type !== "thinking") return;
      block.signature = (block.signature ?? "") + event.delta!.signature;
      if (block.contentIndex === -1) {
        // Signature before (or without) any plaintext: hold it in case
        // plaintext follows. If it never does, the block is dropped.
        block.pendingSignature = (block.pendingSignature ?? "") + event.delta!.signature;
        return;
      }
      const contentBlock = output.content[block.contentIndex] as ThinkingContent;
      contentBlock.thinkingSignature =
        (contentBlock.thinkingSignature || "") + event.delta!.signature;
    }
  }

  function handleContentBlockStop(event: ClaudeApiEvent): void {
    const idx = blocks.findIndex((b) => b.cycle === cycle && b.index === event.index);
    if (idx === -1) return;
    const block = blocks[idx];

    // The raw block is kept whether or not pi has anything to show for it.
    if (block.type === "thinking" && block.signature !== undefined && block.signature.length > 0)
      signedBlocks.push({
        at: block.at ?? 0,
        block: {
          type: "thinking",
          thinking: block.text,
          signature: block.signature,
        },
      });

    // Encrypted thinking: signature only, no plaintext. Drop it rather than
    // emit a content block with nothing to show.
    if (block.type === "thinking" && block.contentIndex === -1) {
      blocks.splice(idx, 1);
      storeSignedThinking();
      return;
    }

    // A stopped block must not match a later event of the same cycle.
    block.index = STOPPED_BLOCK_INDEX;

    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: block.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: block.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      // Arguments stream in as input_json_delta events. A call with NO
      // arguments -- mcp({}), artifact_list() -- sends no deltas at all, so
      // the accumulator is still "" here. JSON.parse("") throws, and handing
      // pi the raw "" made it reject the call against the tool's schema with
      // `root: must be object`. Empty means {}, not malformed: that is the
      // difference between "the model sent no arguments" and "the arguments
      // did not arrive intact".
      //
      // Anything that is non-empty but unusable still passes through as its
      // raw string, on purpose. That text is the only evidence of what
      // actually arrived, and coercing it to {} would turn a visible failure
      // into a tool that silently ran with no arguments.
      let finalArgs: ToolCall["arguments"] | string;
      if (block.partialJson.trim() === "") {
        finalArgs = {};
      } else {
        try {
          const parsed = JSON.parse(block.partialJson);
          finalArgs = isArgumentObject(parsed) ? parsed : block.partialJson;
        } catch {
          finalArgs = block.partialJson;
        }
      }

      // ToolCall.arguments is typed as a JSON object in pi-ai, but a raw
      // string is emitted on purpose when the arguments did not arrive as
      // one (see above). pi reports string arguments as a schema failure at
      // runtime, which is the visible outcome wanted here; this assertion is
      // the one place that contract is stretched.
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: finalArgs,
      } as ToolCall;
      output.content[block.contentIndex] = toolCall;

      stream.push({
        type: "toolcall_end",
        contentIndex: block.contentIndex,
        toolCall,
        partial: output,
      });
    }
    // The fingerprint follows the content as each block completes.
    storeSignedThinking();
  }

  function handleMessageDelta(event: ClaudeApiEvent): void {
    if (event.delta?.stop_reason) {
      // The LAST cycle's stop reason is the episode's stop reason.
      const mapped = mapStopReason(event.delta.stop_reason, event.delta.stop_details?.explanation);
      output.rawStopReason = event.delta.stop_reason;
      output.stopReason = mapped.stopReason;
      if (mapped.errorMessage !== undefined) output.errorMessage = mapped.errorMessage;
      else delete output.errorMessage;
    }

    const usage = event.usage;
    if (usage) {
      // message_delta carries the cycle's final numbers — overwrite within
      // the cycle, never across cycles (those are banked at message_start).
      if (usage.input_tokens != null) cycleUsage.input_tokens = usage.input_tokens;
      if (usage.output_tokens != null) cycleUsage.output_tokens = usage.output_tokens;
      if (usage.cache_read_input_tokens != null)
        cycleUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
      if (usage.cache_creation_input_tokens != null)
        cycleUsage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
      if (usage.cache_creation?.ephemeral_1h_input_tokens != null)
        cycleCacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
      if (usage.output_tokens_details?.thinking_tokens != null)
        cycleReasoning = usage.output_tokens_details.thinking_tokens;
      recomputeUsage();
    }
  }

  function handleMessageStop(): void {
    // No-op: done event is pushed by the provider after readline closes.
    // Pushing done here (synchronously) prevents pi from executing tools.
  }

  function applyResult(result: ClaudeResultMessage): void {
    // Authoritative spend for the whole episode. `modelUsage` is preferred
    // over `usage` because `usage` is the MAIN AGENT ONLY: sub-agents run
    // inside the CLI and never appear in the parent stream, so their tokens
    // — often the majority — were simply missing from what the host billed.
    // Same for helper models like the haiku auto-titler.
    //
    // Measured 2026-08-27: a lane's turn reported $2.34 while seven
    // sub-agents spent 28.6M cache-read tokens on top of it, a 10x
    // under-report. On a captured single-sub-agent episode `modelUsage`
    // summed to exactly main + sub-agent (102,641 cache-read / 56,920
    // cache-write), which is why it is trusted here.
    const totals = sumModelUsage(result.modelUsage) ?? result.usage;
    if (totals) {
      cumulativeUsage.input_tokens = totals.input_tokens ?? cumulativeUsage.input_tokens;
      cumulativeUsage.output_tokens = totals.output_tokens ?? cumulativeUsage.output_tokens;
      cumulativeUsage.cache_read_input_tokens =
        totals.cache_read_input_tokens ?? cumulativeUsage.cache_read_input_tokens;
      cumulativeUsage.cache_creation_input_tokens =
        totals.cache_creation_input_tokens ?? cumulativeUsage.cache_creation_input_tokens;
      cycleUsage = {};
      recomputeUsage();
    }

    // Safety net: whatever ended the SSE stream early, the result envelope
    // carries the episode's final answer — never let it be lost.
    const finalText = (result.result ?? "").trim();
    if (finalText) {
      const streamedText = output.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const tail = finalText.slice(-Math.min(finalText.length, 60));
      if (!streamedText.includes(tail)) {
        appendTextBlock(finalText);
        storeSignedThinking();
      }
    }
  }

  function recordAssistantBlocks(
    messageId: string,
    content: ReadonlyArray<ClaudeAssistantBlock>,
  ): void {
    const recorded = recordedBlocks.get(messageId) ?? [];
    recorded.push(...content);
    recordedBlocks.set(messageId, recorded);
  }

  function streamMismatch(): string | undefined {
    const id = cycleMessageIds.get(cycle);
    if (id === undefined) return undefined;
    // Whitespace-only text is left out, and text is compared trimmed: the
    // CLI may tidy what it records of a message, and only a difference in
    // what the model said should fail the call.
    const recorded = (recordedBlocks.get(id) ?? []).filter(
      (block) =>
        (block.type === "text" && hasVisibleText(block.text ?? "")) ||
        (block.type === "tool_use" && isHandoffClaudeTool(block.name ?? "")),
    );
    const streamed = blocks.filter(
      (block) =>
        block.cycle === cycle &&
        ((block.type === "text" && hasVisibleText(block.text)) || block.type === "tool_use"),
    );
    // The record may trail the stream, never the other way round.
    if (recorded.length > streamed.length)
      return `the stream carried ${streamed.length} of the ${recorded.length} blocks the Claude CLI recorded`;
    for (const [position, expected] of recorded.entries()) {
      const actual = streamed[position];
      const differs = `block ${position + 1} (${expected.type}) of the stream differs from the Claude CLI's record of it`;
      if (expected.type === "text") {
        if (actual?.type !== "text" || actual.text.trim() !== (expected.text ?? "").trim())
          return differs;
        continue;
      }
      if (
        actual?.type !== "tool_use" ||
        actual.id !== expected.id ||
        actual.name !== toolNames(expected.name ?? "")
      )
        return differs;
      const content = output.content[actual.contentIndex];
      // Arguments that did not arrive as an object reach pi as their raw
      // text, which pi reports itself (see handleContentBlockStop).
      if (
        content?.type === "toolCall" &&
        typeof content.arguments === "object" &&
        canonicalJson(content.arguments) !== canonicalJson(expected.input ?? {})
      )
        return differs;
    }
    return undefined;
  }

  function recordRateLimit(info: ClaudeRateLimitInfo, reportedAtMillis: number): void {
    const diagnostic: AssistantMessageDiagnostic = {
      type: RATE_LIMIT_DIAGNOSTIC,
      timestamp: reportedAtMillis,
      details: rateLimitDetails(info),
    };
    output.diagnostics = [
      ...(output.diagnostics ?? []).filter((entry) => entry.type !== RATE_LIMIT_DIAGNOSTIC),
      diagnostic,
    ];
  }

  function setProviderThinkingLevel(level: string | undefined): void {
    if (level === undefined) delete output.providerThinkingLevel;
    else output.providerThinkingLevel = level;
  }

  return {
    handleEvent,
    applyResult,
    recordAssistantBlocks,
    streamMismatch,
    recordRateLimit,
    setProviderThinkingLevel,
    getOutput: () => output,
  };
}
