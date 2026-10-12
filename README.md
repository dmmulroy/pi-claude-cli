# pi-claude-cli (private fork)

Use a Claude Pro/Max subscription from the [pi coding agent](https://github.com/earendil-works/pi). The official Claude Code CLI handles authentication and model access. pi owns the prompt, tools, conversation and compaction.

This is a private fork of [`agustinsacco/pi-claude-cli`](https://github.com/agustinsacco/pi-claude-cli) (git remote `upstream`), forked at 0.10.0. See [Differences from upstream](#differences-from-upstream).

## Install

In pi's `settings.json`:

```json
{ "packages": ["git:github.com/dmmulroy/pi-claude-cli"] }
```

Pick a model under `pi-claude-cli` with `/model`.

Requires Node 22+, pi, and an authenticated `claude` binary on PATH (Claude Code 2.1.263+). Subscription credentials stay in the official CLI; no API key extraction.

## One owner: pi

- **Prompt:** pi's current system prompt replaces Claude Code's. A short suffix explains the MCP tool-name prefix. Project instructions, skills and `.pi` paths are unchanged; Claude does not independently discover any.
- **Tools:** only the current request's tools are advertised. Every tool, including read/edit/bash, executes in pi through the authenticated MCP bridge, so pi's tool hooks, schemas and complete results apply. The CLI has no native tools.
- **Conversation:** pi's history is authoritative. A warm Claude process is reused only while the history prefix it acknowledged and its launch configuration still match. Edits, compaction, provider changes, prompt changes or tool changes retire it, and the next call imports pi's current history into a fresh process.
- **Storage:** Claude processes run with `--no-session-persistence`. No Claude conversation file or resume pairing is written. Private temporary prompt and MCP files are removed when no longer needed; the runtime directory is removed on process exit. A SIGKILL can leave its private temporary directory behind.
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
| `PI_CLAUDE_CLI_HANDOFF_PROXY`    | on           | `0` interrupts the turn at each tool call instead of proxying it               |
| `PI_CLAUDE_CLI_THINKING_DISPLAY` | `summarized` | `omitted` returns no thinking summaries                                        |
| `MCP_TOOL_TIMEOUT`               | `3600000`    | CLI-side MCP call timeout                                                      |

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are never forwarded to the CLI: any of them would move it off the subscription login.

pi's thinking levels reach the model as the request pi's own Anthropic provider would send: `off` disables thinking, other levels send pi's budget or effort with thinking summaries. A level changed mid-session applies from the next turn without restarting the CLI.

## Differences from upstream

- **Single execution path.** Upstream's legacy "observer" mode is deleted: native Claude tools, `--resume` and the session-map sidecar, tool markers, sub-agent tracking, CLI-owned compaction, and the `PI_CLAUDE_CLI_CONTEXT`, `PI_CLAUDE_CLI_SYSTEM_PROMPT`, `PI_CLAUDE_CLI_AUTOCOMPACT`, `PI_CLAUDE_CLI_TOOL_RESULTS`, `PI_CLAUDE_CLI_HERMETIC`, `PI_CLAUDE_CLI_STRICT_MCP` and `PI_CLAUDE_CLI_EPHEMERAL` switches.
- **Tool schemas are content-addressed.** A concurrent tool-less request can no longer leave the main turn without tools ([upstream #49](https://github.com/agustinsacco/pi-claude-cli/issues/49)).
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
npm run test:coverage
npm run test:e2e
```

The opt-in real-CLI checks spend subscription tokens in a disposable workspace:

```bash
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts
```

## License

MIT
