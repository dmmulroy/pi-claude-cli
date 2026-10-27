/**
 * The provider's model list, generated from what the Claude account offers.
 *
 * Claude Code reports the account's models in the response to an
 * `initialize` control request (`models[]`: a picker value, the id it
 * resolves to and a display name). That list is joined with pi's Anthropic
 * catalogue, which owns everything pi needs and the CLI does not report:
 * context window, output limit, cost and thinking levels.
 *
 * Pure and free of Effect imports: `index.ts` loads this at pi start. The
 * probe that asks the CLI lives in `src/model-probe.ts` and is loaded only
 * when a refresh actually needs it.
 */

import type { Api, Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { cliThinkingLevelMap } from "./thinking-config.ts";

/** One entry of `models[]` in the CLI's `initialize` response. */
export interface CliAccountModel {
  /** What the CLI's picker passes to `--model`: an alias or a model id. */
  readonly value: string;
  /** The model id the value resolves to for this account. */
  readonly resolvedModel?: string | undefined;
  readonly displayName?: string | undefined;
  readonly supportsEffort?: boolean | undefined;
  readonly supportsAdaptiveThinking?: boolean | undefined;
}

/** A model of pi's Anthropic catalogue, as far as this module reads it. */
export type CatalogueModel = Pick<
  Model<Api>,
  "id" | "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
> & {
  readonly thinkingLevelMap?: ThinkingLevelMap | null;
  readonly compat?: { forceAdaptiveThinking?: boolean } | null;
};

/** One model as the provider registers it with pi. */
export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
}

/** How long a probed account list is served before the CLI is asked again. */
export const ACCOUNT_MODELS_TTL_MILLIS = 24 * 60 * 60 * 1000;

/** Claude Code's context-window marker on a model id: `claude-fable-5-1[1m]`. */
const CONTEXT_MARKER = /\[([^\]]*)\]$/;
/** A dated snapshot suffix: `claude-haiku-4-5-20251001`. */
const SNAPSHOT_DATE = /-\d{8}$/;

const withoutContextMarker = (id: string): string => id.replace(CONTEXT_MARKER, "");
const withoutSnapshotDate = (id: string): string => id.replace(SNAPSHOT_DATE, "");

/** The model id one picker entry stands for, or undefined for a bare alias. */
function accountModelId(model: CliAccountModel): string | undefined {
  const id = withoutContextMarker(model.resolvedModel ?? model.value).trim();
  return id.startsWith("claude-") ? id : undefined;
}

/** The distinct model ids the account offers, in the CLI's order. */
export function accountModelIds(account: ReadonlyArray<CliAccountModel>): string[] {
  const ids = new Set<string>();
  for (const model of account) {
    const id = accountModelId(model);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** pi's catalogue entry in the shape the provider registers. */
function fromCatalogue(model: CatalogueModel): ProviderModel {
  const thinkingLevelMap = cliThinkingLevelMap(model);
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // pi's own per-model map, less `minimal` on adaptive models (it would
    // send what `low` sends), so the selector offers only levels the model
    // has, and each maps to the effort pi uses.
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
  };
}

/** Every model of pi's catalogue: the list used when the account's is unknown. */
export function builtinProviderModels(catalogue: ReadonlyArray<CatalogueModel>): ProviderModel[] {
  return catalogue.map(fromCatalogue);
}

const SUBSCRIPTION_COST: Model<Api>["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * A model the account offers and pi's catalogue does not know yet. Limits
 * are the conservative ones every current Claude model meets; the entry is
 * replaced by pi's own as soon as its catalogue lists the model.
 */
function unknownToCatalogue(id: string, entry: CliAccountModel): ProviderModel {
  const marker = CONTEXT_MARKER.exec(entry.resolvedModel ?? entry.value)?.[1];
  const isAlias = withoutContextMarker(entry.value) !== id;
  return {
    id,
    name: isAlias || entry.displayName === undefined ? id : entry.displayName,
    reasoning: entry.supportsEffort === true || entry.supportsAdaptiveThinking === true,
    input: ["text", "image"],
    cost: SUBSCRIPTION_COST,
    contextWindow: marker?.toLowerCase() === "1m" ? 1_000_000 : 200_000,
    maxTokens: 32_000,
  };
}

/**
 * The provider's models for an account: every catalogue model the account
 * offers, in catalogue order, then the account's models pi does not know.
 *
 * A catalogue model matches an account model when the ids are equal apart
 * from a snapshot date, so an account that reports `claude-haiku-4-5-20251001`
 * keeps pi's `claude-haiku-4-5` as well.
 *
 * @returns undefined when the account list names no model, so the caller
 *   keeps the list it had.
 */
export function providerModelsForAccount(
  catalogue: ReadonlyArray<CatalogueModel>,
  account: ReadonlyArray<CliAccountModel>,
): ProviderModel[] | undefined {
  const ids = accountModelIds(account);
  if (ids.length === 0) return undefined;
  const offered = new Set(ids.map(withoutSnapshotDate));
  const known = catalogue.filter((model) => offered.has(withoutSnapshotDate(model.id)));
  const knownFamilies = new Set(known.map((model) => withoutSnapshotDate(model.id)));
  const unknown = ids
    .filter((id) => !knownFamilies.has(withoutSnapshotDate(id)))
    .map((id) => {
      const entry = account.find((model) => accountModelId(model) === id);
      return unknownToCatalogue(id, entry ?? { value: id });
    });
  return [...known.map(fromCatalogue), ...unknown];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isModelInput = (value: unknown): value is ("text" | "image")[] =>
  Array.isArray(value) && value.every((each) => each === "text" || each === "image");

const isModelCost = (value: unknown): value is Model<Api>["cost"] =>
  isRecord(value) &&
  ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof value[key] === "number");

/** A persisted model pi's catalogue does not list, if it is still complete. */
function fromStored(stored: unknown): ProviderModel | undefined {
  if (!isRecord(stored)) return undefined;
  const { id, name, reasoning, input, cost, contextWindow, maxTokens } = stored;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof reasoning !== "boolean" ||
    !isModelInput(input) ||
    !isModelCost(cost) ||
    typeof contextWindow !== "number" ||
    typeof maxTokens !== "number"
  )
    return undefined;
  return { id, name, reasoning, input, cost, contextWindow, maxTokens };
}

/**
 * The account's models as persisted by an earlier refresh. Only the ids are
 * trusted: each one is looked up in today's catalogue, so a pi update that
 * changes a model's limits or cost applies to a cached list too.
 *
 * @returns undefined when nothing usable is stored.
 */
export function providerModelsFromStore(
  catalogue: ReadonlyArray<CatalogueModel>,
  stored: { readonly models: ReadonlyArray<unknown> } | undefined,
): ProviderModel[] | undefined {
  if (stored === undefined) return undefined;
  const byId = new Map(catalogue.map((model) => [model.id, model]));
  const models = stored.models.flatMap((entry) => {
    const id = isRecord(entry) ? entry.id : undefined;
    const current = typeof id === "string" ? byId.get(id) : undefined;
    const model = current === undefined ? fromStored(entry) : fromCatalogue(current);
    return model === undefined ? [] : [model];
  });
  return models.length > 0 ? models : undefined;
}

/** True while a stored list is recent enough to serve without asking the CLI. */
export function isAccountModelsFresh(
  stored: { readonly checkedAt?: number | undefined } | undefined,
  nowMillis: number,
): boolean {
  const checkedAt = stored?.checkedAt;
  return (
    typeof checkedAt === "number" &&
    nowMillis >= checkedAt &&
    nowMillis - checkedAt < ACCOUNT_MODELS_TTL_MILLIS
  );
}

/** The provider, api and base-url id the persisted models are recorded under. */
const PROVIDER_ID = "pi-claude-cli";

/** What a model refresh needs from pi; a subset, so tests can supply it. */
export type ModelRefreshContext = Pick<
  RefreshModelsContext,
  "allowNetwork" | "force" | "signal" | "stored" | "publish"
>;

/** What a refresh asks the installed CLI. */
export interface AccountModelsProbe {
  /** The CLI's version, or undefined when there is no usable CLI. */
  readonly version: (signal: AbortSignal) => Promise<string | undefined>;
  /** The models the account offers, as the CLI reports them. */
  readonly models: (signal: AbortSignal) => Promise<ReadonlyArray<CliAccountModel>>;
}

/**
 * What the stored list records about the CLI that produced it, in the store's
 * `etag` field. The CLI's list depends on its version (Haiku 5.5 is listed
 * from Claude Code 2.1.293 on), so a different version means a stale list.
 */
export const cliVersionTag = (version: string): string => `claude-code/${version}`;

/**
 * Build the provider's `refreshModels` for pi 1.x.
 *
 * The list is the account's, as the CLI reports it, joined with pi's
 * catalogue. pi persists it, so a session starts from the stored list
 * without launching anything. The CLI is asked again once the stored list is
 * a day old, the installed CLI is not the version that produced it, or pi
 * forces a refresh. Whenever the CLI cannot be asked or names no model, the
 * stored list is kept, and without one the whole built-in catalogue is.
 */
export function createModelRefresh(
  catalogue: ReadonlyArray<CatalogueModel>,
  probe: AccountModelsProbe,
  now: () => number = Date.now,
): (context: ModelRefreshContext) => Promise<ProviderModel[]> {
  return async (context) => {
    const stored = providerModelsFromStore(catalogue, context.stored);
    const fallback = stored ?? builtinProviderModels(catalogue);
    if (!context.allowNetwork) return fallback;
    try {
      const version = await probe.version(context.signal);
      // No CLI to ask; a call would report the missing CLI itself.
      if (version === undefined) return fallback;
      const tag = cliVersionTag(version);
      if (
        stored !== undefined &&
        context.force !== true &&
        context.stored?.etag === tag &&
        isAccountModelsFresh(context.stored, now())
      )
        return stored;
      const models = providerModelsForAccount(catalogue, await probe.models(context.signal));
      if (models === undefined) return fallback;
      await context.publish({
        persist: {
          models: models.map((model) => ({
            ...model,
            api: PROVIDER_ID,
            provider: PROVIDER_ID,
            baseUrl: PROVIDER_ID,
          })),
          checkedAt: now(),
          etag: tag,
        },
      });
      return models;
    } catch {
      return fallback;
    }
  };
}
