import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock references so they survive vi.mock hoisting
const mocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdtempSync: vi.fn((prefix: string) => `${prefix}a1b2c3`),
  rmSync: vi.fn(),
  tmpdir: vi.fn(() => "/tmp"),
}));

// Mock node:fs writeFileSync/unlinkSync to avoid disk I/O
vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
  mkdtempSync: mocks.mkdtempSync,
  rmSync: mocks.rmSync,
}));

// Mock node:os tmpdir
vi.mock("node:os", () => ({
  tmpdir: mocks.tmpdir,
}));

import {
  writeSchemaFile,
  writeSessionMcpConfig,
  cleanupMcpConfigFiles,
  resetMcpConfigCache,
} from "../src/mcp-config";
import type { McpToolDef } from "../src/mcp-config";
import { basename, dirname } from "node:path";
import {
  runtimeDir,
  resetRuntimeDirForTests,
  RUNTIME_FILE_MODE,
} from "../src/runtime-dir";

/** Every file this module stages must be owner-only. */
function expectOwnerOnly(call: unknown[]): void {
  expect(call[2]).toMatchObject({ mode: RUNTIME_FILE_MODE });
}

describe("writeSchemaFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetRuntimeDirForTests();
    resetMcpConfigCache();
  });

  const defs = (description: string): McpToolDef[] => [
    { name: "mcp", description, inputSchema: { type: "object" } },
  ];
  const schemaWrites = () =>
    mocks.writeFileSync.mock.calls.filter((call: unknown[]) =>
      /mcp-schemas-[0-9a-f]+\.json$/.test(String(call[0])),
    );

  it("writes the tool defs as a JSON array, owner-only", () => {
    const { schemaPath } = writeSchemaFile(defs("Search"));

    const [call] = schemaWrites();
    expect(call[0]).toBe(schemaPath);
    expect(JSON.parse(String(call[1]))).toEqual(defs("Search"));
    expectOwnerOnly(call);
  });

  it("stages its files in a private randomly-named directory, not bare tmpdir", () => {
    const { schemaPath } = writeSchemaFile(defs("Search"));

    // mkdtemp creates the directory 0700 under a name that cannot be derived
    // from the pid; the schema file lives inside it.
    expect(mocks.mkdtempSync).toHaveBeenCalledTimes(1);
    expect(dirname(schemaPath)).toBe(runtimeDir());
    expect(dirname(schemaPath)).not.toBe("/tmp");
    expect(basename(dirname(schemaPath))).toMatch(/^pi-claude-/);
  });

  it("does not write again when the tool surface is unchanged", () => {
    writeSchemaFile(defs("Servers: linear"));
    mocks.writeFileSync.mockClear();

    const second = writeSchemaFile(defs("Servers: linear"));

    expect(second.changed).toBe(false);
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("gives each tool surface its own file so concurrent requests cannot clobber each other", () => {
    // The main turn stages its tools, a tool-less title request runs at the
    // same moment, and the main turn's later calls must still see its tools
    // (upstream issue #49).
    const mainTurn = writeSchemaFile(defs("a"));
    const titleRequest = writeSchemaFile([]);
    const mainTurnAgain = writeSchemaFile(defs("a"));

    expect(schemaWrites()).toHaveLength(2);
    expect(titleRequest.schemaPath).not.toBe(mainTurn.schemaPath);
    expect(titleRequest.version).not.toBe(mainTurn.version);
    expect(mainTurnAgain).toMatchObject({
      schemaPath: mainTurn.schemaPath,
      version: mainTurn.version,
      changed: false,
    });
    const written = schemaWrites().find(
      (call: unknown[]) => call[0] === mainTurn.schemaPath,
    );
    expect(JSON.parse(String(written![1]))).toEqual(defs("a"));
  });
});

describe("cleanupMcpConfigFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetRuntimeDirForTests();
    resetMcpConfigCache();
  });

  it("unlinks every staged schema file and session config", () => {
    const a = writeSchemaFile([
      { name: "mcp", description: "d", inputSchema: { type: "object" } },
    ]);
    const b = writeSchemaFile([]);
    const config = writeSessionMcpConfig("cli-a", a.schemaPath);

    cleanupMcpConfigFiles();

    const removed = mocks.unlinkSync.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(removed).toEqual(
      expect.arrayContaining([a.schemaPath, b.schemaPath, config]),
    );
  });

  it("is safe when the files were never written", () => {
    mocks.unlinkSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => cleanupMcpConfigFiles()).not.toThrow();
  });
});

describe("writeSessionMcpConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMcpConfigCache();
  });

  it("writes one config per CLI session carrying the handoff socket, the session id and the secret path", async () => {
    const { writeSessionMcpConfig } = await import("../src/mcp-config");
    const path = writeSessionMcpConfig(
      "cli-77",
      "/tmp/schema.json",
      "/tmp/h.sock",
      "/tmp/h.secret",
    );
    expect(path).toContain("cli-77");
    const written = JSON.parse(mocks.writeFileSync.mock.calls[0][1] as string);
    const args = written.mcpServers["custom-tools"].args as string[];
    expect(args[0]).toMatch(/mcp-schema-server\.cjs$/);
    expect(args.slice(1)).toEqual([
      "/tmp/schema.json",
      "/tmp/h.sock",
      "cli-77",
      "/tmp/h.secret",
    ]);
    // Written once per session.
    expect(
      writeSessionMcpConfig(
        "cli-77",
        "/tmp/schema.json",
        "/tmp/h.sock",
        "/tmp/h.secret",
      ),
    ).toBe(path);
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("passes the secret as a path, never as a literal on the server's argv", async () => {
    const { writeSessionMcpConfig } = await import("../src/mcp-config");
    writeSessionMcpConfig(
      "cli-79",
      "/tmp/schema.json",
      "/tmp/h.sock",
      "/tmp/h.secret",
    );
    // argv is world-readable through `ps`; only the path may appear there.
    const written = mocks.writeFileSync.mock.calls[0][1] as string;
    expect(written).toContain("/tmp/h.secret");
  });

  it("writes every session config owner-only", async () => {
    const { writeSessionMcpConfig } = await import("../src/mcp-config");
    writeSessionMcpConfig(
      "cli-80",
      "/tmp/schema.json",
      "/tmp/h.sock",
      "/tmp/s",
    );
    expectOwnerOnly(mocks.writeFileSync.mock.calls[0]);
  });

  it("keeps a hostile session id from escaping the runtime directory", async () => {
    const { writeSessionMcpConfig } = await import("../src/mcp-config");
    const path = writeSessionMcpConfig(
      "../../etc/cron.d/evil",
      "/tmp/schema.json",
    );
    // Separators are what let a name escape, and `\` is one of them on
    // Windows; `..` inside a single filename cannot traverse anywhere.
    expect(dirname(path)).toBe(runtimeDir());
    expect(basename(path)).toMatch(/^mcp-config-.+\.json$/);
  });

  it("omits the socket arguments when no handoff socket is given", async () => {
    const { writeSessionMcpConfig } = await import("../src/mcp-config");
    writeSessionMcpConfig("cli-78", "/tmp/schema.json");
    const written = JSON.parse(mocks.writeFileSync.mock.calls[0][1] as string);
    expect(written.mcpServers["custom-tools"].args).toHaveLength(2);
  });

  it("session configs are removed on cleanup and on explicit removal", async () => {
    const { writeSessionMcpConfig, removeSessionMcpConfig } =
      await import("../src/mcp-config");
    const a = writeSessionMcpConfig("cli-a", "/tmp/s.json", "/tmp/h.sock");
    const b = writeSessionMcpConfig("cli-b", "/tmp/s.json", "/tmp/h.sock");
    removeSessionMcpConfig("cli-a");
    expect(mocks.unlinkSync).toHaveBeenCalledWith(a);
    cleanupMcpConfigFiles();
    expect(mocks.unlinkSync).toHaveBeenCalledWith(b);
  });

  it("writeSchemaFile identifies a surface by content, not by write order", async () => {
    const { writeSchemaFile } = await import("../src/mcp-config");
    const defs = (d: string): McpToolDef[] => [
      { name: "t", description: d, inputSchema: {} },
    ];
    const a = writeSchemaFile(defs("one"));
    const b = writeSchemaFile(defs("one"));
    const c = writeSchemaFile(defs("two"));
    // A tool-less request interleaved with the main turn (upstream #49) must
    // hand the main turn back the path and version it started with.
    const d = writeSchemaFile(defs("one"));
    expect(a).toMatchObject({ changed: true, version: 1 });
    expect(b).toMatchObject({ changed: false, version: 1 });
    expect(c).toMatchObject({ changed: true, version: 2 });
    expect(d).toMatchObject({ changed: false, version: 1 });
    expect(b.schemaPath).toBe(a.schemaPath);
    expect(d.schemaPath).toBe(a.schemaPath);
    expect(c.schemaPath).not.toBe(a.schemaPath);
  });
});
