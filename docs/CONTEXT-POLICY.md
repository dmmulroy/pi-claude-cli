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

Child-only environment disables independent CLAUDE.md/auto-memory discovery, claude.ai MCP connectors, tool search, all CLI compaction (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`), the CLI's own API retries (`CLAUDE_CODE_MAX_RETRIES=0`, and an inherited `CLAUDE_CODE_RETRY_WATCHDOG` is removed) and its non-essential traffic (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: updates, telemetry, error reporting and feature-flag fetching). Subscription OAuth/keychain access is retained. `--bare`, inherited simple mode and safe mode are not substitutes. Explicit host guards and managed policy still apply. Standalone Claude Code settings are never modified.

## Conversation synchronization

A CLI process is a disposable cache, not another source of truth. After each successful provider episode, the provider records a hash and length of the pi history it acknowledged, including the emitted assistant message. It hashes model-visible content, excluding timestamps, usage, thinking and the `piClaudeCli` metadata.

Reuse requires an unchanged history prefix and launch signature (model, system prompt, working directory, handoff mode and host settings file). A tool handoff must also contain exactly the awaited tool results: the CLI stays blocked on its `tools/call`, pi runs the tool, and pi's next call answers the same process. Changed history or a changed prompt retires the process and import pi's current context in order. This covers native-provider turns, branch edits, compaction, extension context rewrites and process restarts. No stale saved prompt or CLI transcript is resumed. The thinking level is not part of the launch signature: a new level is applied to the live process through Claude Code's control requests before the next user turn, and only a refused change retires it. The tool surface is not part of it either: pi's tools for the call are compared with the ones the process is serving, and a difference is sent as MCP `notifications/tools/list_changed` on the in-band server, between turns or while a tool call is open. The change counts only once the CLI has asked for `tools/list` again; a CLI that does not ask within three seconds is retired and pi's history imported into a fresh process. A tool the model calls after pi removed it is refused by the CLI itself and by pi, and the next call imports pi's history afresh.

Model selection, session start, tree navigation and compaction retire parked processes; session shutdown disposes the whole runtime, which ends every process and removes the private runtime directory. Session-map and saved-prompt sidecars written by upstream versions before 0.9.0 are neither read nor deleted.

A CLI import uses ordered, role-labelled content in one user message by default. Every supplied user/tool image and tool result is retained, including errors; internal thinking is not replayed. This is semantic continuity, not identical wire requests or guaranteed identical model behavior.

`PI_CLAUDE_CLI_IMPORT=structured` imports the messages themselves instead, on a CLI known to take them (2.1.292+). Each user message before the last is written with `shouldQuery: false`, which adds it to the CLI's conversation without a model call, and the provider waits for the empty `result` that confirms it before writing the next line; each assistant turn is written as an `assistant` message naming the process's model; the last user message starts the turn. The wire then carries real `tool_use` and `tool_result` blocks in pi's order. The rules are pi-ai's own (`transformMessages`): failed and aborted assistant turns are left out, a tool call without a result gets one that says so, and a result without its call stays a text record. A history that does not start and end with a user message, or has two assistant turns in a row, is imported as text.

Tool call ids are checked on the way out. The Anthropic API accepts `^[a-zA-Z0-9_-]{1,64}$`; an id from another provider that does not fit is replaced, in the import only, by `toolu_pi_` plus a hash of it, the same on the call and its result and the same in every import. pi's stored ids are never changed. Ids of calls the model makes on this provider are Claude's own, so pi's results name them as they are.

Thinking is stored and replayed under the API's own rule that a signed block is accepted only as it was returned, in the message it came with. For every assistant message the provider records Claude's raw thinking blocks on the pi message, under the `piClaudeCli` key: the block with its signature (or the opaque data of a redacted block), how many text and tool call blocks stood before it, the model, and a fingerprint of the message's text and tool calls. That includes encrypted thinking, which has no text and so no block in pi's content. Nothing is recorded when an episode spans more than one API message. In a structured import the raw blocks are replayed in their places only when the message is this provider's, the process runs the model that signed them, and the fingerprint still matches. Otherwise the signature is dropped and what pi holds of the thinking is replayed as plain text; another provider's thinking is always plain text, whatever signature it carries. The text import still replays no thinking. Signatures are opaque model output, stored in pi's session like the rest of the message. Traces do not contain them, except the raw wire lines of `PI_CLAUDE_CLI_TRACE_WIRE=raw`.

If the CLI answers a held message with a model turn, or does not confirm it within twenty seconds, the import has failed: the process is retired (`cause=import`) and a fresh one gets the text import. Neither `shouldQuery` nor assistant messages on stdin are documented by Claude Code, which is why this is opt-in.

## Compaction and failure

pi owns compaction and retry: the CLI is launched with its own retries at zero, so a failed API request reaches pi as an assistant error at once and pi's backoff decides what happens next. Hosts must stop forcing `set_auto_compaction: false` for this provider. A compacted pi history invalidates the disposable Claude process before the next request. Errors and aborts return structured assistant errors, not raw strings or success messages; the existing overflow normalizer enables pi's recovery path.

A stopped/failed process is not reused: a failed, timed-out or aborted episode retires its process in the background, after pi has its error. Each CLI process leads its own process group, and retiring it signals the group, so anything the CLI started ends with it. A stall is stdout silence for `PI_CLAUDE_CLI_TIMEOUT_MS` while a call is attached, counting every line the CLI writes, control traffic included; it ends the call with an error naming that setting and kills the group without a grace period. If pi itself is killed without running its exit handlers (SIGKILL, or an unhandled SIGINT in print mode), the CLI ends when its stdin closes, but a process the CLI had started may outlive it. Runs write no Claude conversation file or resume sidecar. Prompt staging files are removed after the episode that launched the process and the private runtime directory when the session shuts down. SIGKILL cannot run cleanup and may leave its private directory.

Trace files (see the README) are not conversation storage: they record ids, names, sizes, counts and durations only.

## Verification

Unit tests cover the pure parts: current pi transcript format, history hashing, complete replay, thinking levels, overflow normalization and the event bridge. Everything stateful is verified by scenarios: the provider runs against a stub CLI and `trace assert` checks the recorded spans. The scenarios include changed prompts and history, tool lists changed between turns and during a tool call, a CLI that ignores the change, foreign-provider turns, warm reuse, tool handoff and its abandonment, thinking changes, abort, timeout, a dying process, idle expiry, lifecycle retirement, shutdown, environment stripping and launch flags.

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run test:scenarios
npm run test:e2e
node scripts/scenarios.ts --live
PI_OWNED_LIVE=1 npx vitest run tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts
```

The live checks use isolated fixtures, not user integrations, and spend subscription tokens. The live scenario runs one turn, one tool call held open and one warm follow-up on a single process. The real-pi RPC check executes read/edit, enforces a pi guard, switches through a deterministic native provider, then performs pi compaction and verifies recall. The thinking check reads the requests off the wire through a local proxy and confirms each level change reaches the model on one process. None asserts a universal token saving.
