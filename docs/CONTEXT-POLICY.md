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

Child-only environment disables independent CLAUDE.md/auto-memory discovery, claude.ai MCP connectors, tool search and CLI auto-compaction. Subscription OAuth/keychain access is retained. `--bare`, inherited simple mode and safe mode are not substitutes. Explicit host guards and managed policy still apply. Standalone Claude Code settings are never modified.

## Conversation synchronization

A CLI process is a disposable cache, not another source of truth. After each successful provider episode, the provider records a hash and length of the pi history it acknowledged, including the emitted assistant message. It hashes model-visible content, excluding timestamps, usage and thinking signatures.

Reuse requires an unchanged history prefix and launch signature (model, system prompt, working directory, tool surface, handoff mode and host settings file). A tool handoff must also contain exactly the awaited tool results: the CLI stays blocked on its `tools/call`, pi runs the tool, and pi's next call answers the same process. Changed history, prompt or tools retire the process and import pi's current context in order. This covers native-provider turns, branch edits, compaction, extension context rewrites and process restarts. No stale saved prompt or CLI transcript is resumed. The thinking level is not part of the launch signature: a new level is applied to the live process through Claude Code's control requests before the next user turn, and only a refused change retires it.

Model selection, session start, tree navigation and compaction retire parked processes; session shutdown disposes the whole runtime, which ends every process and removes the private runtime directory. Session-map and saved-prompt sidecars written by upstream versions before 0.9.0 are neither read nor deleted.

A CLI import uses ordered, role-labelled content because print mode does not accept an arbitrary structured transcript. Every supplied user/tool image and tool result is retained, including errors; internal thinking is not replayed. This is semantic continuity, not identical wire requests or guaranteed identical model behavior.

## Compaction and failure

pi owns compaction and retry. Hosts must stop forcing `set_auto_compaction: false` for this provider. A compacted pi history invalidates the disposable Claude process before the next request. Errors and aborts return structured assistant errors, not raw strings or success messages; the existing overflow normalizer enables pi's recovery path.

A stopped/failed process is not reused: a failed, timed-out or aborted episode retires its process in the background, after pi has its error. Runs write no Claude conversation file or resume sidecar. Prompt staging files are removed after the episode that launched the process and the private runtime directory when the session shuts down. SIGKILL cannot run cleanup and may leave its private directory.

Trace files (see the README) are not conversation storage: they record ids, names, sizes, counts and durations only.

## Verification

Unit tests cover the pure parts: current pi transcript format, history hashing, complete replay, thinking levels, overflow normalization and the event bridge. Everything stateful is verified by scenarios: the provider runs against a stub CLI and `trace assert` checks the recorded spans. The scenarios include changed prompts, tools and history, foreign-provider turns, warm reuse, tool handoff and its abandonment, thinking changes, abort, timeout, a dying process, idle expiry, lifecycle retirement, shutdown, environment stripping and launch flags.

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run test:scenarios
npm run test:e2e
node scripts/scenarios.ts --live
PI_OWNED_LIVE=1 npx vitest run tests/live-pi-roundtrip.test.ts
```

The live checks use isolated fixtures, not user integrations, and spend subscription tokens. The live scenario runs one turn, one tool call held open and one warm follow-up on a single process. The real-pi RPC check executes read/edit, enforces a pi guard, switches through a deterministic native provider, then performs pi compaction and verifies recall. Neither asserts a universal token saving.
