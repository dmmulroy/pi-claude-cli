/**
 * Sample Effect program for the trace sink and CLI: one episode that
 * succeeds, one that fails, one that is interrupted, and one span left open.
 * Run by `scripts/scenarios/trace-sink.sh`.
 */

import { Effect, Fiber } from "effect";
import { tracingLayer } from "../../src/tracing.ts";

const spawn = Effect.fn("ClaudeCli.spawn")(function* (model: string) {
  yield* Effect.annotateCurrentSpan({ model, pid: 4242 });
  yield* Effect.logInfo("spawned");
  yield* Effect.sleep("15 millis");
});

const episode = (outcome: "done" | "error") =>
  Effect.gen(function* () {
    yield* spawn("haiku");
    yield* Effect.annotateCurrentSpan({ outcome });
    if (outcome === "error") return yield* Effect.fail("CliResultError");
  }).pipe(Effect.withSpan("episode", { attributes: { mode: "spawn" } }));

const program = Effect.gen(function* () {
  yield* episode("done");
  yield* Effect.exit(episode("error"));
  yield* Effect.never.pipe(
    Effect.withSpan("episode", { attributes: { mode: "turn" } }),
    Effect.timeoutOption("10 millis"),
  );
  if (process.argv.includes("--leak")) {
    // A span whose fiber is abandoned: started, never ended.
    const leaked = yield* Effect.never.pipe(Effect.withSpan("ClaudeProcess"), Effect.forkDetach);
    yield* Effect.sleep("5 millis");
    void Fiber.isFiber(leaked);
    process.exit(0);
  }
});

void Effect.runPromise(program.pipe(Effect.provide(tracingLayer)));
