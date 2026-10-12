import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

// Real pi runtime and Claude subscription. The intervening provider is a local
// deterministic stream, so this tests switching without requiring a second login.
it.skipIf(process.env.PI_OWNED_LIVE !== "1")(
  "executes pi tools/guards and switches Claude -> native -> Claude in one pi session",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-owned-rpc-"));
    const token = `NATIVE-${Date.now()}`;
    mkdirSync(join(cwd, "agent"));
    writeFileSync(
      join(cwd, "agent", "settings.json"),
      JSON.stringify({
        compaction: {
          enabled: true,
          // Small enough that this short session always has something
          // older than the kept tail. At 128 the manual compaction below
          // failed with "session too small" whenever the model answered
          // tersely: the whole session is only about 180 estimated tokens.
          keepRecentTokens: 32,
          reserveTokens: 2048,
        },
      }),
    );
    writeFileSync(join(cwd, "visible.txt"), "before\n");
    writeFileSync(join(cwd, "forbidden.txt"), "must-not-be-read\n");
    const extension = join(cwd, "native-fixture.ts");
    writeFileSync(
      extension,
      `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.on("tool_call", event => {
    if (event.toolName === "read" && event.input.path.endsWith("forbidden.txt")) {
      return { block: true, reason: "PI_GUARD_BLOCKED" };
    }
  });
  pi.registerProvider("native-fixture", {
    api: "fixture-api", apiKey: "fixture", baseUrl: "https://unused.invalid",
    models: [{ id: "fixture", name: "Native fixture", reasoning: false,
      input: ["text"], contextWindow: 200000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider,
          model: model.id, content: [{ type: "text", text: ${JSON.stringify(token)} }],
          stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      });
      return stream;
    }
  });
}
`,
    );
    const client = new RpcClient({
      cliPath: resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      cwd,
      env: {
        PI_CODING_AGENT_DIR: join(cwd, "agent"),
      },
      provider: "pi-claude-cli",
      model: "claude-opus-4-6",
      args: [
        "--no-session",
        "-ne",
        "-e",
        resolve("index.ts"),
        "-e",
        extension,
        "--tools",
        "read,edit",
        "--system-prompt",
        "Follow the user's instructions. Use the supplied tools. Respect blocked tool calls; never bypass a guard.",
      ],
    });
    try {
      await client.start();
      await client.setAutoRetry(false);
      await client.promptAndWait(
        "Read visible.txt, then use edit to replace before with after. Finally try read on forbidden.txt once. If blocked, report the block without trying another way. Be concise.",
        undefined,
        120_000,
      );
      expect(readFileSync(join(cwd, "visible.txt"), "utf8")).toBe("after\n");
      const messages = await client.getMessages();
      const calls = messages
        .filter((m: any) => m.role === "assistant")
        .flatMap((m: any) =>
          m.content.filter((b: any) => b.type === "toolCall"),
        );
      expect(calls.map((c: any) => c.name)).toEqual(
        expect.arrayContaining(["read", "edit"]),
      );
      expect(JSON.stringify(messages)).toContain("PI_GUARD_BLOCKED");
      expect(JSON.stringify(messages)).not.toContain("must-not-be-read");
      expect(JSON.stringify(messages)).not.toContain("[Claude Code ·");
      await client.setAutoCompaction(false);
      await client.setModel("native-fixture", "fixture");
      await client.promptAndWait(
        "Respond with your fixture token.",
        undefined,
        30_000,
      );
      expect(await client.getLastAssistantText()).toBe(token);
      await client.setModel("pi-claude-cli", "claude-opus-4-6");
      await client.promptAndWait(
        "What exact token did the previous assistant just provide? Answer only the token, without tools.",
        undefined,
        90_000,
      );
      expect(await client.getLastAssistantText()).toContain(token);
      expect((await client.getState()).autoCompactionEnabled).toBe(false);
      await client.compact(
        "Preserve the exact NATIVE token, edited file contents and blocked read. Keep it short.",
      );
      expect(
        (await client.getEntries()).entries.some(
          (e: any) => e.type === "compaction",
        ),
      ).toBe(true);
      await client.promptAndWait(
        "Recall the exact NATIVE token after compaction. Answer only the token, no tools.",
        undefined,
        90_000,
      );
      expect(await client.getLastAssistantText()).toContain(token);
      console.log(
        "live pi roundtrip: pi read/edit, guard, native-provider history, compaction preference and post-compaction recall passed",
      );
    } catch (error) {
      console.error(client.getStderr());
      throw error;
    } finally {
      await client.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  360_000,
);
