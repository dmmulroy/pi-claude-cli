/** Opt-in real CLI proof; uses scratch context/tools, never user integrations. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import * as processManager from "../src/process-manager";
import { streamViaCli } from "../src/provider";
import { startHandoffBroker, stopHandoffBroker } from "../src/handoff-broker";
import { writeSchemaFile, cleanupMcpConfigFiles } from "../src/mcp-config";
import { takeParkedCliProcess } from "../src/cli-process";
import { createReadTool } from "@earendil-works/pi-coding-agent";

const LIVE = process.env.PI_OWNED_LIVE === "1";
const model = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 8192,
} as any;

describe.skipIf(!LIVE)("live pi-owned default", () => {
  let ws: string;
  let schema: ReturnType<typeof writeSchemaFile>;
  let socket: string;
  let init: any;
  const processes: ReturnType<typeof processManager.spawnClaude>[] = [];
  const sessionId = `context-proof-${Date.now()}`;
  const messages: any[] = [];
  let prompt: string;
  let nativeRead: ReturnType<typeof createReadTool>;
  const cliIds: string[] = [];

  beforeAll(async () => {
    ws = realpathSync.native(mkdtempSync(join(tmpdir(), "pcc-context-")));
    vi.stubEnv("PI_CLAUDE_CLI_SYSTEM_PROMPT", "claude");
    vi.stubEnv("PI_CLAUDE_CLI_STATE_DIR", join(ws, "state"));
    vi.stubEnv("ENABLE_TOOL_SEARCH", "false");
    vi.stubEnv("CLAUDE_CODE_SIMPLE", "0");
    vi.stubEnv("CLAUDE_CODE_SAFE_MODE", "0");
    mkdirSync(join(ws, ".claude", "skills", "foreign-skill"), {
      recursive: true,
    });
    mkdirSync(join(ws, ".pi", "skills", "pi-probe"), { recursive: true });
    mkdirSync(join(ws, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "agents", "foreign-agent.md"),
      "---\nname: foreign-agent\ndescription: CLI_ONLY_AGENT_SENTINEL\n---\nDo not use.\n",
    );
    writeFileSync(
      join(ws, "CLAUDE.md"),
      "CLI_ONLY_CONTEXT_SENTINEL: this must not be independently loaded.\n",
    );
    writeFileSync(
      join(ws, ".claude", "skills", "foreign-skill", "SKILL.md"),
      "---\nname: foreign-skill\ndescription: CLI_ONLY_SKILL_SENTINEL\n---\nDo not use.\n",
    );
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node -e "require('fs').writeFileSync('foreign-hook-ran','bad')"`,
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          foreign: {
            command: "node",
            args: [
              "-e",
              "require('fs').writeFileSync('foreign-mcp-ran','bad')",
            ],
          },
        },
      }),
    );
    writeFileSync(join(ws, "payload.txt"), "PI_FILE\n");
    const skillPath = join(ws, ".pi", "skills", "pi-probe", "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: pi-probe\ndescription: Read the test skill word.\n---\nThe skill word is PI_SKILL.\n",
    );
    const hook = join(ws, "host-hook.cjs");
    writeFileSync(
      hook,
      "require('fs').appendFileSync(require('path').join(__dirname,'host-hook-ran'),'read\\n');",
    );
    const settings = join(ws, "host-settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__custom-tools__read",
              hooks: [{ type: "command", command: `node "${hook}"` }],
            },
          ],
        },
      }),
    );
    vi.stubEnv("PI_CLAUDE_CLI_SETTINGS", settings);
    nativeRead = createReadTool(ws);
    schema = writeSchemaFile([
      {
        name: "read",
        description: nativeRead.description,
        inputSchema: nativeRead.parameters as any,
      },
      {
        name: "context_probe",
        description:
          "Return the test tool word. Call exactly once when asked for the tool word.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    socket = await startHandoffBroker();
    prompt = `You are an expert coding assistant operating inside pi, a coding agent harness.\n\nAvailable tools:\n- read: Read files\n- context_probe: Return the test tool word\n\nGuidelines:\n- Use read to examine files\n\nPi documentation (not needed for this task):\n\n<project_context>Project word: PI_PROJECT</project_context>\n\n<available_skills><skill><name>pi-probe</name><description>Read the test skill word.</description><location>${skillPath}</location></skill></available_skills>`;
    const realSpawn = processManager.spawnClaude;
    vi.spyOn(processManager, "spawnClaude").mockImplementation((...args) => {
      const proc = realSpawn(...args);
      processes.push(proc);
      let buffer = "";
      proc.stdout!.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.type === "system" && msg.subtype === "init") {
              init = msg;
              cliIds.push(msg.session_id);
            }
          } catch {
            /* framing-only capture */
          }
        }
      });
      return proc;
    });
  });

  async function turn(text: string): Promise<any> {
    messages.push({ role: "user", content: text });
    for (let cycle = 0; cycle < 5; cycle++) {
      const stream = streamViaCli(model, { systemPrompt: prompt, messages }, {
        sessionId,
        cwd: ws,
        mcpConfig: { ...schema, handoffSocket: socket },
      } as any);
      const reply = await stream.result();
      expect(reply.stopReason).not.toBe("error");
      messages.push(reply);
      const calls = reply.content.filter((b) => b.type === "toolCall");
      if (!calls.length) return reply;
      for (const call of calls) {
        expect(["read", "context_probe"]).toContain(call.name);
        const content =
          call.name === "read"
            ? (await nativeRead.execute(call.id, call.arguments as any)).content
            : [{ type: "text", text: "PI_TOOL" }];
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
    throw new Error("Exceeded bounded tool cycles");
  }

  it(
    "uses only pi tools, stays warm, reimports a native turn, and persists no CLI session",
    { timeout: 180000 },
    async () => {
      const first = await turn(
        "Use the pi read tool to read payload.txt and the listed pi-probe skill file. Call context_probe once. Reply with the project word, file word, skill word and tool word. No other files or shell commands.",
      );
      const text = first.content.map((b: any) => b.text ?? "").join("\n");
      for (const word of ["PI_PROJECT", "PI_FILE", "PI_SKILL", "PI_TOOL"])
        expect(text).toContain(word);
      expect(
        messages.filter(
          (m) => m.role === "toolResult" && m.toolName === "context_probe",
        ),
      ).toHaveLength(1);
      expect(init.tools).toEqual(
        expect.arrayContaining([
          "mcp__custom-tools__read",
          "mcp__custom-tools__context_probe",
        ]),
      );
      expect(init.skills ?? []).toEqual([]);
      expect(init.tools).not.toContain("Skill");
      expect(JSON.stringify(init.agents ?? [])).not.toContain("foreign-agent");
      expect(init.mcp_servers.map((s: any) => s.name)).toEqual([
        "custom-tools",
      ]);
      expect(existsSync(join(ws, "foreign-hook-ran"))).toBe(false);
      expect(existsSync(join(ws, "foreign-mcp-ran"))).toBe(false);
      expect(existsSync(join(ws, "host-hook-ran"))).toBe(true);
      expect(
        init.tools.filter(
          (name: string) => !name.startsWith("mcp__custom-tools__"),
        ),
      ).toEqual([]);
      const second = await turn(
        "Repeat the four words from your previous answer. No tools.",
      );
      for (const word of ["PI_PROJECT", "PI_FILE", "PI_SKILL", "PI_TOOL"])
        expect(
          second.content.map((b: any) => b.text ?? "").join("\n"),
        ).toContain(word);
      expect(processes).toHaveLength(1);
      messages.push(
        { role: "user", content: "Remember NATIVE_HANDOFF_793." },
        {
          role: "assistant",
          provider: "openai-codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "Remembered NATIVE_HANDOFF_793." }],
        },
      );
      const third = await turn(
        "What word did the other provider just remember? Reply with it only, no tools.",
      );
      expect(third.content.map((b: any) => b.text ?? "").join("")).toContain(
        "NATIVE_HANDOFF_793",
      );
      expect(processes).toHaveLength(2);
      await takeParkedCliProcess(sessionId)?.retire();
      const root = join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      );
      for (const cliId of cliIds) {
        expect(
          readdirSync(root).some((dir) =>
            existsSync(join(root, dir, `${cliId}.jsonl`)),
          ),
        ).toBe(false);
      }
      expect(existsSync(join(ws, "state", "session-map.json"))).toBe(false);
      console.log(
        JSON.stringify({
          proof: "pi-owned-default",
          promptCharacters: prompt.length,
          piProjectCopies: 1,
          piSkillIndexes: 1,
          nativeSkillCount: (init.skills ?? []).length,
          nativeTools: init.tools.filter(
            (name: string) => !name.startsWith("mcp__"),
          ),
          mcpServers: init.mcp_servers.map((s: any) => s.name),
          processCount: processes.length,
          firstInputContext: first.usage.totalTokens,
          secondInputContext: second.usage.totalTokens,
          secondCacheRead: second.usage.cacheRead,
        }),
      );
    },
  );

  afterAll(async () => {
    await takeParkedCliProcess(sessionId)?.retire();
    for (const proc of processes)
      if (proc.exitCode === null) proc.kill("SIGKILL");
    stopHandoffBroker();
    cleanupMcpConfigFiles();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (ws) rmSync(ws, { recursive: true, force: true });
  });
});
