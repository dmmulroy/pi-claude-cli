# pi-claude-cli

Use a Claude Pro/Max subscription from the [pi coding agent](https://github.com/earendil-works/pi). The official Claude Code CLI handles authentication and model access. pi owns the prompt, tools, conversation and compaction.

This is a fork of [`agustinsacco/pi-claude-cli`](https://github.com/agustinsacco/pi-claude-cli) (git remote `upstream`), forked at 0.10.0. See [Differences from upstream](#differences-from-upstream).

## Install

In pi's `settings.json`:

```json
{ "packages": ["git:github.com/dmmulroy/pi-claude-cli"] }
```

Pick a model under `pi-claude-cli` with `/model`.

Requires macOS or Linux, Node 22+, pi, and an authenticated `claude` binary on PATH (Claude Code 2.1.265+). Windows is not supported. Subscription credentials stay in the official CLI; no API key extraction.

Log in and out with Claude Code itself (`claude auth login`, `claude auth logout`); pi's `/login` only says so. pi offers the provider's models while `claude auth status` reports the CLI installed and not logged out, and labels their cost "(sub)" for a Pro or Max login. `/pi-claude-cli-status` asks the CLI again and says what it found. The answer is kept in `auth-status.json` under the state directory (installed, logged in, plan, when; no account details) and checked again in the background, so pi's start does not wait for the CLI. A too-old CLI is reported as an assistant error on the first model call.

## One owner: pi

- **Prompt:** pi's current system prompt replaces Claude Code's. A short suffix explains the MCP tool-name prefix. Project instructions, skills and `.pi` paths are unchanged; Claude does not independently discover any.
- **Tools:** only the current request's tools are advertised, through an MCP server the provider hosts in-band on the CLI's own stdio control channel. Every tool, including read/edit/bash, executes in pi, so pi's tool hooks, schemas and complete results apply. The CLI has no native tools, and there is no socket or helper process.
- **Conversation:** pi's history is authoritative. A warm Claude process is reused only while the history prefix it acknowledged and its launch configuration still match. Edits, compaction, provider changes, prompt changes or tool changes retire it, and the next call imports pi's current history into a fresh process.
- **Storage:** Claude processes run with `--no-session-persistence`. No Claude conversation file or resume pairing is written. The staged system prompt file is removed after the call that launched the process; the private runtime directory is removed when the pi session shuts down. A SIGKILL can leave that directory behind. [Traces](#traces) hold no conversation content.
- **Compaction:** pi compacts its own history. CLI auto-compaction is disabled.
- **Status line:** nothing is written to pi's footer.
- **pi's message:** besides the model's output, the assistant message records what pi's own Anthropic provider records: the API message id (`responseId`), the raw stop reason, the 1-hour share of the cache write and the thinking share of the output, and, on adaptive models, the effort (`providerThinkingLevel`). A `diagnostics` entry (`pi-claude-cli.rate-limit`) holds the subscription's latest limit status, and the signed thinking is kept under a `piClaudeCli` key (see below), not in `diagnostics`, which pi's bug report collects even when the session is left out. None of it is sent to the model.

## Cost of a fresh process

Ordinary follow-ups and tool calls keep the warm process and send only the new content. A fresh process (after the idle timeout, a model switch, a history edit, compaction or a pi restart) is handed pi's whole history.

**Structured import (the default):** the history goes in as the messages themselves: user messages that are added without asking the model, and assistant messages replayed as they were, with real `tool_use` and `tool_result` blocks in order, as pi's own Anthropic provider would send them. A tool call id Claude would reject (after a switch from another provider) is replaced on the wire by a stable valid one; pi's stored ids never change. Signed thinking goes back too: the provider stores Claude's raw thinking blocks on pi's assistant message (under `piClaudeCli`), and replays them with their signatures while the message is this provider's, the model is the one that signed them and the message's text and tool calls are unchanged. Thinking of an edited message, another model or another provider is replayed as plain text, never signed.

It relies on stdin behaviour Claude Code does not document. It was checked against the real API on 2.1.299 (`PI_OWNED_LIVE=1 npx vitest run tests/live-structured-import.test.ts tests/live-pi-roundtrip.test.ts`): signed thinking is accepted back and a history with another provider's turns and a compaction imports cleanly. On a CLI older than 2.1.292, and whenever the CLI does not confirm a held message, the provider falls back to the text import. `PI_CLAUDE_CLI_IMPORT=flat` always uses it: one user message of role-labelled text, with tool calls as records (`TOOL CALL <name> id=…`) and no thinking.

**No prompt cache across processes:** a fresh process pays for the whole history again, whichever import is used. Claude Code adds its startup reminders (environment, date) to the first user message it sends the model, which in a fresh process is the latest one rather than the first, so the request differs from the warm one from its first message on. This was measured, not assumed; the live test above reports the cache use. That is why a parked process waits an hour by default, as long as Claude Code's prompt cache lasts: each parked process holds roughly 500 MB while it waits.

See [the context contract](docs/CONTEXT-POLICY.md) for the details.

## Configuration

No environment variables are required.

| Variable                            | Default      | Purpose                                                                        |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`        | `3600000`    | Idle lifetime of a parked process; `0` parks nothing                           |
| `PI_CLAUDE_CLI_SETTINGS`            | unset        | Explicit Claude Code settings file (hooks, permissions) passed as `--settings` |
| `PI_CLAUDE_CLI_TIMEOUT_MS`          | `300000`     | Longest stdout silence while a call is attached; then an error and a kill      |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS`     | `1800000`    | Maximum wait for pi to answer a tool call                                      |
| `PI_CLAUDE_CLI_HANDOFF_PROXY`       | on           | `0` interrupts the turn at each tool call instead of holding it open           |
| `PI_CLAUDE_CLI_TRACE`               | daily file   | Trace file path, or `off`; see [Traces](#traces)                               |
| `PI_CLAUDE_CLI_TRACE_WIRE`          | counts       | `1` records one event per wire message; `raw` records raw lines, with content  |
| `PI_CLAUDE_CLI_THINKING_DISPLAY`    | `summarized` | `omitted` returns no thinking summaries                                        |
| `MCP_TOOL_TIMEOUT`                  | `3600000`    | CLI-side MCP call timeout                                                      |
| `PI_CLAUDE_CLI_MODELS`              | account      | `builtin` lists pi's whole Anthropic catalogue instead of the account's models |
| `PI_CLAUDE_CLI_IMPORT`              | `structured` | `flat` gives a fresh process the history as one text message; see above        |
| `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS` | unset        | `1` lets model calls be charged to usage credits; see below                    |

Variables that would move the CLI off the subscription login are never forwarded to it: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY` and the provider switches `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `CLAUDE_CODE_USE_ANTHROPIC_AWS`. Neither is a host's `CLAUDE_CODE_EXTRA_BODY`, which would change every request. A value that does not parse falls back to its default.

### Usage credits

Claude Code reports the subscription's limit status after API calls. When it says a call was charged to usage credits (formerly "extra usage") instead of plan limits, the call ends with an error that says so, and pi does not retry it: the call is paid for, but pi's agent loop makes no more. A status that arrives after a tool call was handed to pi stops the next call before the tool result is sent. Anthropic's own refusal to serve a request on plan limits ("third-party apps now draw from your extra usage") is reported the same way. `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1` lets the calls go on. The latest status is kept on each assistant message as the `pi-claude-cli.rate-limit` diagnostic.

pi's thinking levels reach the model as the request pi's own Anthropic provider would send: `off` disables thinking, other levels send pi's budget or effort with thinking summaries. A level changed mid-session applies from the next turn without restarting the CLI.

A changed tool list also reaches the live process: the in-band MCP server tells the CLI its tools changed, the CLI lists them again, and the model is offered the new list from its next request, including the one that follows an open tool call.

## Models

On pi 1.x the model list is the account's. Claude Code reports the models an account offers in its `initialize` handshake; the provider asks a short-lived CLI process for them (no model call, no tokens), keeps the ones pi's Anthropic catalogue knows with pi's own limits, cost and thinking levels, and adds any the catalogue does not know yet with conservative limits. pi persists the result, so a session starts from the stored list and the CLI is asked again when it is a day old or pi forces a refresh. Until the first refresh, when the CLI cannot be asked, and on pi before 1.x, the list is pi's whole Anthropic catalogue.

The CLI's list is its model picker for the account, not a hard access check: a model missing from it may still run. `PI_CLAUDE_CLI_MODELS=builtin` keeps the whole catalogue.

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
- **Subscription-override env vars are stripped** from the CLI's environment, other model providers' switches included.
- **Usage-credit guard**, refusals reported as errors, a check of each streamed message against the CLI's own record of it, and an auth check that hides the models when the CLI is missing or logged out.
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
PI_OWNED_LIVE=1 npx vitest run tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts tests/live-structured-import.test.ts
```

## License

MIT
