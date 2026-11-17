import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CLI_UPDATE_CHECK_TTL_MILLIS,
  type CliUpdateProbes,
  type CliUpdateStore,
  claudeSettingsFile,
  compareCliVersions,
  createCliUpdateChecker,
  defaultCliUpdateFile,
  describeCliUpdate,
  fileCliUpdateStore,
  parseCliReleaseChannel,
  parseInstalledCliVersion,
  parsePublishedCliVersions,
  probeInstalledCliVersion,
} from "../src/cli-update";

describe("parseInstalledCliVersion", () => {
  it("reads the version out of `claude --version`", () => {
    expect(parseInstalledCliVersion("2.1.312 (Claude Code)\n")).toBe("2.1.312");
    expect(parseInstalledCliVersion("2.1.312")).toBe("2.1.312");
  });

  it("is undefined without a version", () => {
    expect(parseInstalledCliVersion("command not found")).toBeUndefined();
  });
});

describe("compareCliVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareCliVersions("2.1.326", "2.1.312")).toBeGreaterThan(0);
    expect(compareCliVersions("2.1.99", "2.1.100")).toBeLessThan(0);
    expect(compareCliVersions("2.1.312", "2.1.312")).toBe(0);
    expect(compareCliVersions("3.0.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareCliVersions("2.1", "2.1.0")).toBe(0);
  });
});

describe("parsePublishedCliVersions", () => {
  it("reads latest and stable", () => {
    expect(
      parsePublishedCliVersions('{"stable":"2.1.311","latest":"2.1.326","next":"2.1.326"}'),
    ).toEqual({ latest: "2.1.326", stable: "2.1.311" });
  });

  it("keeps latest without a usable stable", () => {
    expect(parsePublishedCliVersions('{"latest":"2.1.326","stable":"soon"}')).toEqual({
      latest: "2.1.326",
      stable: undefined,
    });
  });

  it("is undefined without a latest version", () => {
    expect(parsePublishedCliVersions('{"stable":"2.1.311"}')).toBeUndefined();
    expect(parsePublishedCliVersions("[]")).toBeUndefined();
    expect(parsePublishedCliVersions("<html>")).toBeUndefined();
  });
});

describe("parseCliReleaseChannel", () => {
  it("is stable only when the settings say so", () => {
    expect(parseCliReleaseChannel('{"autoUpdatesChannel":"stable"}')).toBe("stable");
    expect(parseCliReleaseChannel('{"autoUpdatesChannel":"latest"}')).toBe("latest");
    expect(parseCliReleaseChannel("{}")).toBe("latest");
    expect(parseCliReleaseChannel("not json")).toBe("latest");
    expect(parseCliReleaseChannel(undefined)).toBe("latest");
  });
});

describe("claudeSettingsFile", () => {
  it("prefers the provider's config directory, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
    expect(claudeSettingsFile({ PI_CLAUDE_CLI_CONFIG_DIR: "/a", CLAUDE_CONFIG_DIR: "/b" })).toBe(
      join("/a", "settings.json"),
    );
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: "/b" })).toBe(join("/b", "settings.json"));
    expect(claudeSettingsFile({})).toMatch(/\.claude\/settings\.json$/);
  });
});

describe("defaultCliUpdateFile", () => {
  it("lives under the state directory, one per installation", () => {
    expect(defaultCliUpdateFile({ XDG_STATE_HOME: "/state" })).toBe(
      join("/state", "pi-claude-cli", "cli-update.json"),
    );
    expect(
      defaultCliUpdateFile({ XDG_STATE_HOME: "/state", PI_CLAUDE_CLI_COMMAND: "/opt/claude" }),
    ).toMatch(/cli-update-[0-9a-f]{12}\.json$/);
    expect(defaultCliUpdateFile({})).toMatch(/\.local\/state\/pi-claude-cli\/cli-update\.json$/);
  });
});

const memoryStore = (initial?: string): CliUpdateStore & { text: () => string | undefined } => {
  let text = initial;
  return {
    read: async () => text,
    write: async (next) => {
      text = next;
    },
    text: () => text,
  };
};

const probes = (overrides: Partial<CliUpdateProbes> = {}): CliUpdateProbes => ({
  installedVersion: async () => "2.1.312",
  publishedVersions: async () => ({ latest: "2.1.326", stable: "2.1.311" }),
  settings: async () => undefined,
  ...overrides,
});

describe("createCliUpdateChecker", () => {
  it("finds a newer version on the latest channel", async () => {
    const checker = createCliUpdateChecker(probes(), memoryStore(), () => 1_000);
    expect(await checker.check()).toEqual({
      installed: "2.1.312",
      available: "2.1.326",
      channel: "latest",
      updateAvailable: true,
      declined: false,
    });
  });

  it("follows the stable channel when the CLI is set to it", async () => {
    const checker = createCliUpdateChecker(
      probes({ settings: async () => '{"autoUpdatesChannel":"stable"}' }),
      memoryStore(),
    );
    expect(await checker.check()).toMatchObject({
      available: "2.1.311",
      channel: "stable",
      updateAvailable: false,
    });
  });

  it("is undefined without a CLI or any published version", async () => {
    expect(
      await createCliUpdateChecker(
        probes({ installedVersion: async () => undefined }),
        memoryStore(),
      ).check(),
    ).toBeUndefined();
    expect(
      await createCliUpdateChecker(
        probes({ publishedVersions: async () => undefined }),
        memoryStore(),
      ).check(),
    ).toBeUndefined();
  });

  it("asks npm once a day, or when forced", async () => {
    let now = 1_000;
    const publishedVersions = vi.fn(async () => ({ latest: "2.1.326", stable: undefined }));
    const store = memoryStore();
    const checker = createCliUpdateChecker(probes({ publishedVersions }), store, () => now);
    await checker.check();
    await checker.check();
    expect(publishedVersions).toHaveBeenCalledTimes(1);
    await checker.check({ force: true });
    expect(publishedVersions).toHaveBeenCalledTimes(2);
    now += CLI_UPDATE_CHECK_TTL_MILLIS;
    await checker.check();
    expect(publishedVersions).toHaveBeenCalledTimes(3);
    expect(JSON.parse(store.text() ?? "")).toEqual({
      checkedAt: now,
      published: { latest: "2.1.326" },
    });
  });

  it("serves the kept versions when npm cannot be reached", async () => {
    const store = memoryStore(
      JSON.stringify({ checkedAt: 0, published: { latest: "2.1.320", stable: "2.1.311" } }),
    );
    const checker = createCliUpdateChecker(
      probes({ publishedVersions: async () => undefined }),
      store,
      () => CLI_UPDATE_CHECK_TTL_MILLIS * 2,
    );
    expect(await checker.check()).toMatchObject({ available: "2.1.320", updateAvailable: true });
  });

  it("remembers a declined version until a newer one is out", async () => {
    let latest = "2.1.326";
    const store = memoryStore();
    const checker = createCliUpdateChecker(
      probes({ publishedVersions: async () => ({ latest, stable: undefined }) }),
      store,
    );
    expect(await checker.check()).toMatchObject({ declined: false });
    await checker.decline("2.1.326");
    expect(await checker.check()).toMatchObject({ declined: true });
    latest = "2.1.330";
    expect(await checker.check({ force: true })).toMatchObject({
      available: "2.1.330",
      declined: false,
    });
  });

  it("ignores a store it cannot read", async () => {
    for (const text of ["not json", "[]", '{"published":{"latest":7},"declined":"x"}']) {
      const checker = createCliUpdateChecker(probes(), memoryStore(text));
      expect(await checker.check()).toMatchObject({ available: "2.1.326", declined: false });
    }
  });

  it("keeps working when the store cannot be written", async () => {
    const checker = createCliUpdateChecker(probes(), {
      read: async () => undefined,
      write: async () => {
        throw new Error("read-only");
      },
    });
    expect(await checker.check()).toMatchObject({ updateAvailable: true });
    await expect(checker.decline("2.1.326")).resolves.toBeUndefined();
  });
});

describe("describeCliUpdate", () => {
  it("warns about an outdated CLI and says why it matters", () => {
    const { level, message } = describeCliUpdate({
      installed: "2.1.312",
      available: "2.1.326",
      channel: "latest",
      updateAvailable: true,
      declined: false,
    });
    expect(level).toBe("warning");
    expect(message).toContain("2.1.312");
    expect(message).toContain("2.1.326");
    expect(message).toContain("models");
  });

  it("is informational when up to date or unknown", () => {
    expect(
      describeCliUpdate({
        installed: "2.1.326",
        available: "2.1.326",
        channel: "latest",
        updateAvailable: false,
        declined: false,
      }).level,
    ).toBe("info");
    expect(describeCliUpdate(undefined).level).toBe("info");
  });
});

describe("fileCliUpdateStore", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("writes an owner-only file and reads it back", async () => {
    directory = await mkdtemp(join(tmpdir(), "pcc-update-"));
    const path = join(directory, "nested", "cli-update.json");
    const store = fileCliUpdateStore(path);
    expect(await store.read()).toBeUndefined();
    await store.write('{"declined":"2.1.326"}');
    expect(await store.read()).toBe('{"declined":"2.1.326"}');
    expect(await readFile(path, "utf8")).toBe('{"declined":"2.1.326"}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("probeInstalledCliVersion", () => {
  it("is undefined when there is no CLI", async () => {
    const previous = process.env.PI_CLAUDE_CLI_COMMAND;
    process.env.PI_CLAUDE_CLI_COMMAND = "/nonexistent/claude";
    try {
      expect(await probeInstalledCliVersion()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_CLAUDE_CLI_COMMAND;
      else process.env.PI_CLAUDE_CLI_COMMAND = previous;
    }
  });
});
