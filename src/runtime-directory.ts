/**
 * The private per-runtime directory system prompts are staged in.
 *
 * `makeTempDirectoryScoped` creates it `0700` under a random name, so another
 * local user can neither guess the path nor traverse into it, and removes it
 * when the runtime is disposed. Files inside are still written `0600`.
 *
 * Building this service never fails: a failed layer build is remembered for
 * the life of the runtime, so a temp directory that cannot be created is
 * reported by each episode that needs it instead.
 */

import { rmSync } from "node:fs";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Result,
  Scope,
} from "effect";
import { RuntimeDirectoryError } from "./errors.ts";
import { nodeFileSystemLayer } from "./node-platform.ts";

/** Owner-only permissions for every file staged in the runtime directory. */
const RUNTIME_FILE_MODE = 0o600;

/** Defines the private runtime directory capability. */
export interface IRuntimeDirectory {
  /** Whether the directory was created when the runtime built. */
  readonly available: boolean;
  /**
   * Stage a system prompt as a file, removed when the scope closes. The CLI
   * reads it once at launch.
   *
   * @returns The file path, or `RuntimeDirectoryError` when the directory or
   *   the file cannot be written.
   */
  readonly stageSystemPrompt: (
    cliSessionId: string,
    prompt: string,
  ) => Effect.Effect<string, RuntimeDirectoryError, Scope.Scope>;
}

/** Provides the private runtime directory. */
export class RuntimeDirectory extends Context.Service<
  RuntimeDirectory,
  IRuntimeDirectory
>()("pi-claude-cli/RuntimeDirectory") {}

/**
 * Remove the directory when the process exits without the runtime having
 * been disposed. Effect finalizers cannot run in an `exit` handler, so this
 * last resort is synchronous. A SIGKILLed pi still leaves the directory.
 */
const removeOnProcessExit = (directory: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const remove = () => {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // Already gone, or not ours to remove.
        }
      };
      process.on("exit", remove);
      return remove;
    }),
    (remove) => Effect.sync(() => process.removeListener("exit", remove)),
  );

/** Constructs the runtime directory, creating it for the life of the scope. */
export const makeRuntimeDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const created = yield* fs
    .makeTempDirectoryScoped({ prefix: "pi-claude-" })
    .pipe(Effect.result);
  if (Result.isSuccess(created)) yield* removeOnProcessExit(created.success);

  return RuntimeDirectory.of({
    available: Result.isSuccess(created),
    stageSystemPrompt: Effect.fn("RuntimeDirectory.stageSystemPrompt")(
      function* (cliSessionId: string, prompt: string) {
        if (Result.isFailure(created))
          return yield* new RuntimeDirectoryError({
            operation: "CreateDirectory",
            message: `pi-claude-cli could not create its private temporary directory (${created.failure.message}). Check that the system temp directory exists and is writable, then start a new pi session.`,
          });
        const file = path.join(
          created.success,
          `system-prompt-${cliSessionId}.txt`,
        );
        yield* Effect.acquireRelease(
          fs.writeFileString(file, prompt, { mode: RUNTIME_FILE_MODE }),
          () => Effect.ignore(fs.remove(file, { force: true })),
        ).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              new RuntimeDirectoryError({
                operation: "StageSystemPrompt",
                message: `pi-claude-cli could not stage the system prompt for the Claude CLI (${error.message}).`,
              }),
            ),
          ),
        );
        yield* Effect.annotateCurrentSpan({ bytes: prompt.length });
        return file;
      },
    ),
  });
});

/** Provides the runtime directory without selecting a file system. */
export const runtimeDirectoryLayerWithoutDependencies = Layer.effect(
  RuntimeDirectory,
  makeRuntimeDirectory,
);

/** Provides the runtime directory on Node's file system. */
export const runtimeDirectoryLayer =
  runtimeDirectoryLayerWithoutDependencies.pipe(
    Layer.provide(nodeFileSystemLayer),
  );
