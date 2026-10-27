/**
 * pi's thinking level, translated into what Claude Code sends to the model.
 *
 * The contract is parity with pi's own Anthropic provider (pi-ai
 * `api/anthropic-messages.js`, `streamSimple`): the same level must reach the
 * model as the same request fields whichever path carries it. Claude Code
 * exposes two ways to set them, both verified on the wire through a logging
 * proxy on claude 2.1.283 and present since 2.1.263 (the pi-context floor):
 *
 * - spawn flags: `--thinking disabled`, `--max-thinking-tokens N`,
 *   `--effort X`, `--thinking-display D` (all hidden from `--help`);
 * - control requests on a live process: `set_max_thinking_tokens` and
 *   `apply_flag_settings {effortLevel}`. Each applies from the next user turn.
 *
 * One flag set serves every model. Budget-thinking models (Haiku 4.5, Opus
 * 4.5, Sonnet 4.5) read `--max-thinking-tokens` and ignore the effort;
 * adaptive models read the effort and treat any positive budget as "on". So
 * nothing here needs to know which kind a model is.
 *
 * Before 0.10.0 only `--effort` was ever passed. Budget models ignored it and
 * thought with the CLI's 31,999-token default at every level, pi's `off`
 * reached the CLI as no flag at all (so Sonnet 5 ran adaptive at effort
 * `high`), and adaptive models streamed no thinking text because the CLI's
 * default display is `omitted`.
 */

import type { ThinkingLevel, ThinkingBudgets, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Effort levels the CLI accepts, for `--effort` and `effortLevel`. */
export type CliEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** What the API returns for a thinking block: a summary, or nothing. */
export type ThinkingDisplay = "summarized" | "omitted";

/**
 * The thinking a CLI process runs with.
 *
 * - `default`: no flags; the CLI decides. Only for models whose thinking pi
 *   cannot turn off (`thinkingLevelMap.off === null`) when pi asks for none,
 *   which mirrors pi-ai sending no `thinking` field there.
 * - `disabled`: thinking off.
 * - `enabled`: a budget for budget models and an effort for adaptive ones.
 */
export type CliThinking =
  | { kind: "default" }
  | { kind: "disabled" }
  | {
      kind: "enabled";
      budgetTokens: number;
      effort: CliEffortLevel;
      display: ThinkingDisplay;
    };

/**
 * pi-ai's `DEFAULT_THINKING_BUDGETS` (api/simple-options.js). Duplicated so
 * the provider never deep-imports pi internals at runtime; a test pins it to
 * the installed pi-ai so drift fails CI rather than a session.
 */
export const PI_THINKING_BUDGETS: Required<
  Pick<ThinkingBudgets, "minimal" | "low" | "medium" | "high">
> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** The API rejects a thinking budget below this. */
const MIN_BUDGET_TOKENS = 1024;

/**
 * The display the CLI is asked for: summaries, as pi-ai sends. Billing
 * counts the full thinking either way, so showing it costs nothing.
 */
export function resolveThinkingDisplay(): ThinkingDisplay {
  return "summarized";
}

/** pi-ai `thinkingBudgetForLevel`: xhigh/max clamp to high, custom wins. */
function budgetForLevel(level: ThinkingLevel, custom?: ThinkingBudgets): number {
  const rung: keyof typeof PI_THINKING_BUDGETS =
    level === "minimal" || level === "low" || level === "medium" ? level : "high";
  const chosen = custom?.[rung];
  if (typeof chosen !== "number" || !Number.isFinite(chosen)) return PI_THINKING_BUDGETS[rung];
  return Math.max(MIN_BUDGET_TOKENS, Math.floor(chosen));
}

/** pi-ai `mapThinkingLevelToEffort`: the model's map first, then the ladder. */
function effortForLevel(level: ThinkingLevel, map?: ThinkingLevelMap | null): CliEffortLevel {
  const mapped = map?.[level];
  if (
    mapped === "low" ||
    mapped === "medium" ||
    mapped === "high" ||
    mapped === "xhigh" ||
    mapped === "max"
  )
    return mapped;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/**
 * The thinking pi wants for this call.
 *
 * `reasoning` is pi's level for the call; pi passes `undefined` for `off`.
 */
export function resolveCliThinking(
  model: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap | null },
  reasoning: ThinkingLevel | undefined,
  budgets?: ThinkingBudgets,
): CliThinking {
  if (!model.reasoning) return { kind: "default" };
  if (reasoning === undefined) {
    return model.thinkingLevelMap?.off === null ? { kind: "default" } : { kind: "disabled" };
  }
  return {
    kind: "enabled",
    budgetTokens: budgetForLevel(reasoning, budgets),
    effort: effortForLevel(reasoning, model.thinkingLevelMap),
    display: resolveThinkingDisplay(),
  };
}

/**
 * The thinking levels this provider offers for a model: pi's own map, minus
 * what the model does not have through Claude Code.
 *
 * One rung is removed: `minimal` on adaptive models. Those take an effort,
 * and the effort ladder starts at `low`, so `minimal` would send exactly the
 * request `low` sends. Budget models keep it, where it is a distinct
 * 1,024-token budget. Everything else is pi's catalogue as is, which was
 * checked against Claude Code's own per-model report (`initialize` ->
 * `models[].supportedEffortLevels`, claude 2.1.283): they agree on every
 * model, including xhigh missing on Opus/Sonnet 4.6 and `off` missing on the
 * Opus 5 family. The report's effort levels are not used at runtime because
 * they add nothing pi's map lacks and ignore `maxEffortLevel` limits. Its
 * model list is used, to pick which catalogue models the provider offers
 * (`src/account-models.ts`); it is Claude Code's picker for the account,
 * not an access check (Opus 4.5 and Sonnet 4.5 are absent from it and run
 * fine).
 */
export function cliThinkingLevelMap(model: {
  thinkingLevelMap?: ThinkingLevelMap | null;
  compat?: { forceAdaptiveThinking?: boolean } | null;
}): ThinkingLevelMap | undefined {
  const map = model.thinkingLevelMap ?? undefined;
  if (model.compat?.forceAdaptiveThinking !== true) return map;
  return { ...map, minimal: null };
}

/**
 * The provider-native thinking level a response ran at, for pi's
 * `providerThinkingLevel`: the effort, on an adaptive model with thinking on.
 * A budget model ignores the effort, so it has no level to report, and
 * neither does a response without thinking.
 *
 * `model` is this provider's registered model: adaptive ones are those whose
 * map `cliThinkingLevelMap` gave `minimal: null`.
 */
export function providerThinkingLevel(
  model: { thinkingLevelMap?: ThinkingLevelMap | null },
  thinking: CliThinking,
): CliEffortLevel | undefined {
  if (thinking.kind !== "enabled") return undefined;
  return model.thinkingLevelMap?.minimal === null ? thinking.effort : undefined;
}

/** CLI flags for a spawn that should start with `thinking`. */
export function thinkingSpawnArgs(thinking: CliThinking): string[] {
  switch (thinking.kind) {
    case "default":
      return [];
    case "disabled":
      return ["--thinking", "disabled"];
    case "enabled":
      return [
        "--max-thinking-tokens",
        String(thinking.budgetTokens),
        "--effort",
        thinking.effort,
        "--thinking-display",
        thinking.display,
      ];
  }
}

export function sameThinking(a: CliThinking, b: CliThinking): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "enabled" || b.kind !== "enabled") return true;
  return a.budgetTokens === b.budgetTokens && a.effort === b.effort && a.display === b.display;
}

/** The body of one control request (`request` in the CLI's envelope). */
export type ThinkingControl =
  | {
      subtype: "set_max_thinking_tokens";
      max_thinking_tokens: number;
      thinking_display?: ThinkingDisplay;
    }
  | {
      subtype: "apply_flag_settings";
      settings: { effortLevel: CliEffortLevel };
    };

/**
 * Control requests that move a live process from `applied` to `desired`, in
 * order, or `undefined` when only a fresh spawn can get there.
 *
 * `max_thinking_tokens` is always sent as a number: on 2.1.263 an omitted
 * value resets the budget to the spawn default, on 2.1.283 it leaves it as
 * is. The display rides on every re-enable because a process spawned with
 * thinking disabled has no display of its own to fall back to.
 *
 * Returning to `default` has no in-process spelling (it would mean "the flags
 * this process was never started with"), so it asks for a spawn. pi only
 * produces it for print-mode runs on models whose thinking cannot be off.
 */
export function thinkingControls(
  applied: CliThinking,
  desired: CliThinking,
): ThinkingControl[] | undefined {
  if (sameThinking(applied, desired)) return [];
  if (desired.kind === "default") return undefined;
  if (desired.kind === "disabled") {
    return [{ subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 }];
  }
  const controls: ThinkingControl[] = [];
  const wasEnabled = applied.kind === "enabled";
  if (
    !wasEnabled ||
    applied.budgetTokens !== desired.budgetTokens ||
    applied.display !== desired.display
  ) {
    controls.push({
      subtype: "set_max_thinking_tokens",
      max_thinking_tokens: desired.budgetTokens,
      thinking_display: desired.display,
    });
  }
  if (!wasEnabled || applied.effort !== desired.effort) {
    controls.push({
      subtype: "apply_flag_settings",
      settings: { effortLevel: desired.effort },
    });
  }
  return controls;
}
