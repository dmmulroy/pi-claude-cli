/**
 * A `ChildProcessSpawner` over `cross-spawn`.
 *
 * Effect's Node spawner calls `child_process.spawn` directly, which cannot
 * launch `claude.cmd` on Windows, and `shell: true` is not a fix: it drops
 * empty arguments such as `--tools ""`. `cross-spawn` resolves the command
 * and quotes its arguments on Windows and is plain `spawn` elsewhere, so the
 * same code path runs on every platform.
 *
 * Only what this provider launches is supported: one command with piped or
 * inherited stdio. Pipelines and extra file descriptors are not.
 */

import type { ChildProcess as NodeChildProcess } from "node:child_process";
import * as NodeSink from "@effect/platform-node-shared/NodeSink";
import * as NodeStream from "@effect/platform-node-shared/NodeStream";
import {
  Deferred,
  Effect,
  Layer,
  Option,
  PlatformError,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import crossSpawn from "cross-spawn";

/** How a child process ended: its exit code, or the signal that killed it. */
interface ProcessEnd {
  readonly code: Option.Option<number>;
  readonly signal: Option.Option<NodeJS.Signals>;
}

const spawnError = (method: string, command: string, cause: unknown) =>
  PlatformError.systemError({
    _tag:
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? "NotFound"
        : "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const stdioMode = (
  option: ChildProcess.CommandOptions["stdin" | "stdout" | "stderr"],
): "pipe" | "inherit" | "ignore" =>
  option === "inherit" || option === "ignore" ? option : "pipe";

const stdinStream = (
  option: ChildProcess.CommandOptions["stdin"],
): Option.Option<Stream.Stream<Uint8Array, PlatformError.PlatformError>> => {
  if (Stream.isStream(option)) return Option.some(option);
  if (typeof option === "object" && Stream.isStream(option.stream))
    return Option.some(option.stream);
  return Option.none();
};

const outputStream = (
  command: string,
  name: "stdout" | "stderr",
  readable: NodeJS.ReadableStream | null,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  readable === null
    ? Stream.empty
    : NodeStream.fromReadable({
        evaluate: () => readable,
        onError: (cause) => spawnError(`fromReadable(${name})`, command, cause),
      });

const spawnStandardCommand = Effect.fnUntraced(function* (
  command: ChildProcess.StandardCommand,
) {
  const options = command.options;
  const [child, ended] = yield* Effect.acquireRelease(
    Effect.callback<
      readonly [NodeChildProcess, Deferred.Deferred<ProcessEnd>],
      PlatformError.PlatformError
    >((resume) => {
      const ended = Deferred.makeUnsafe<ProcessEnd>();
      const child = crossSpawn(command.command, [...command.args], {
        cwd: options.cwd,
        env: options.extendEnv
          ? { ...process.env, ...options.env }
          : options.env,
        stdio: [
          stdioMode(options.stdin),
          stdioMode(options.stdout),
          stdioMode(options.stderr),
        ],
        detached: options.detached ?? false,
        windowsHide: true,
      });
      child.on("error", (cause) =>
        resume(Effect.fail(spawnError("spawn", command.command, cause))),
      );
      child.on("exit", (code, signal) => {
        Deferred.doneUnsafe(
          ended,
          Effect.succeed({
            code: Option.fromNullOr(code),
            signal: Option.fromNullOr(signal),
          }),
        );
      });
      child.on("spawn", () => resume(Effect.succeed([child, ended])));
    }),
    // Whatever is still running when the scope closes is signalled, and the
    // scope waits for it to be gone.
    ([child, ended]) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(ended)) return;
        yield* Effect.sync(() => child.kill(options.killSignal ?? "SIGTERM"));
        yield* Deferred.await(ended);
      }),
  );

  const writable = child.stdin;
  const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> =
    writable === null
      ? Sink.drain
      : NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (cause) =>
            spawnError("fromWritable(stdin)", command.command, cause),
          endOnDone: true,
        });
  const input = stdinStream(options.stdin);
  if (Option.isSome(input))
    // A closed pipe ends the writer; the process's exit is reported by
    // `exitCode`, not by a failed write.
    yield* Stream.run(input.value, stdin).pipe(
      Effect.ignore,
      Effect.forkScoped,
    );

  const stdout = outputStream(command.command, "stdout", child.stdout);
  const stderr = outputStream(command.command, "stderr", child.stderr);
  const kill = (killOptions?: ChildProcess.KillOptions) =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(ended)) return;
      yield* Effect.sync(() =>
        child.kill(killOptions?.killSignal ?? options.killSignal ?? "SIGTERM"),
      );
      yield* Deferred.await(ended);
    });

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(child.pid ?? -1),
    exitCode: Effect.flatMap(Deferred.await(ended), (end) =>
      Option.match(end.code, {
        onSome: (code) => Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        onNone: () =>
          Effect.fail(
            spawnError(
              "exitCode",
              command.command,
              new Error(
                `Process ended by signal ${Option.getOrElse(end.signal, () => "unknown")}`,
              ),
            ),
          ),
      }),
    ),
    isRunning: Effect.map(Deferred.isDone(ended), (done) => !done),
    kill,
    stdin,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.sync(() => {
      child.unref();
      return Effect.sync(() => child.ref());
    }),
  });
});

/** Provides a `ChildProcessSpawner` that launches through `cross-spawn`. */
export const crossSpawnSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command)
      ? spawnStandardCommand(command)
      : Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "spawn",
            description: "Command pipelines are not supported by this spawner",
          }),
        ),
  ),
);
