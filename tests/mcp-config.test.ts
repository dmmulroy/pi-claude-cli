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
  getCustomToolDefs,
  writeMcpConfig,
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

describe("getCustomToolDefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters out all 6 built-in tools and returns only custom tools", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
        {
          name: "search",
          description: "Custom search tool",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "deploy",
          description: "Deploy app",
          parameters: {
            type: "object",
            properties: { target: { type: "string" } },
          },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("search");
    expect(result[1].name).toBe("deploy");
  });

  it("returns empty array when all tools are built-in", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("includes custom tool with correct name, description, inputSchema from parameters", () => {
    const customParams = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number" },
      },
      required: ["query"],
    };

    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "custom_search",
          description: "Search the codebase",
          parameters: customParams,
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("custom_search");
    expect(result[0].description).toBe("Search the codebase");
    expect(result[0].inputSchema).toBe(customParams);
  });

  it("handles pi.getAllTools() returning empty array", () => {
    const mockPi = {
      getAllTools: vi.fn(() => []),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns undefined", () => {
    const mockPi = {
      getAllTools: vi.fn(() => undefined),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns null", () => {
    const mockPi = {
      getAllTools: vi.fn(() => null),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });
});

describe("writeMcpConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetRuntimeDirForTests();
    resetMcpConfigCache();
  });

  it("writes schema file to tmpdir with correct content (JSON array of tool defs)", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // First writeFileSync call is the schema file
    const schemaCall = mocks.writeFileSync.mock.calls[0];
    expect(schemaCall[0]).toMatch(/mcp-schemas-[0-9a-f]+\.json$/);
    expect(JSON.parse(schemaCall[1])).toEqual(toolDefs);
    expectOwnerOnly(schemaCall);
  });

  it("stages its files in a private randomly-named directory, not bare tmpdir", () => {
    writeMcpConfig([
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ]);

    // mkdtempSync is what makes the directory 0700 and its name unguessable.
    expect(mocks.mkdtempSync).toHaveBeenCalledWith(
      expect.stringContaining("pi-claude-"),
    );
    for (const call of mocks.writeFileSync.mock.calls) {
      // Directly inside the private directory, never a pid-derived path in
      // bare tmpdir. Compared through `dirname` rather than a regex because
      // Windows separates with `\`.
      expect(dirname(String(call[0]))).toBe(runtimeDir());
      expectOwnerOnly(call);
    }
  });

  it("writes config file to tmpdir with mcpServers.custom-tools entry", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // Second writeFileSync call is the config file
    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    expect(config).toHaveProperty("mcpServers");
    expect(config.mcpServers).toHaveProperty("custom-tools");
  });

  it("config uses 'command': 'node' format (not 'type': 'http')", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.command).toBe("node");
    expect(server).not.toHaveProperty("type");
  });

  it("config args include path to mcp-schema-server.cjs and schema file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.args).toHaveLength(2);
    // First arg should be the server .cjs path (normalize separators for Windows)
    expect(server.args[0].replace(/\\/g, "/")).toContain(
      "mcp-schema-server.cjs",
    );
    // Second arg should be the schema file path
    expect(server.args[1]).toMatch(/mcp-schemas-[0-9a-f]+\.json$/);
  });

  it("returns the config file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    const result = writeMcpConfig(toolDefs);

    expect(result.configPath).toMatch(/mcp-config[^/]*\.json$/);
    expect(result.configPath).toMatch(/\.json$/);
    expect(result.changed).toBe(true);
  });
});

describe("writeMcpConfig refresh", () => {
  const defs = (description: string): McpToolDef[] => [
    { name: "mcp", description, inputSchema: { type: "object" } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetRuntimeDirForTests();
    resetMcpConfigCache();
  });

  it("does not rewrite either file when the tool surface is unchanged", () => {
    writeMcpConfig(defs("Servers: linear"));
    const afterFirst = mocks.writeFileSync.mock.calls.length;

    const second = writeMcpConfig(defs("Servers: linear"));

    expect(second.changed).toBe(false);
    expect(mocks.writeFileSync.mock.calls.length).toBe(afterFirst);
  });

  it("rewrites the schema file when the tool surface changes", () => {
    writeMcpConfig(defs("Servers: linear"));
    mocks.writeFileSync.mockClear();

    const second = writeMcpConfig(defs("Servers: linear, notion"));

    expect(second.changed).toBe(true);
    const schemaWrites = mocks.writeFileSync.mock.calls.filter(
      (call: unknown[]) => /mcp-schemas-[0-9a-f]+\.json$/.test(String(call[0])),
    );
    expect(schemaWrites).toHaveLength(1);
    expect(JSON.parse(String(schemaWrites[0][1]))[0].description).toBe(
      "Servers: linear, notion",
    );
  });

  it("gives each tool surface its own file so concurrent requests cannot clobber each other", () => {
    writeMcpConfig(defs("a"));
    writeMcpConfig(defs("b"));
    writeMcpConfig(defs("a"));

    const schemaPaths = mocks.writeFileSync.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((path: string) => /mcp-schemas-[0-9a-f]+\.json$/.test(path));
    // Two surfaces, two files, each written exactly once.
    expect(schemaPaths).toHaveLength(2);
    expect(new Set(schemaPaths).size).toBe(2);
  });

  it("writes the config file once, not on every refresh", () => {
    writeMcpConfig(defs("a"));
    mocks.writeFileSync.mockClear();

    writeMcpConfig(defs("b"));

    const configWrites = mocks.writeFileSync.mock.calls.filter(
      (call: unknown[]) => /mcp-config[^/]*\.json$/.test(String(call[0])),
    );
    expect(configWrites).toHaveLength(0);
  });
});

describe("cleanupMcpConfigFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetRuntimeDirForTests();
    resetMcpConfigCache();
  });

  it("unlinks both the schema and the config file", () => {
    writeMcpConfig([
      { name: "mcp", description: "d", inputSchema: { type: "object" } },
    ]);

    cleanupMcpConfigFiles();

    const removed = mocks.unlinkSync.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(
      removed.some((p: string) => /mcp-schemas-[0-9a-f]+\.json$/.test(p)),
    ).toBe(true);
    expect(removed.some((p: string) => /mcp-config[^/]*\.json$/.test(p))).toBe(
      true,
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
