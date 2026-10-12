# pi-claude-cli (private fork)

Use a Claude Pro/Max subscription from the [pi coding agent](https://github.com/earendil-works/pi). The official Claude Code CLI handles authentication and model access. pi owns the prompt, tools, conversation and compaction.

This is a private fork of [`agustinsacco/pi-claude-cli`](https://github.com/agustinsacco/pi-claude-cli) (git remote `upstream`), forked at 0.10.0. See [Differences from upstream](#differences-from-upstream).

## Install

In pi's `settings.json`:

```json
{ "packages": ["git:github.com/dmmulroy/pi-claude-cli"] }
```

Pick a model under `pi-claude-cli` with `/model`.

Requires macOS or Linux, Node 22+, pi, and an authenticated `claude` binary on PATH (Claude Code 2.1.263+). Windows is not supported. Subscription credentials stay in the official CLI; no API key extraction. A missing or too-old CLI is reported as an assistant error on the first model call, not at startup.

## One owner: pi

- **Prompt:** pi's current system prompt replaces Claude Code's. A short suffix explains the MCP tool-name prefix. Project instructions, skills and `.pi` paths are unchanged; Claude does not independently discover any.
- **Tools:** only the current request's tools are advertised, through an MCP server the provider hosts in-band on the CLI's own stdio control channel. Every tool, including read/edit/bash, executes in pi, so pi's tool hooks, schemas and complete results apply. The CLI has no native tools, and there is no socket or helper process.
- **Conversation:** pi's history is authoritative. A warm Claude process is reused only while the history prefix it acknowledged and its launch configuration still match. Edits, compaction, provider changes, prompt changes or tool changes retire it, and the next call imports pi's current history into a fresh process.
- **Storage:** Claude processes run with `--no-session-persistence`. No Claude conversation file or resume pairing is written. The staged system prompt file is removed after the call that launched the process; the private runtime directory is removed when the pi session shuts down. A SIGKILL can leave that directory behind. [Traces](#traces) hold no conversation content.
- **Compaction:** pi compacts its own history. CLI auto-compaction is disabled.
- **Status line:** nothing is written to pi's footer.

## Cost of a fresh process

A fresh CLI process is handed pi's whole history as one user message of role-labelled text plus image blocks. That import misses the prompt cache for the conversation. Ordinary follow-ups and tool calls keep the warm process and send only the new content.

**Not byte-identical to a direct API provider:** Claude Code's print interface accepts user messages, not an arbitrary structured conversation. Historical tool calls are replayed as records (`TOOL CALL <name> id=…`), and thinking is not replayed.

See [the context contract](docs/CONTEXT-POLICY.md) for the details.

## Configuration

No environment variables are required.

| Variable                         | Default      | Purpose                                                                        |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`     | `600000`     | Idle lifetime of a parked process; `0` parks nothing                           |
| `PI_CLAUDE_CLI_SETTINGS`         | unset        | Explicit Claude Code settings file (hooks, permissions) passed as `--settings` |
| `PI_CLAUDE_CLI_TIMEOUT_MS`       | `300000`     | Maximum stdout inactivity while a call is attached                             |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS`  | `1800000`    | Maximum wait for pi to answer a tool call                                      |
| `PI_CLAUDE_CLI_HANDOFF_PROXY`    | on           | `0` interrupts the turn at each tool call instead of holding it open           |
| `PI_CLAUDE_CLI_TRACE`            | daily file   | Trace file path, or `off`; see [Traces](#traces)                               |
| `PI_CLAUDE_CLI_TRACE_WIRE`       | counts       | `1` records one event per wire message; `raw` records raw lines, with content  |
| `PI_CLAUDE_CLI_THINKING_DISPLAY` | `summarized` | `omitted` returns no thinking summaries                                        |
| `MCP_TOOL_TIMEOUT`               | `3600000`    | CLI-side MCP call timeout                                                      |

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are never forwarded to the CLI: any of them would move it off the subscription login. A value that does not parse falls back to its default.

pi's thinking levels reach the model as the request pi's own Anthropic provider would send: `off` disables thinking, other levels send pi's budget or effort with thinking summaries. A level changed mid-session applies from the next turn without restarting the CLI.

## Traces

The provider records what it does as spans: one per model call, per CLI launch, per process lifetime, per tool call, per retirement. They are written as NDJSON to `~/.local/state/pi-claude-cli/traces/<date>.ndjson` (or under `$XDG_STATE_HOME`), in a `0700` directory with `0600` files, and files not written for seven days are removed. `PI_CLAUDE_CLI_TRACE=<path>` writes elsewhere and `PI_CLAUDE_CLI_TRACE=off` writes nothing. A failed write turns tracing off for the session and never fails a model call.

Traces are not a transcript. They hold ids, tool names, sizes, counts and durations, and never prompt text, tool arguments or tool results. The one exception is `PI_CLAUDE_CLI_TRACE_WIRE=raw`, which records the CLI's raw output for protocol debugging.

From a checkout of this repository:

```bash
npm run trace -- tree --last     # the most recent model call, as a span tree
npm run trace -- ls              # one line per trace
npm run trace -- open            # spans that never ended
npm run trace -- stats           # count and duration by span name
```

## Differences from upstream

- **Single execution path.** Upstream's legacy "observer" mode is deleted: native Claude tools, `--resume` and the session-map sidecar, tool markers, sub-agent tracking, CLI-owned compaction, and the `PI_CLAUDE_CLI_CONTEXT`, `PI_CLAUDE_CLI_SYSTEM_PROMPT`, `PI_CLAUDE_CLI_AUTOCOMPACT`, `PI_CLAUDE_CLI_TOOL_RESULTS`, `PI_CLAUDE_CLI_HERMETIC`, `PI_CLAUDE_CLI_STRICT_MCP` and `PI_CLAUDE_CLI_EPHEMERAL` switches.
- **Rewritten on Effect 4.** Each CLI process is one scope; an episode is one fiber whose exit ends pi's stream exactly once. See [effect-rewrite.md](effect-rewrite.md).
- **Tools travel in-band.** The schema-only MCP server, its `node` child per CLI process, the unix socket and the shared secret are gone. Each process is told its own tool surface, so a concurrent tool-less request cannot leave the main turn without tools ([upstream #49](https://github.com/agustinsacco/pi-claude-cli/issues/49)).
- **Traces.** On by default, private, content-free.
- **No Windows support**, and no `cross-spawn` dependency.
- **No status-line channels.** The `claude-rate-limit` and `claude-subagents` status keys are gone.
- **Subscription-override env vars are stripped** from the CLI's environment.
- **Captured stderr is capped** at the most recent 64 KiB per process.
- **Not published to npm.**

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage     # unit tests of the pure modules
npm run test:scenarios    # the provider against a stub CLI, checked by trace assertions
npm run test:e2e          # real pi, stub CLI
```

Scripts are TypeScript run directly by Node (22.18+). `npm run test:scenarios` and `npm run test:e2e` need `pi` on PATH.

The opt-in real-CLI checks spend subscription tokens in a disposable workspace:

```bash
node scripts/scenarios.ts --live
PI_OWNED_LIVE=1 npx vitest run tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts
```

## License

MIT
