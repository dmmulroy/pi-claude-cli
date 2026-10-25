/**
 * Scenario: asking the CLI which models the account offers.
 *
 * Runs the real probe against the stub CLI (first on PATH) and checks what
 * a trace cannot show: the models that came back, that the probe's process
 * saw no variable that would move it off the subscription, and that a
 * missing CLI is an empty answer rather than a failure.
 */

import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import { Config, Console, Data, Effect, FileSystem, Path } from "effect";
import { accountModelIds } from "../../src/account-models.ts";
import { probeAccountModels, probeCliVersion } from "../../src/model-probe.ts";
import { nodeFileSystemLayer } from "../../src/node-platform.ts";

class ModelProbeCheckFailed extends Data.TaggedError("ModelProbeCheckFailed")<{
  readonly message: string;
}> {}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ModelProbeCheckFailed({ message }));

const probe = Effect.promise(() => probeAccountModels(new AbortController().signal));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* Config.String("SCENARIO_TMP");

  const ids = accountModelIds(yield* probe);
  yield* Console.log(`  account models: ${ids.join(", ")}`);
  yield* check(
    ids.join(",") === "claude-sonnet-5,claude-haiku-4-5-20251001",
    `expected the stub's two models, got ${ids.join(",")}`,
  );

  const version = yield* Effect.promise(() => probeCliVersion(new AbortController().signal));
  yield* check(version === "9.9.9", `expected the stub's version, got ${version}`);

  const seen = yield* fs.readFileString(path.join(work, "env.json"));
  yield* check(
    seen.includes('"anthropic":[]'),
    `expected no ANTHROPIC_* variables in the probe's environment, got ${seen}`,
  );
  // Feature flags decide which models the CLI lists, so the probe keeps them.
  yield* check(
    seen.includes('"disableNonessentialTraffic":null'),
    `expected the probe to leave feature-flag fetching on, got ${seen}`,
  );

  // No `claude` anywhere: an empty answer, and the caller keeps its list.
  const empty = yield* fs.makeTempDirectoryScoped({ prefix: "pi-claude-" });
  yield* Effect.sync(() => {
    process.env.PATH = empty;
  });
  const missing = yield* probe;
  const noVersion = yield* Effect.promise(() => probeCliVersion(new AbortController().signal));
  yield* check(noVersion === undefined, `expected no version without a CLI, got ${noVersion}`);
  yield* check(missing.length === 0, `expected no models without a CLI, got ${missing.length}`);
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(nodeFileSystemLayer)));
