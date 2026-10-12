# pi-claude-cli

Private fork of `agustinsacco/pi-claude-cli` (remote `upstream`). A pi provider that uses the official Claude Code CLI for subscription authentication and model access. No build step: pi loads `index.ts` and its TypeScript imports.

This fork has **one** execution path: pi owns the prompt, tools, conversation and compaction. Upstream's legacy "observer" path (native Claude tools, `--resume`, tool markers, sub-agent tracking, `PI_CLAUDE_CLI_CONTEXT`) is deleted here, so upstream changes touching it do not merge cleanly and usually should not be merged at all.

Read [README.md](README.md) and [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md) before changing behavior.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
npm run test:e2e
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts   # spends subscription tokens
```

Coverage floors: 92% lines/functions/statements, 85% branches.

## Architecture

- `index.ts`: register with both pi's provider composer and pi-ai's compatibility registry. Stage MCP tool schemas from the current request. Retire parked processes at lifecycle changes.
- `src/pi-context.ts`: normalize old/new pi context formats, import ordered messages and images, hash acknowledged history, bind MCP tool names.
- `src/provider.ts`: orchestrate one pi model call (an "episode"): reuse or spawn, stream events, hand tool calls to pi, park or retire, structured failures.
- `src/process-manager.ts`: launch flags/environment and subprocess primitives. Replaces Claude Code's prompt, disables native tools and session persistence, preserves explicit host guards and OAuth. Never use `--bare`.
- `src/cli-process.ts`: warm process and tool handoff lifecycle. One episode attached at a time.
- `src/handoff-broker.ts`, `src/mcp-schema-server.cjs`: schema-only MCP bridge. Execution always occurs in pi. Private per-process runtime directory, authenticated local requests, matched on the actual tool-use id and name.
- `src/mcp-config.ts`: content-addressed tool schema files and per-process `--mcp-config` files.
- `src/event-bridge.ts`: convert CLI stream events to pi messages. Content indexes restart each model cycle, so blocks are tracked by `(cycle, index)`.
- `src/thinking-config.ts`: pi thinking levels as CLI flags and live control requests.
- `src/cli-requirements.ts`: minimum supported CLI version.

## Invariants

1. pi owns the prompt, active tools, complete tool results and compaction. A Claude process is a disposable cache of pi's history, never a second conversation ledger.
2. A warm process may continue only when its acknowledged pi-history prefix and launch signature match. Anything else retires it and imports pi's current history into a fresh process.
3. Tool calls reach pi as real toolCall blocks; the CLI waits for the matching pi result. The CLI has no native tools.
4. Nothing is written to pi's status line or to conversation content except the model's own output.
5. CLI sessions do not persist. No transcript, no resume.
6. Preserve host/managed guards and official subscription authentication. Never extract OAuth tokens. Never forward `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` to the CLI.
7. Report errors as assistant error events and aborts as aborted. Never return a raw string where pi expects an assistant message.

## Conventions

ESM imports use `.js` specifiers for local TypeScript. The standalone MCP server is intentionally CommonJS. Tests live in `tests/`; `tests/live-*.test.ts` are opt-in and spend tokens.

## Installing a change

pi installs this package from git (`git:github.com/dmmulroy/pi-claude-cli` in `home/.pi/agent/settings.json` of the dotfiles repo). A change is live only after it is pushed and pi has updated the package.
