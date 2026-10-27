#!/usr/bin/env bash
# End-to-end smoke through a real `pi` binary using the deterministic Claude
# CLI stub — no credentials or network model calls needed.
#
# Exercises: extension load, provider + api-registry registration (the print
# mode path), subprocess spawn, stream-json
# NDJSON parsing, and the event bridge.
#
# Requires `pi` on PATH (npm i -g @earendil-works/pi-coding-agent).
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

STUB_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$WORK_DIR"' EXIT

cp "$EXT_DIR/tests/e2e/claude-stub.cjs" "$STUB_DIR/claude"
chmod +x "$STUB_DIR/claude"

# The provider traces by default; keep this run's records out of the user's
# own trace directory.
export XDG_STATE_HOME="$WORK_DIR/state"

echo "pi version: $(pi --version 2>/dev/null || true)"

# macOS has neither `timeout` nor `gtimeout` unless coreutils is installed, so
# the guard is best-effort: CI (Linux) gets the watchdog, a local run just runs.
# `${TIMEOUT[@]+...}` because bash 3.2 (macOS) treats an empty array as unbound
# under `set -u`.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout 120)
else
  TIMEOUT=()
fi
# `-ne` is load-bearing, not tidiness: a developer whose pi settings already
# list this package gets the INSTALLED copy discovered
# alongside `-e`, and the published provider wins the name. The suite then
# silently tests the release instead of the working tree — which is how a
# green run reported the exact bug it was written to catch.
run_pi() {
  # `</dev/null` because print mode still reads stdin: inherit a pipe that
  # never closes (a CI runner, an agent shell) and pi waits on EOF forever.
  cd "$WORK_DIR" && PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
    pi -ne -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" "$1" \
    </dev/null
}

OUT="$(run_pi "magic word")"

echo "--- pi output ---"
echo "$OUT"
echo "-----------------"

if ! grep -q "PORT-OK" <<<"$OUT"; then
  echo "e2e FAILED: expected PORT-OK in output" >&2
  exit 1
fi

# pi's thinking level must reach the CLI as the flags pi's own Anthropic
# provider would send: off as thinking disabled (pi passes no level for off),
# anything else as budget + effort + summaries.
ARGV_FILE="$WORK_DIR/argv.jsonl"
run_thinking() {
  : >"$ARGV_FILE"
  cd "$WORK_DIR" && CLAUDE_STUB_ARGV_FILE="$ARGV_FILE" PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
    pi -ne -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" --thinking "$1" "magic word" \
    </dev/null >/dev/null
  grep -- '--input-format' "$ARGV_FILE" | tail -1
}
OFF_ARGV="$(run_thinking off)"
HIGH_ARGV="$(run_thinking high)"
echo "--- thinking argv ---"
echo "off:  $OFF_ARGV"
echo "high: $HIGH_ARGV"
echo "---------------------"
if ! grep -q '"--thinking","disabled"' <<<"$OFF_ARGV" || grep -q -- '--effort' <<<"$OFF_ARGV"; then
  echo "e2e FAILED: pi's off did not reach the CLI as --thinking disabled" >&2
  exit 1
fi
if ! grep -q '"--max-thinking-tokens","16384","--effort","high","--thinking-display","summarized"' <<<"$HIGH_ARGV"; then
  echo "e2e FAILED: pi's high did not reach the CLI as budget 16384 + effort high + summaries" >&2
  exit 1
fi
echo "e2e OK"
