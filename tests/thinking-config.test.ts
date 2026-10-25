import { describe, it, expect, afterEach } from "vite-plus/test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_THINKING_BUDGETS } from "@earendil-works/pi-ai/api/simple-options";
import {
  resolveCliThinking,
  thinkingSpawnArgs,
  thinkingControls,
  sameThinking,
  cliThinkingLevelMap,
  PI_THINKING_BUDGETS,
  providerThinkingLevel,
  type CliThinking,
} from "../src/thinking-config";

/** pi's own catalogue entry, so the fixtures cannot drift from pi. */
const catalogue = (id: string) => {
  const m = getBuiltinModels("anthropic").find((x) => x.id === id);
  if (!m) throw new Error(`pi catalogue has no ${id}`);
  return m;
};
const haiku = catalogue("claude-haiku-4-5"); // budget thinking, map null
const sonnet5 = catalogue("claude-sonnet-5"); // adaptive, off allowed
const opus46 = catalogue("claude-opus-4-6"); // adaptive, max but no xhigh
const opus55 = catalogue("claude-opus-5-5"); // adaptive, off: null

const enabled = (budgetTokens: number, effort: string, display = "summarized"): CliThinking =>
  ({ kind: "enabled", budgetTokens, effort, display }) as any;

describe("resolveCliThinking: parity with pi-ai's Anthropic streamSimple", () => {
  afterEach(() => delete process.env.PI_CLAUDE_CLI_THINKING_DISPLAY);

  it("pins the duplicated budgets to the installed pi-ai", () => {
    expect(PI_THINKING_BUDGETS).toEqual(DEFAULT_THINKING_BUDGETS);
  });

  it.each([
    ["minimal", 1024, "low"],
    ["low", 2048, "low"],
    ["medium", 8192, "medium"],
    ["high", 16384, "high"],
  ] as const)(
    "budget model at %s: budget %i (the effort rides along, ignored)",
    (level, budget, effort) => {
      expect(resolveCliThinking(haiku, level)).toEqual(enabled(budget, effort));
    },
  );

  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const)("adaptive model at %s: effort %s", (level, effort) => {
    const t = resolveCliThinking(sonnet5, level);
    expect(t.kind).toBe("enabled");
    expect((t as any).effort).toBe(effort);
  });

  it("clamps xhigh and max budgets to high, as pi does", () => {
    expect((resolveCliThinking(haiku, "xhigh") as any).budgetTokens).toBe(16384);
    expect((resolveCliThinking(haiku, "max") as any).budgetTokens).toBe(16384);
  });

  it("falls back to high for xhigh when the model's map has no xhigh", () => {
    // pi-ai's mapThinkingLevelToEffort: unmapped xhigh is "high".
    expect((resolveCliThinking(opus46, "xhigh") as any).effort).toBe("high");
    expect((resolveCliThinking(opus46, "max") as any).effort).toBe("max");
  });

  it("uses the model map's effort string when it names one", () => {
    expect((resolveCliThinking(opus55, "low") as any).effort).toBe("low");
    expect(
      (
        resolveCliThinking(
          { reasoning: true, thinkingLevelMap: { medium: "high" } },
          "medium",
        ) as any
      ).effort,
    ).toBe("high");
  });

  it("honours custom thinkingBudgets instead of dropping them", () => {
    const t = resolveCliThinking(haiku, "medium", { medium: 12000 });
    expect((t as any).budgetTokens).toBe(12000);
    // Other rungs keep pi's defaults.
    expect((resolveCliThinking(haiku, "low", { medium: 12000 }) as any).budgetTokens).toBe(2048);
  });

  it("never asks for a budget the API would reject", () => {
    expect((resolveCliThinking(haiku, "low", { low: 10 }) as any).budgetTokens).toBe(1024);
    expect((resolveCliThinking(haiku, "low", { low: 3000.7 }) as any).budgetTokens).toBe(3000);
    expect((resolveCliThinking(haiku, "low", { low: Number.NaN }) as any).budgetTokens).toBe(2048);
  });

  it("turns pi's off (reasoning undefined) into thinking disabled", () => {
    expect(resolveCliThinking(haiku, undefined)).toEqual({ kind: "disabled" });
    expect(resolveCliThinking(sonnet5, undefined)).toEqual({
      kind: "disabled",
    });
  });

  it("leaves the CLI default when the model's thinking cannot be off", () => {
    // pi-ai sends no thinking field when off is null in the map.
    expect(resolveCliThinking(opus55, undefined)).toEqual({ kind: "default" });
  });

  it("leaves the CLI default for a non-reasoning model", () => {
    expect(resolveCliThinking({ reasoning: false }, "high")).toEqual({
      kind: "default",
    });
  });

  it("asks for summaries unless PI_CLAUDE_CLI_THINKING_DISPLAY=omitted", () => {
    expect((resolveCliThinking(sonnet5, "high") as any).display).toBe("summarized");
    process.env.PI_CLAUDE_CLI_THINKING_DISPLAY = " Omitted ";
    expect((resolveCliThinking(sonnet5, "high") as any).display).toBe("omitted");
    process.env.PI_CLAUDE_CLI_THINKING_DISPLAY = "whatever";
    expect((resolveCliThinking(sonnet5, "high") as any).display).toBe("summarized");
  });
});

describe("thinkingSpawnArgs", () => {
  it("spells each kind with the CLI's flags", () => {
    expect(thinkingSpawnArgs({ kind: "default" })).toEqual([]);
    expect(thinkingSpawnArgs({ kind: "disabled" })).toEqual(["--thinking", "disabled"]);
    expect(thinkingSpawnArgs(enabled(8192, "medium"))).toEqual([
      "--max-thinking-tokens",
      "8192",
      "--effort",
      "medium",
      "--thinking-display",
      "summarized",
    ]);
  });
});

describe("thinkingControls", () => {
  const setBudget = (n: number, display = "summarized") => ({
    subtype: "set_max_thinking_tokens",
    max_thinking_tokens: n,
    thinking_display: display,
  });
  const setEffort = (effortLevel: string) => ({
    subtype: "apply_flag_settings",
    settings: { effortLevel },
  });

  it("sends nothing when the thinking is unchanged", () => {
    expect(thinkingControls(enabled(8192, "medium"), enabled(8192, "medium"))).toEqual([]);
    expect(thinkingControls({ kind: "disabled" }, { kind: "disabled" })).toEqual([]);
    expect(sameThinking({ kind: "default" }, { kind: "default" })).toBe(true);
  });

  it("turns thinking off with an explicit zero budget", () => {
    expect(thinkingControls(enabled(8192, "medium"), { kind: "disabled" })).toEqual([
      { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 },
    ]);
  });

  it("changes only what differs between two enabled levels", () => {
    // Budget models: medium -> high moves both; adaptive: effort only when
    // the budget happens to match.
    expect(thinkingControls(enabled(8192, "medium"), enabled(16384, "high"))).toEqual([
      setBudget(16384),
      setEffort("high"),
    ]);
    expect(thinkingControls(enabled(16384, "high"), enabled(16384, "xhigh"))).toEqual([
      setEffort("xhigh"),
    ]);
    expect(thinkingControls(enabled(8192, "medium"), enabled(8192, "medium", "omitted"))).toEqual([
      setBudget(8192, "omitted"),
    ]);
  });

  it("re-enables with budget, display and effort, in that order", () => {
    // A process spawned disabled has no display of its own; the effort must
    // follow the budget so it lands on an enabled session.
    for (const from of [{ kind: "disabled" }, { kind: "default" }] as CliThinking[]) {
      expect(thinkingControls(from, enabled(2048, "low"))).toEqual([
        setBudget(2048),
        setEffort("low"),
      ]);
    }
  });

  it("always sends the budget as a number, never omitted or null", () => {
    const all = [
      thinkingControls({ kind: "disabled" }, enabled(1024, "low")),
      thinkingControls(enabled(1024, "low"), { kind: "disabled" }),
      thinkingControls(enabled(1024, "low"), enabled(2048, "low")),
    ].flat() as any[];
    for (const c of all.filter((c) => c.subtype === "set_max_thinking_tokens"))
      expect(typeof c.max_thinking_tokens).toBe("number");
  });

  it("asks for a spawn to return to the CLI default", () => {
    expect(thinkingControls(enabled(8192, "medium"), { kind: "default" })).toBeUndefined();
    expect(thinkingControls({ kind: "disabled" }, { kind: "default" })).toBeUndefined();
  });
});

describe("cliThinkingLevelMap: only levels the model has through Claude Code", () => {
  const offered = (id: string) => {
    const m = catalogue(id);
    return getSupportedThinkingLevels({
      ...m,
      thinkingLevelMap: cliThinkingLevelMap(m),
    } as any);
  };

  it.each([
    [["claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5"], "off minimal low medium high"],
    [["claude-opus-4-6", "claude-sonnet-4-6"], "off low medium high max"],
    [["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"], "off low medium high xhigh max"],
    [
      ["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"],
      "low medium high xhigh max",
    ],
  ])("%j offer: %s", (ids, levels) => {
    for (const id of ids) expect(offered(id), id).toEqual(levels.split(" "));
  });

  it("changes pi's catalogue only by dropping minimal on adaptive models", () => {
    for (const m of getBuiltinModels("anthropic")) {
      const native = getSupportedThinkingLevels(m as any);
      const ours = offered(m.id);
      const adaptive = (m as any).compat?.forceAdaptiveThinking === true;
      expect(ours, m.id).toEqual(adaptive ? native.filter((l) => l !== "minimal") : native);
    }
  });

  /**
   * What Claude Code 2.1.283 itself reported for this account's models
   * (`initialize` -> models[].supportedEffortLevels; Haiku reports no effort
   * support). Pinned so a catalogue change that disagrees with the CLI shows
   * up here rather than as a level that silently does nothing.
   */
  const CLAUDE_CODE_REPORT: Record<string, string[] | null> = {
    "claude-haiku-4-5": null,
    "claude-opus-4-6": ["low", "medium", "high", "max"],
    "claude-sonnet-4-6": ["low", "medium", "high", "max"],
    "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
    "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  };

  it.each(Object.entries(CLAUDE_CODE_REPORT))(
    "%s: the levels above off match Claude Code's own report",
    (id, efforts) => {
      const levels = offered(id).filter((l) => l !== "off");
      if (efforts === null) {
        // A budget model: every level is a budget, none is an effort.
        expect(levels).toEqual(["minimal", "low", "medium", "high"]);
      } else {
        expect(levels).toEqual(efforts);
      }
    },
  );

  it("leaves a model without a map, or a budget model, as pi has it", () => {
    expect(cliThinkingLevelMap({})).toBeUndefined();
    expect(cliThinkingLevelMap({ thinkingLevelMap: null })).toBeUndefined();
    expect(cliThinkingLevelMap({ compat: { forceAdaptiveThinking: true } })).toEqual({
      minimal: null,
    });
  });
});

describe("providerThinkingLevel: the effort a response ran at", () => {
  /** A catalogue model as this provider registers it. */
  const registered = (model: ReturnType<typeof catalogue>) => ({
    thinkingLevelMap: cliThinkingLevelMap(model),
  });

  it("is the effort on every adaptive model with thinking on", () => {
    for (const model of [sonnet5, opus46, opus55])
      expect(providerThinkingLevel(registered(model), enabled(8192, "medium"))).toBe("medium");
  });

  it("is none on a budget model, which ignores the effort", () => {
    expect(providerThinkingLevel(registered(haiku), enabled(8192, "medium"))).toBeUndefined();
  });

  it("is none without thinking", () => {
    for (const thinking of [{ kind: "disabled" }, { kind: "default" }] as const)
      expect(providerThinkingLevel(registered(sonnet5), thinking)).toBeUndefined();
  });
});
