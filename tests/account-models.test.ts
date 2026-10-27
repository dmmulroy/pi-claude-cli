import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ACCOUNT_MODELS_TTL_MILLIS,
  accountModelIds,
  builtinProviderModels,
  type CatalogueModel,
  type CliAccountModel,
  cliVersionTag,
  createModelRefresh,
  isAccountModelsFresh,
  type ModelRefreshContext,
  providerModelsForAccount,
  providerModelsFromStore,
} from "../src/account-models";
import { accountModelsFromLine, initializeRequestLine, probeEnvironment } from "../src/model-probe";

const cost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const catalogueModel = (id: string, overrides: Partial<CatalogueModel> = {}): CatalogueModel => ({
  id,
  name: id.toUpperCase(),
  reasoning: true,
  input: ["text", "image"],
  cost,
  contextWindow: 200_000,
  maxTokens: 64_000,
  ...overrides,
});

const catalogue: CatalogueModel[] = [
  catalogueModel("claude-haiku-4-5"),
  catalogueModel("claude-haiku-4-5-20251001"),
  catalogueModel("claude-opus-4-5"),
  catalogueModel("claude-opus-5-5", {
    contextWindow: 1_000_000,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
    compat: { forceAdaptiveThinking: true },
  }),
  catalogueModel("claude-sonnet-5"),
];

/** The shape Claude Code 2.1.292 answers `initialize` with. */
const account: CliAccountModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    supportsEffort: true,
  },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
  },
  {
    value: "claude-sonnet-5",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
  },
];

const ids = (models: ReadonlyArray<{ id: string }> | undefined) => models?.map((model) => model.id);

describe("accountModelIds", () => {
  it("resolves aliases to model ids, once each, in the CLI's order", () => {
    expect(accountModelIds(account)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
    ]);
  });

  it("drops Claude Code's context-window marker", () => {
    expect(
      accountModelIds([
        { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1" },
        { value: "claude-fable-5[1m]" },
      ]),
    ).toEqual(["claude-fable-5-1", "claude-fable-5"]);
  });

  it("ignores an alias the CLI did not resolve", () => {
    expect(accountModelIds([{ value: "opus" }, { value: "default" }])).toEqual([]);
  });
});

describe("providerModelsForAccount", () => {
  it("keeps the catalogue models the account offers, with pi's metadata", () => {
    const models = providerModelsForAccount(catalogue, account);
    expect(ids(models)).toEqual([
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]);
    const opus = models?.find((model) => model.id === "claude-opus-5-5");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.cost).toEqual(cost);
    // An adaptive model loses `minimal`, as in the built-in list.
    expect(opus?.thinkingLevelMap).toEqual({
      minimal: null,
      xhigh: "xhigh",
    });
  });

  it("leaves out catalogue models the account does not offer", () => {
    expect(ids(providerModelsForAccount(catalogue, account))).not.toContain("claude-opus-4-5");
  });

  it("matches a dated snapshot in either direction", () => {
    expect(
      ids(
        providerModelsForAccount(catalogue, [
          { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5" },
        ]),
      ),
    ).toEqual(["claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
  });

  it("adds an account model pi's catalogue does not know yet", () => {
    const models = providerModelsForAccount(catalogue, [
      ...account,
      {
        value: "claude-nova-9[1m]",
        resolvedModel: "claude-nova-9[1m]",
        displayName: "Nova 9",
        supportsAdaptiveThinking: true,
      },
      { value: "newest", resolvedModel: "claude-zeta-1" },
    ]);
    expect(models?.slice(-2)).toEqual([
      {
        id: "claude-nova-9",
        name: "Nova 9",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 32_000,
      },
      {
        id: "claude-zeta-1",
        // An alias's display name describes the alias, not the model.
        name: "claude-zeta-1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ]);
  });

  it("returns nothing for an account list that names no model", () => {
    expect(providerModelsForAccount(catalogue, [])).toBeUndefined();
    expect(providerModelsForAccount(catalogue, [{ value: "default" }])).toBeUndefined();
  });

  it("covers the real catalogue: every account model there is found", () => {
    const builtin = getBuiltinModels("anthropic");
    const models = providerModelsForAccount(builtin, [
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
    expect(ids(models)).toContain("claude-haiku-4-5");
    expect(models!.length).toBeLessThan(builtin.length);
  });
});

describe("providerModelsFromStore", () => {
  it("rebuilds stored ids from today's catalogue", () => {
    const stored = {
      models: [
        // Stale limits: the catalogue's win.
        {
          ...catalogueModel("claude-sonnet-5"),
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
    };
    expect(providerModelsFromStore(catalogue, stored)).toEqual([
      {
        id: "claude-sonnet-5",
        name: "CLAUDE-SONNET-5",
        reasoning: true,
        input: ["text", "image"],
        cost,
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ]);
  });

  it("keeps a stored model the catalogue does not list, when complete", () => {
    const unknown = catalogueModel("claude-nova-9");
    expect(ids(providerModelsFromStore(catalogue, { models: [unknown] }))).toEqual([
      "claude-nova-9",
    ]);
  });

  it("drops entries that are not models", () => {
    expect(
      providerModelsFromStore(catalogue, {
        models: [
          null,
          "claude-sonnet-5",
          { id: "claude-nova-9" },
          { ...catalogueModel("claude-nova-8"), input: ["audio"] },
          { ...catalogueModel("claude-nova-7"), cost: { input: "1" } },
        ],
      }),
    ).toBeUndefined();
    expect(providerModelsFromStore(catalogue, undefined)).toBeUndefined();
    expect(providerModelsFromStore(catalogue, { models: [] })).toBeUndefined();
  });
});

describe("isAccountModelsFresh", () => {
  const now = 1_800_000_000_000;
  it("is fresh within a day of the last check", () => {
    expect(isAccountModelsFresh({ checkedAt: now - 1000 }, now)).toBe(true);
    expect(isAccountModelsFresh({ checkedAt: now - ACCOUNT_MODELS_TTL_MILLIS }, now)).toBe(false);
  });
  it("is stale without a check time, or with one from the future", () => {
    expect(isAccountModelsFresh(undefined, now)).toBe(false);
    expect(isAccountModelsFresh({}, now)).toBe(false);
    expect(isAccountModelsFresh({ checkedAt: now + 60_000 }, now)).toBe(false);
  });
});

describe("createModelRefresh", () => {
  const now = 1_800_000_000_000;
  const VERSION = "2.1.299";
  const builtinIds = ids(builtinProviderModels(catalogue));
  const accountIds = ids(providerModelsForAccount(catalogue, account));

  /** A CLI of `version` reporting `models`; both calls are spies. */
  const cli = (
    models: () => Promise<ReadonlyArray<CliAccountModel>> = async () => account,
    version: string | undefined = VERSION,
  ) => ({
    version: vi.fn(async () => version),
    models: vi.fn(models),
  });

  const context = (overrides: Partial<ModelRefreshContext> = {}) => {
    const publish = vi.fn<ModelRefreshContext["publish"]>(async () => true);
    const ctx: ModelRefreshContext = {
      allowNetwork: true,
      signal: new AbortController().signal,
      publish,
      ...overrides,
    };
    return Object.assign(ctx, { publish });
  };
  const storedModel: Model<Api> = {
    id: "claude-sonnet-5",
    name: "stored",
    api: "pi-claude-cli",
    provider: "pi-claude-cli",
    baseUrl: "pi-claude-cli",
    reasoning: true,
    input: ["text", "image"],
    cost,
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
  const storedEntry = (checkedAt: number, version = VERSION) => ({
    checkedAt,
    etag: cliVersionTag(version),
    models: [storedModel],
  });

  it("asks the CLI, persists the account's models and returns them", async () => {
    const probe = cli();
    const ctx = context();
    const models = await createModelRefresh(catalogue, probe, () => now)(ctx);

    expect(ids(models)).toEqual(accountIds);
    expect(probe.models).toHaveBeenCalledWith(ctx.signal);
    expect(ctx.publish).toHaveBeenCalledTimes(1);
    const persist = ctx.publish.mock.calls[0][0].persist;
    expect(persist?.checkedAt).toBe(now);
    expect(persist?.etag).toBe("claude-code/2.1.299");
    expect(ids(persist?.models)).toEqual(accountIds);
    expect(persist?.models[0]).toMatchObject({
      api: "pi-claude-cli",
      provider: "pi-claude-cli",
    });
  });

  it("never launches the CLI when pi forbids network access", async () => {
    const probe = cli();
    const refresh = createModelRefresh(catalogue, probe, () => now);

    expect(ids(await refresh(context({ allowNetwork: false })))).toEqual(builtinIds);
    expect(
      ids(await refresh(context({ allowNetwork: false, stored: storedEntry(now - 1) }))),
    ).toEqual(["claude-sonnet-5"]);
    expect(probe.version).not.toHaveBeenCalled();
    expect(probe.models).not.toHaveBeenCalled();
  });

  it("serves a fresh stored list from the same CLI without asking for models", async () => {
    const probe = cli();
    const ctx = context({ stored: storedEntry(now - 60_000) });
    const models = await createModelRefresh(catalogue, probe, () => now)(ctx);

    expect(ids(models)).toEqual(["claude-sonnet-5"]);
    expect(probe.models).not.toHaveBeenCalled();
    expect(ctx.publish).not.toHaveBeenCalled();
  });

  it("asks again when the CLI was updated, even within the day", async () => {
    // The list from 2.1.292 lacks Haiku 5.5; 2.1.299 has it.
    const probe = cli();
    const ctx = context({ stored: storedEntry(now - 60_000, "2.1.292") });
    await createModelRefresh(catalogue, probe, () => now)(ctx);
    expect(probe.models).toHaveBeenCalledTimes(1);
    expect(ctx.publish.mock.calls[0][0].persist?.etag).toBe("claude-code/2.1.299");
  });

  it("asks again for a list stored without a CLI version", async () => {
    const probe = cli();
    const { etag: _, ...unversioned } = storedEntry(now - 60_000);
    await createModelRefresh(catalogue, probe, () => now)(context({ stored: unversioned }));
    expect(probe.models).toHaveBeenCalledTimes(1);
  });

  it("asks again when the stored list is a day old, or pi forces it", async () => {
    const probe = cli();
    const refresh = createModelRefresh(catalogue, probe, () => now);

    await refresh(context({ stored: storedEntry(now - ACCOUNT_MODELS_TTL_MILLIS - 1) }));
    await refresh(context({ stored: storedEntry(now - 1), force: true }));
    expect(probe.models).toHaveBeenCalledTimes(2);
  });

  it("falls back to the built-in catalogue when the CLI cannot be asked", async () => {
    const missing = { ...cli(), version: vi.fn(async () => undefined) };
    const failing = cli(async () => {
      throw new Error("spawn claude ENOENT");
    });
    const empty = cli(async () => []);

    for (const probe of [missing, failing, empty]) {
      const ctx = context();
      const refresh = createModelRefresh(catalogue, probe, () => now);
      expect(ids(await refresh(ctx))).toEqual(builtinIds);
      expect(ctx.publish).not.toHaveBeenCalled();
    }
    expect(missing.models).not.toHaveBeenCalled();
  });

  it("prefers a stale stored list to the catalogue when the CLI fails", async () => {
    const refresh = createModelRefresh(
      catalogue,
      cli(async () => []),
      () => now,
    );
    const models = await refresh(context({ stored: storedEntry(1) }));
    expect(ids(models)).toEqual(["claude-sonnet-5"]);
  });
});

describe("the model probe's protocol", () => {
  it("asks with one initialize control request", () => {
    expect(JSON.parse(initializeRequestLine())).toEqual({
      type: "control_request",
      request_id: "pcc-models",
      request: { subtype: "initialize" },
    });
    expect(initializeRequestLine().endsWith("\n")).toBe(true);
  });

  it("reads the models from the matching response", () => {
    const line = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "pcc-models",
        response: {
          account: { subscriptionType: "Claude Max" },
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5-5",
              displayName: "Default (recommended)",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
            },
          ],
        },
      },
    });
    expect(Option.getOrThrow(accountModelsFromLine(line))).toEqual([
      {
        value: "default",
        resolvedModel: "claude-opus-5-5",
        displayName: "Default (recommended)",
        supportsEffort: true,
      },
    ]);
  });

  it("ignores every other line", () => {
    const other = (response: object) => JSON.stringify({ type: "control_response", response });
    expect(Option.isNone(accountModelsFromLine("not json"))).toBe(true);
    expect(Option.isNone(accountModelsFromLine('{"type":"system","subtype":"init"}'))).toBe(true);
    expect(
      Option.isNone(
        accountModelsFromLine(other({ subtype: "success", request_id: "someone-else" })),
      ),
    ).toBe(true);
  });

  it("reads a refusal or a response without models as no models", () => {
    const refused = JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: "pcc-models", error: "no" },
    });
    const bare = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "pcc-models", response: {} },
    });
    expect(Option.getOrThrow(accountModelsFromLine(refused))).toEqual([]);
    expect(Option.getOrThrow(accountModelsFromLine(bare))).toEqual([]);
  });

  it("keeps the subscription login and leaves feature flags on", () => {
    const env = probeEnvironment();
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      expect(name in env).toBe(true);
      expect(env[name]).toBeUndefined();
    }
    expect("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in env).toBe(false);
  });
});
