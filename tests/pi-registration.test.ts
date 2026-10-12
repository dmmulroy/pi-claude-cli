import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/process-manager", () => ({
  validateCliPresence: vi.fn(),
  validateCliAuth: vi.fn(),
  killAllProcesses: vi.fn(),
}));
vi.mock("../src/provider", () => ({ streamViaCli: vi.fn() }));
vi.mock("../src/cli-process", () => ({ retireAllCliProcesses: vi.fn() }));
vi.mock("../src/handoff-broker", () => ({
  startHandoffBroker: vi.fn(async () => "socket"),
  stopHandoffBroker: vi.fn(),
}));
vi.mock("../src/mcp-config", () => ({
  writeSchemaFile: vi.fn(() => ({
    schemaPath: "schema",
    version: 1,
    changed: false,
  })),
  cleanupMcpConfigFiles: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  registerApiProvider: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: () => [],
}));
import register from "../index";
import { streamViaCli } from "../src/provider";
import { retireAllCliProcesses } from "../src/cli-process";
import { writeSchemaFile } from "../src/mcp-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pi ownership at registration", () => {
  it("never activates tools and advertises exactly the request's current tools, including none", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => handlers.set(event, fn),
      registerProvider: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(),
    };
    register(pi as any);
    const setStatus = vi.fn();
    await handlers.get("session_start")({}, { ui: { setStatus } });
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    const stream = pi.registerProvider.mock.calls[0][1].streamSimple;
    const tool = {
      name: "read",
      description: "pi read",
      parameters: { type: "object" },
    };
    stream({}, { systemPrompt: "pi", messages: [], tools: [tool] }, {});
    expect(writeSchemaFile).toHaveBeenLastCalledWith([
      { name: "read", description: "pi read", inputSchema: tool.parameters },
    ]);
    stream({}, { systemPrompt: "pi", messages: [], tools: [] }, {});
    expect(writeSchemaFile).toHaveBeenLastCalledWith([]);
    expect(pi.getAllTools).not.toHaveBeenCalled();
    expect(streamViaCli).toHaveBeenCalledTimes(2);
    for (const event of [
      "model_select",
      "session_tree",
      "session_compact",
      "session_shutdown",
    ]) {
      await handlers.get(event)();
    }
    expect(retireAllCliProcesses).toHaveBeenCalledTimes(5);
    // No status-line channel: nothing from this provider lands in pi's footer.
    expect(setStatus).not.toHaveBeenCalled();
  });
});
