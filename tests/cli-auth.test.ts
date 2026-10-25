import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_AUTH_STATUS_TTL_MILLIS,
  type CliAuthStatus,
  type CliAuthStatusStore,
  createCliAuthStatusCache,
  defaultCliAuthStatusFile,
  describeCliAuthStatus,
  fileCliAuthStatusStore,
  parseCliAuthStatus,
  probeCliAuthStatus,
  providerAuthCheck,
} from "../src/cli-auth";

const MAX: CliAuthStatus = {
  installed: true,
  loggedIn: true,
  subscriptionType: "max",
};
const LOGGED_OUT: CliAuthStatus = {
  installed: true,
  loggedIn: false,
  subscriptionType: undefined,
};

describe("parseCliAuthStatus", () => {
  it("reads the login and the plan", () => {
    expect(
      parseCliAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          subscriptionType: "max",
          email: "not kept",
        }),
      ),
    ).toEqual(MAX);
  });

  it("reads a login without a plan, and a logged-out CLI", () => {
    expect(parseCliAuthStatus('{"loggedIn": true, "method": "stub"}')).toEqual({
      ...MAX,
      subscriptionType: undefined,
    });
    expect(
      parseCliAuthStatus('{"loggedIn": false, "subscriptionType": "max"}'),
    ).toEqual(LOGGED_OUT);
  });

  it.each(["", "not json", "[]", '{"loggedIn": "yes"}'])(
    "reads %j as an unknown login",
    (stdout) => {
      expect(parseCliAuthStatus(stdout)).toEqual({
        installed: true,
        loggedIn: undefined,
        subscriptionType: undefined,
      });
    },
  );
});

describe("probeCliAuthStatus", () => {
  const path = process.env.PATH;
  const directories: string[] = [];
  afterEach(async () => {
    process.env.PATH = path;
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  const pathWith = async (script?: string) => {
    const directory = await mkdtemp(join(tmpdir(), "pcc-auth-"));
    directories.push(directory);
    if (script !== undefined)
      await writeFile(join(directory, "claude"), script, { mode: 0o755 });
    process.env.PATH = directory;
  };

  it("reads a missing CLI as not installed", async () => {
    await pathWith();
    expect(await probeCliAuthStatus()).toEqual({
      installed: false,
      loggedIn: undefined,
      subscriptionType: undefined,
    });
  });

  it("reads the answer of a CLI that exits non-zero", async () => {
    await pathWith("#!/bin/sh\necho '{\"loggedIn\": false}'\nexit 1\n");
    expect(await probeCliAuthStatus()).toEqual(LOGGED_OUT);
  });

  it("hides the variables that would move the CLI off the subscription", async () => {
    await pathWith(
      '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"loggedIn": true}\'; else echo \'{"loggedIn": true, "subscriptionType": "pro"}\'; fi\n',
    );
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect((await probeCliAuthStatus()).subscriptionType).toBe("pro");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("rejects when pi aborts", async () => {
    await pathWith("#!/bin/sh\nsleep 5\n");
    const controller = new AbortController();
    const probed = probeCliAuthStatus(controller.signal);
    controller.abort(new Error("stop"));
    await expect(probed).rejects.toThrow("stop");
  });
});

describe("defaultCliAuthStatusFile", () => {
  it("lives in the state directory", () => {
    expect(defaultCliAuthStatusFile({ XDG_STATE_HOME: "/state" })).toBe(
      "/state/pi-claude-cli/auth-status.json",
    );
    expect(defaultCliAuthStatusFile({ XDG_STATE_HOME: " " })).toMatch(
      /\.local\/state\/pi-claude-cli\/auth-status\.json$/,
    );
  });
});

describe("fileCliAuthStatusStore", () => {
  it("writes an owner-only file and reads it back; a missing file is nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcc-store-"));
    try {
      const path = join(directory, "nested", "auth-status.json");
      const store = fileCliAuthStatusStore(path);
      expect(await store.read()).toBeUndefined();
      await store.write("{}");
      expect(await store.read()).toBe("{}");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
      expect(await readFile(path, "utf8")).toBe("{}");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("createCliAuthStatusCache", () => {
  const memoryStore = (text?: string) => {
    const store = {
      text,
      read: vi.fn(async () => store.text),
      write: vi.fn(async (next: string) => {
        store.text = next;
      }),
    };
    return store;
  };
  const NOW = 1_000_000;

  it("asks the CLI when nothing is kept, keeps the answer, and answers from memory after", async () => {
    const probe = vi.fn(async () => MAX);
    const store = memoryStore();
    const cache = createCliAuthStatusCache(probe, store, () => NOW);
    expect(await cache.status()).toEqual(MAX);
    expect(await cache.status()).toEqual(MAX);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.text ?? "")).toEqual({ ...MAX, checkedAt: NOW });
  });

  it("serves a recent kept status at once and checks again in the background", async () => {
    const store = memoryStore(
      JSON.stringify({ ...LOGGED_OUT, checkedAt: NOW - 1000 }),
    );
    let answer!: (status: CliAuthStatus) => void;
    const probe = vi.fn(
      () => new Promise<CliAuthStatus>((resolve) => (answer = resolve)),
    );
    const cache = createCliAuthStatusCache(probe, store, () => NOW);
    expect(await cache.status()).toEqual(LOGGED_OUT);
    expect(probe).toHaveBeenCalledTimes(1);
    answer(MAX);
    await vi.waitFor(() =>
      expect(JSON.parse(store.text ?? "").subscriptionType).toBe("max"),
    );
    expect(await cache.status()).toEqual(MAX);
  });

  it.each([
    [
      "old",
      JSON.stringify({ ...MAX, checkedAt: NOW - CLI_AUTH_STATUS_TTL_MILLIS }),
    ],
    ["from the future", JSON.stringify({ ...MAX, checkedAt: NOW + 1 })],
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["incomplete", JSON.stringify({ installed: true })],
    [
      "of the wrong types",
      JSON.stringify({ installed: true, loggedIn: "yes", checkedAt: NOW }),
    ],
    [
      "with a plan that is not text",
      JSON.stringify({ installed: true, subscriptionType: 1, checkedAt: NOW }),
    ],
  ])("waits for the CLI when the kept status is %s", async (_, text) => {
    const probe = vi.fn(async () => LOGGED_OUT);
    const cache = createCliAuthStatusCache(probe, memoryStore(text), () => NOW);
    expect(await cache.status()).toEqual(LOGGED_OUT);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("refresh asks the CLI every time, and survives a store that cannot write", async () => {
    const probe = vi.fn(async () => MAX);
    const store: CliAuthStatusStore = {
      read: async () => undefined,
      write: async () => {
        throw new Error("read-only");
      },
    };
    const cache = createCliAuthStatusCache(probe, store);
    expect(await cache.refresh()).toEqual(MAX);
    expect(await cache.refresh()).toEqual(MAX);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("shares one CLI launch between callers that ask at once", async () => {
    let answer!: (status: CliAuthStatus) => void;
    const probe = vi.fn(
      () => new Promise<CliAuthStatus>((resolve) => (answer = resolve)),
    );
    const cache = createCliAuthStatusCache(probe, memoryStore(), () => NOW);
    const asked = [cache.status(), cache.status(), cache.refresh()];
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    answer(MAX);
    expect(await Promise.all(asked)).toEqual([MAX, MAX, MAX]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer of a launch whose caller aborted", async () => {
    let answer!: (status: CliAuthStatus) => void;
    const probe = vi.fn(
      () => new Promise<CliAuthStatus>((resolve) => (answer = resolve)),
    );
    const cache = createCliAuthStatusCache(probe, memoryStore(), () => NOW);
    const controller = new AbortController();
    const asked = cache.status(controller.signal);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    controller.abort(new Error("stop"));
    await expect(asked).rejects.toThrow("stop");
    await expect(cache.refresh(controller.signal)).rejects.toThrow("stop");
    answer(MAX);
    expect(await cache.status()).toEqual(MAX);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("survives a failed background check", async () => {
    const probe = vi.fn(async () => {
      throw new Error("no");
    });
    const store = memoryStore(JSON.stringify({ ...MAX, checkedAt: NOW }));
    const cache = createCliAuthStatusCache(probe, store, () => NOW);
    expect(await cache.status()).toEqual(MAX);
  });
});

describe("providerAuthCheck", () => {
  it("reports a subscription login as OAuth, so pi labels it a subscription", () => {
    expect(providerAuthCheck(MAX)).toEqual({
      type: "oauth",
      source: "Claude Code max",
    });
  });

  it("reports another or an unknown login as configured", () => {
    for (const loggedIn of [true, undefined])
      expect(
        providerAuthCheck({ ...MAX, loggedIn, subscriptionType: undefined }),
      ).toEqual({ type: "api_key", source: "Claude Code CLI" });
  });

  it("reports a missing or logged-out CLI as not configured", () => {
    expect(providerAuthCheck(LOGGED_OUT)).toBeUndefined();
    expect(providerAuthCheck({ ...MAX, installed: false })).toBeUndefined();
  });
});

describe("describeCliAuthStatus", () => {
  it.each([
    [{ ...MAX, installed: false }, "error", "not installed"],
    [LOGGED_OUT, "error", "claude auth login"],
    [{ ...MAX, loggedIn: undefined }, "warning", "no answer"],
    [
      { ...MAX, subscriptionType: undefined },
      "warning",
      "without a Claude subscription",
    ],
    [MAX, "info", "Claude max subscription"],
  ] as const)("describes %j", (status, level, text) => {
    const described = describeCliAuthStatus(status);
    expect(described.level).toBe(level);
    expect(described.message).toContain(text);
  });
});
