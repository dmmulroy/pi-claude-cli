# Pi-owned context and execution

This is the only execution path in this fork. Upstream's `legacy` observer path and the `PI_CLAUDE_CLI_CONTEXT` switch are removed.

## Request contract

The provider accepts both legacy pi `Context` and pi 0.87 `TranscriptContext`. For the latter it resolves the current prompt and tools through pi-ai's `getCurrentSystemPrompt` / `getCurrentTools`, including section replacements and tool removals. System messages are not mistaken for user conversation.

The current prompt is passed through `--system-prompt-file`, without editing user instructions or loading AGENTS/CLAUDE files independently. One short suffix binds pi tool names to `mcp__custom-tools__<name>` with unchanged argument schemas.

Only tools in the model request are exposed through MCP. No registry-wide activation, native-tool substitutions, schema translation, or default Claude agent tools. All actual execution happens in pi, so tool-call guards, tool-result transformations and complete results have the same owner on every provider.

## CLI launch

Every launch uses:

- `--system-prompt-file`, even for an empty pi prompt
- `--tools "" --no-session-persistence`
- `--strict-mcp-config --setting-sources "" --disable-slash-commands --no-chrome`
- the explicit pi MCP bridge and optional host `--settings`

Child-only environment disables independent CLAUDE.md/auto-memory discovery, claude.ai MCP connectors, tool search and CLI auto-compaction. Subscription OAuth/keychain access is retained. `--bare`, inherited simple mode and safe mode are not substitutes. Explicit host guards and managed policy still apply. Standalone Claude Code settings are never modified.

## Conversation synchronization

A CLI process is a disposable cache, not another source of truth. After each successful provider episode, the provider records a hash and length of the pi history it acknowledged, including the emitted assistant message. It hashes model-visible content, excluding timestamps, usage and thinking signatures.

Reuse requires an unchanged history prefix and launch signature. A tool handoff must also contain exactly the awaited tool results. Changed history, prompt or tools retire the process and import pi's current context in order. This covers native-provider turns, branch edits, compaction, extension context rewrites and process restarts. No stale saved prompt or CLI transcript is resumed. The thinking level is not part of the launch signature: a new level is applied to the live process through Claude Code's control requests before the next user turn, and only a refused change retires it ([ARCHITECTURE.md](ARCHITECTURE.md#thinking-the-same-request-pi-would-send-0100)).

Model selection, session start/shutdown, tree navigation and compaction retire parked processes. Session-map and saved-prompt sidecars written by upstream versions before 0.9.0 are neither read nor deleted.

A CLI import uses ordered, role-labelled content because print mode does not accept an arbitrary structured transcript. Every supplied user/tool image and tool result is retained, including errors; internal thinking is not replayed. This is semantic continuity, not identical wire requests or guaranteed identical model behavior.

## Compaction and failure

pi owns compaction and retry. Hosts must stop forcing `set_auto_compaction: false` for this provider. A compacted pi history invalidates the disposable Claude process before the next request. Errors and aborts return structured assistant errors, not raw strings or success messages; the existing overflow normalizer enables pi's recovery path.

A stopped/failed process is not reused. Runs write no Claude conversation file or resume sidecar. Temporary MCP configuration is removed on retirement/exit; prompt staging files are removed after an episode and the private runtime directory on pi exit. SIGKILL cannot run cleanup and may leave its private directory.

## Verification

Unit coverage includes changed prompts, branch/compaction rewrites, foreign-provider turns, unchanged-prefix reuse, complete replay, inactive/removed tools, current pi transcript format, lifecycle retirement and structured errors.

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run test:e2e
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts tests/live-pi-roundtrip.test.ts
```

Live checks use isolated fixtures, not user integrations. The CLI check verifies the tool inventory, handoff execution, host hooks, warm follow-ups and absence of new transcript/sidecar files. The real-pi RPC check executes read/edit, enforces a pi guard, switches through a deterministic native provider, then performs pi compaction and verifies recall. They spend subscription tokens and do not assert a universal token saving.
