/**
 * Scenario: the trace sink's default location.
 *
 * Runs the sample program three ways under a throwaway state directory and
 * checks what lands on disk: with `PI_CLAUDE_CLI_TRACE` unset the sink writes
 * a private daily file and prunes files past the retention window, the trace
 * CLI finds that file with no `--file`, and `PI_CLAUDE_CLI_TRACE=off` writes
 * nothing.
 */

import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { crossSpawnSpawnerLayer } from "../../src/cross-spawn-spawner.ts";
import { nodeFileSystemLayer } from "../../src/node-platform.ts";
import {
  dailyTraceFileName,
  TRACE_DIRECTORY_MODE,
  TRACE_FILE_MODE,
  TRACE_RETENTION_DAYS,
} from "../../src/trace-location.ts";

class TraceLocationCheckFailed extends Data.TaggedError(
  "TraceLocationCheckFailed",
)<{ readonly message: string }> {}

const check = (condition: boolean, message: string) =>
  condition
    ? Effect.void
    : Effect.fail(new TraceLocationCheckFailed({ message }));

const MILLIS_PER_DAY = 86_400_000;
const PERMISSION_BITS = 0o777;

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scripts = path.resolve(import.meta.dirname, "..");
  const stateHome = yield* fs.makeTempDirectoryScoped({
    prefix: "pi-claude-trace-default-",
  });
  const traces = path.join(stateHome, "pi-claude-cli", "traces");
  const today = path.join(traces, dailyTraceFileName(Date.now()));

  /** Run a script with this scenario's state directory; `trace` picks the sink. */
  const run = (script: string, args: ReadonlyArray<string>, trace?: string) =>
    spawner.exitCode(
      ChildProcess.make(process.execPath, [script, ...args], {
        extendEnv: true,
        env: { XDG_STATE_HOME: stateHome, PI_CLAUDE_CLI_TRACE: trace },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        detached: false,
      }),
    );
  const sample = path.join(scripts, "scenarios", "trace-sample.ts");

  // Off: nothing is written, not even the directory.
  yield* run(sample, [], "off");
  yield* check(
    !(yield* fs.exists(traces)),
    "PI_CLAUDE_CLI_TRACE=off still created the trace directory",
  );

  // Unset: a private daily file.
  yield* run(sample, []);
  yield* check(yield* fs.exists(today), `expected a daily file at ${today}`);
  const fileMode = (yield* fs.stat(today)).mode & PERMISSION_BITS;
  const directoryMode = (yield* fs.stat(traces)).mode & PERMISSION_BITS;
  yield* check(
    fileMode === TRACE_FILE_MODE,
    `expected the trace file to be 0600, found 0${fileMode.toString(8)}`,
  );
  yield* check(
    directoryMode === TRACE_DIRECTORY_MODE,
    `expected the trace directory to be 0700, found 0${directoryMode.toString(8)}`,
  );

  // The trace CLI reads that file when given no --file.
  const asserted = yield* run(path.join(scripts, "trace.ts"), [
    "assert",
    "--quiet",
    "--name",
    "episode",
    "--count",
    "3",
  ]);
  yield* check(
    Number(asserted) === 0,
    "`trace assert` with no --file did not find the default daily file",
  );

  // Files past the retention window are pruned when the next runtime builds;
  // newer ones are kept.
  const expired = path.join(traces, "2001-01-01.ndjson");
  const recent = path.join(traces, "2001-01-02.ndjson");
  const longAgo = Date.now() - (TRACE_RETENTION_DAYS + 1) * MILLIS_PER_DAY;
  const yesterday = Date.now() - MILLIS_PER_DAY;
  yield* fs.writeFileString(expired, "");
  yield* fs.utimes(expired, longAgo / 1000, longAgo / 1000);
  yield* fs.writeFileString(recent, "");
  yield* fs.utimes(recent, yesterday / 1000, yesterday / 1000);
  yield* run(sample, []);
  yield* check(
    !(yield* fs.exists(expired)),
    `expected a trace file older than ${TRACE_RETENTION_DAYS} days to be pruned`,
  );
  yield* check(
    yield* fs.exists(recent),
    "a trace file inside the retention window was pruned",
  );
  yield* Console.log("trace default location ok");
}).pipe(
  Effect.scoped,
  Effect.tapError((error) =>
    Console.error(`scenario FAILED: ${error.message}`),
  ),
  Effect.provide(Layer.merge(nodeFileSystemLayer, crossSpawnSpawnerLayer)),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
