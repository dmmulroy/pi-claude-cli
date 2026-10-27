# Pi-owned context and execution

This is the only execution path in this fork. Upstream's `legacy` observer path and the `PI_CLAUDE_CLI_CONTEXT` switch are removed.

## Request contract

The provider accepts both legacy pi `Context` and pi 0.87 `TranscriptContext`. For the latter it resolves the current prompt and tools through pi-ai's `getCurrentSystemPrompt` / `getCurrentTools`, including section replacements and tool removals. System messages are not mistaken for user conversation.

The current prompt is passed through `--system-prompt-file`, without editing user instructions or loading AGENTS/CLAUDE files independently. One short suffix binds pi tool names to `mcp__custom-tools__<name>` with unchanged argument schemas.

Only tools in the model request are exposed, through an MCP server the provider hosts in-band: the CLI is launched with a `"type": "sdk"` server named `custom-tools`, sends its MCP requests as control requests on stdout, and reads the answers from stdin. There is no socket, helper process or shared secret. A `tools/call` must name a `tool_use` block the process streamed and the tool that block asked for; anything else is refused at once. No registry-wide activation, native-tool substitutions, schema translation, or default Claude agent tools. All actual execution happens in pi, so tool-call guards, tool-result transformations and complete results have the same owner on every provider.

## CLI launch

Every launch uses:

- `--system-prompt-file`, even for an empty pi prompt
- `--tools "" --no-session-persistence`
- `--strict-mcp-config --setting-sources "" --disable-slash-commands --no-chrome`
- `--mcp-config` declaring the in-band `custom-tools` server, and optional host `--settings`

Child-only environment disables independent CLAUDE.md/auto-memory discovery, claude.ai MCP connectors, tool search, all CLI compaction (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`), the CLI's own API retries (`CLAUDE_CODE_MAX_RETRIES=0`, and an inherited `CLAUDE_CODE_RETRY_WATCHDOG` is removed) its non-essential traffic (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: updates, telemetry, error reporting and feature-flag fetching) and its `<total_tokens>` countdown reminder (`CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`). An inherited `CLAUDE_CODE_EXTRA_BODY` is removed, as is every variable that would move the CLI off the subscription: API keys and tokens, `ANTHROPIC_BASE_URL`, and the Bedrock, Mantle, Vertex, Foundry and Claude Platform on AWS switches. Subscription OAuth/keychain access is retained. `--bare`, inherited simple mode and safe mode are not substitutes. Explicit host guards and managed policy still apply. Standalone Claude Code settings are never modified.

## Conversation synchronization

A CLI process is a disposable cache, not another source of truth. After each successful provider episode, the provider records a hash and length of the pi history it acknowledged, including the emitted assistant message. It hashes model-visible content, excluding timestamps, usage, thinking, `diagnostics` and the `piClaudeCli` metadata.

Reuse requires an unchanged history prefix and launch signature (model, system prompt, working directory and handoff mode). A tool handoff must also contain exactly the awaited tool results: the CLI stays blocked on its `tools/call`, pi runs the tool, and pi's next call answers the same process. Changed history or a changed prompt retires the process and import pi's current context in order. This covers native-provider turns, branch edits, compaction, extension context rewrites and process restarts. No stale saved prompt or CLI transcript is resumed. The thinking level is not part of the launch signature: a new level is applied to the live process through Claude Code's control requests before the next user turn, and only a refused change retires it. The tool surface is not part of it either: pi's tools for the call are compared with the ones the process is serving, and a difference is sent as MCP `notifications/tools/list_changed` on the in-band server, between turns or while a tool call is open. The change counts only once the CLI has asked for `tools/list` again; a CLI that does not ask within three seconds is retired and pi's history imported into a fresh process. A tool the model calls after pi removed it is refused by the CLI itself and by pi, and the next call imports pi's history afresh.

A parked process waits one hour for its session's next call, as long as Claude Code's prompt cache lasts. With the turn relay (the default) a fresh process reads the same cache, so retiring sooner costs a launch and an import, not a cache write.

Model selection, session start, tree navigation and compaction retire parked processes; session shutdown disposes the whole runtime, which ends every process and removes the private runtime directory. Session-map and saved-prompt sidecars written by upstream versions before 0.9.0 are neither read nor deleted.

On a CLI that cannot take the structured import, a CLI import uses ordered, role-labelled content in one user message. Every supplied user/tool image and tool result is retained, including errors; internal thinking is not replayed. This is semantic continuity, not identical wire requests or guaranteed identical model behavior.

By default the import is the messages themselves, on a CLI known to take them (2.1.292+). Each user message before the last is written with `shouldQuery: false`, which adds it to the CLI's conversation without a model call, and the provider waits for the empty `result` that confirms it before writing the next line; each assistant turn is written as an `assistant` message naming the process's model; the last user message starts the turn. The wire then carries real `tool_use` and `tool_result` blocks in pi's order. The rules are pi-ai's own (`transformMessages`): failed and aborted assistant turns are left out, a tool call without a result gets one that says so, and a result without its call stays a text record. A history that does not start and end with a user message, or has two assistant turns in a row, is imported as text.

Tool call ids are checked on the way out. The Anthropic API accepts `^[a-zA-Z0-9_-]{1,64}$`; an id from another provider that does not fit is replaced, in the import only, by `toolu_pi_` plus a hash of it, the same on the call and its result and the same in every import. pi's stored ids are never changed. Ids of calls the model makes on this provider are Claude's own, so pi's results name them as they are.

Thinking is stored and replayed under the API's own rule that a signed block is accepted only as it was returned, in the message it came with. For every assistant message the provider records Claude's raw thinking blocks on the pi message, under the `piClaudeCli` key (not in pi's `diagnostics`, which pi's bug report collects without the session; thinking is conversation content): the block with its signature (or the opaque data of a redacted block), how many text and tool call blocks stood before it, the model, and a fingerprint of the message's text and tool calls. That includes encrypted thinking, which has no text and so no block in pi's content. Nothing is recorded when an episode spans more than one API message. In a structured import the raw blocks are replayed in their places only when the message is this provider's, the process runs the model that signed them, and the fingerprint still matches. Otherwise the signature is dropped and what pi holds of the thinking is replayed as plain text; another provider's thinking is always plain text, whatever signature it carries. The text import still replays no thinking. Signatures are opaque model output, stored in pi's session like the rest of the message. Traces do not contain them, except the raw wire lines of `PI_CLAUDE_CLI_TRACE_WIRE=raw`.

If the CLI answers a held message with a model turn, or does not confirm it within twenty seconds, the import has failed: the process is retired (`cause=import`) and a fresh one gets the text import. Neither `shouldQuery` nor assistant messages on stdin are documented by Claude Code; the live tests (`tests/live-structured-import.test.ts`, `tests/live-pi-roundtrip.test.ts`) check them against the real API and are the thing to rerun when a new Claude Code version misbehaves. A new user turn on a warm process sends the user message as the structured import would, without role labels.

There is no separate resume. A pi session resumed from disk, like any other new process, gets pi's history through this import, signed thinking included. Claude Code's own `--resume` would need its transcript, which would make the CLI a second conversation ledger. Rebuilding gains no prompt-cache reuse: Claude Code adds its startup reminders to the first user message it sends the model, which in a fresh process is the latest one, so the request differs from the warm one from the first message on (measured on 2.1.299).

## Compaction and failure

pi owns compaction and retry: the CLI is launched with its own retries at zero, so a failed API request reaches pi as an assistant error at once and pi's backoff decides what happens next. Hosts must stop forcing `set_auto_compaction: false` for this provider. A compacted pi history invalidates the disposable Claude process before the next request. Errors and aborts return structured assistant errors, not raw strings or success messages; the existing overflow normalizer enables pi's recovery path.

A refusal or a safety stop (`stop_reason` `refusal` or `sensitive`) is an assistant error carrying the API's explanation, as pi's own Anthropic provider reports it, and its process is retired. When the CLI reports that a model call was charged to usage credits, the episode ends with a billing error pi does not retry, unless `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1`; the status can arrive after a tool call was handed off, and then the next call stops before the tool result is sent. Anthropic's refusal to serve a request on plan limits is rewritten into the same kind of error. At each `message_stop` the streamed text and tool calls are compared with the CLI's own `assistant` record of the message, which it writes before each block's `content_block_stop`; a difference ends the episode with an error rather than hand pi a tool call whose arguments did not arrive as sent.

A stopped/failed process is not reused: a failed, timed-out or aborted episode retires its process in the background, after pi has its error. A stall is stdout silence for `PI_CLAUDE_CLI_TIMEOUT_MS` while a call is attached, counting every line the CLI writes, control traffic included; it ends the call with an error naming that setting and kills the CLI without a grace period. The CLI shares pi's process group, so a Ctrl-C to `pi -p` reaches it directly: a closed stdin alone does not stop a turn already running. Runs write no Claude conversation file or resume sidecar. Prompt staging files are removed after the episode that launched the process and the private runtime directory when the session shuts down. SIGKILL cannot run cleanup and may leave its private directory.

Trace files (see the README) are not conversation storage: they record ids, names, sizes, counts and durations only.

## Verification

Unit tests cover the pure parts: current pi transcript format, history hashing, complete replay, thinking levels, overflow normalization and the event bridge. Everything stateful is verified by scenarios: the provider runs against a stub CLI and `trace assert` checks the recorded spans. The scenarios include usage-credit charges (before and after a handoff, refused and allowed), refusals, a stream that differs from the CLI's record, the fields of pi's message, session cleanup, changed prompts and history, tool lists changed between turns and during a tool call, a CLI that ignores the change, foreign-provider turns, warm reuse, tool handoff and its abandonment, thinking changes, abort, timeout, a dying process, idle expiry, lifecycle retirement, shutdown, environment stripping and launch flags.

```sh
vp check
vp run test:coverage
vp run test:scenarios
vp run test:e2e
node scripts/scenarios.ts --live
PI_OWNED_LIVE=1 vp test tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts tests/live-structured-import.test.ts
```

The live checks use isolated fixtures, not user integrations, and spend subscription tokens. The live scenario runs one turn, one tool call held open and one warm follow-up on a single process. The real-pi RPC check executes read/edit, enforces a pi guard, switches through a deterministic native provider, then performs pi compaction and verifies recall. The thinking check reads the requests off the wire through a local proxy and confirms each level change reaches the model on one process. None asserts a universal token saving.
