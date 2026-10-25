/**
 * Live: pi's thinking level, changed mid-session, reaches the model on the
 * very next turn through ONE Claude CLI process.
 *
 * What the model receives is read off the wire: a `claude` wrapper points
 * the CLI at a local proxy that forwards to api.anthropic.com and records four
 * request-body fields (model, thinking, output_config, tool count). It never
 * records headers, so no credential is written anywhere. A `claude` wrapper
 * first on PATH counts real turn processes, so "no respawn" is measured, not
 * inferred.
 *
 * Runs only with PI_OWNED_LIVE=1 and an authenticated Claude Code.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

interface WireRequest {
  model: string;
  thinking: any;
  effort: string | undefined;
  tools: number;
}

/** Local forwarding proxy that keeps request bodies' thinking fields only. */
async function startProxy() {
  const requests: WireRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (Array.isArray(parsed?.messages))
          requests.push({
            model: String(parsed.model),
            thinking: parsed.thinking ?? null,
            effort: parsed.output_config?.effort,
            tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          });
      } catch {
        /* not JSON: forward untouched */
      }
      const upstream = https.request(
        {
          host: "api.anthropic.com",
          port: 443,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: "api.anthropic.com" },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      upstream.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A `claude` on PATH that records each turn process, then runs the real one
 * against the recording proxy.
 *
 * The wrapper, not pi's environment, points the CLI at the proxy: the
 * provider never forwards ANTHROPIC_BASE_URL to the CLI, so setting it on pi
 * would be stripped before it got here.
 *
 * pi and this test may run under a scratch HOME; the real CLI gets the
 * account's own home (from the passwd entry, not the environment), because
 * that is where its login lives. It writes no transcript either way: the
 * provider spawns it with --no-session-persistence.
 */
function spawnCounter(dir: string, proxyUrl: string) {
  const real = execSync("command -v claude", { encoding: "utf8" }).trim();
  const home = userInfo().homedir;
  const log = join(dir, "spawns.log");
  writeFileSync(log, "");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "claude");
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase "$*" in *--input-format*) echo spawn >> "${log}";; esac\nANTHROPIC_BASE_URL="${proxyUrl}" HOME="${home}" exec "${real}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return {
    bin,
    count: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
  };
}

type Expect = (r: WireRequest) => void;
const budget =
  (n: number): Expect =>
  (r) =>
    expect(r.thinking).toEqual({
      type: "enabled",
      budget_tokens: n,
      display: "summarized",
    });
const adaptive =
  (effort: string): Expect =>
  (r) => {
    expect(r.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(r.effort).toBe(effort);
  };
const disabled: Expect = (r) => expect(r.thinking).toEqual({ type: "disabled" });

const MODELS: Array<{
  id: string;
  levels: string[];
  turns: Array<[string, Expect]>;
}> = [
  {
    id: "claude-haiku-4-5",
    levels: ["off", "minimal", "low", "medium", "high"],
    turns: [
      ["medium", budget(8192)],
      ["off", disabled],
      ["high", budget(16384)],
      ["minimal", budget(1024)],
    ],
  },
  {
    id: "claude-sonnet-5",
    // minimal is not offered: on an adaptive model it is low.
    levels: ["off", "low", "medium", "high", "xhigh", "max"],
    turns: [
      ["medium", adaptive("medium")],
      ["off", disabled],
      ["xhigh", adaptive("xhigh")],
      ["low", adaptive("low")],
    ],
  },
];

describe.skipIf(process.env.PI_OWNED_LIVE !== "1")(
  "live: thinking level changes mid-session",
  () => {
    it.each(MODELS)(
      "$id: every turn runs at the level set before it, on one CLI process",
      async ({ id, levels, turns }) => {
        const dir = mkdtempSync(join(tmpdir(), "pcc-live-thinking-"));
        mkdirSync(join(dir, "agent"));
        writeFileSync(join(dir, "agent", "settings.json"), "{}");
        const proxy = await startProxy();
        const spawns = spawnCounter(dir, proxy.url);
        const client = new RpcClient({
          cliPath: resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
          cwd: dir,
          env: {
            PI_CODING_AGENT_DIR: join(dir, "agent"),
            XDG_STATE_HOME: join(dir, "state"),
            PATH: `${spawns.bin}:${process.env.PATH}`,
          },
          provider: "pi-claude-cli",
          model: id,
          args: [
            "--no-session",
            "-ne",
            "-e",
            resolve("index.ts"),
            "--tools",
            "bash",
            "--system-prompt",
            "Answer tersely.",
          ],
        });
        const turnRequests = (from: number) =>
          proxy.requests.slice(from).filter((r) => r.tools > 0);
        try {
          await client.start();
          await client.setAutoRetry(false);
          // The picker offers what pi offers for this model natively.
          expect(await client.getAvailableThinkingLevels()).toEqual(levels);

          for (const [i, [level, check]] of turns.entries()) {
            await client.setThinkingLevel(level as any);
            const mark = proxy.requests.length;
            await client.promptAndWait(
              `Question ${i + 1}: what is ${17 + i} * ${23 + i}? Think it through, then reply with just the number.`,
              undefined,
              120_000,
            );
            const sent = turnRequests(mark);
            expect(sent.length, `turn at ${level}`).toBeGreaterThan(0);
            for (const r of sent) check(r);
          }
          expect(spawns.count(), "one CLI process for every turn").toBe(1);

          // Budget models always think when enabled: the summary must reach pi.
          if (id === "claude-haiku-4-5") {
            const messages = await client.getMessages();
            const thoughts = messages
              .filter((m: any) => m.role === "assistant")
              .flatMap((m: any) =>
                m.content.filter((b: any) => b.type === "thinking" && b.thinking?.trim()),
              );
            expect(thoughts.length).toBeGreaterThan(0);
          }
          console.log(
            `live thinking ${id}: ${turns.map(([l]) => l).join(" -> ")} on 1 process, ${proxy.requests.filter((r) => r.tools > 0).length} requests checked`,
          );
        } catch (error) {
          console.error(client.getStderr());
          console.error(JSON.stringify(proxy.requests, null, 1));
          throw error;
        } finally {
          await client.stop();
          await proxy.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      600_000,
    );

    it("a change made while a tool runs lands on the next user turn, still on one process", async () => {
      const id = "claude-haiku-4-5";
      const dir = mkdtempSync(join(tmpdir(), "pcc-live-thinking-"));
      mkdirSync(join(dir, "agent"));
      writeFileSync(join(dir, "agent", "settings.json"), "{}");
      const proxy = await startProxy();
      const spawns = spawnCounter(dir, proxy.url);
      const client = new RpcClient({
        cliPath: resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        cwd: dir,
        env: {
          PI_CODING_AGENT_DIR: join(dir, "agent"),
          XDG_STATE_HOME: join(dir, "state"),
          PATH: `${spawns.bin}:${process.env.PATH}`,
        },
        provider: "pi-claude-cli",
        model: id,
        args: [
          "--no-session",
          "-ne",
          "-e",
          resolve("index.ts"),
          "--tools",
          "bash",
          "--system-prompt",
          "Use the tools you are given when asked. Answer tersely.",
        ],
      });
      try {
        await client.start();
        await client.setAutoRetry(false);
        await client.setThinkingLevel("high");
        let changed = false;
        const stop = client.onEvent((e: any) => {
          if (e.type === "tool_execution_start" && !changed) {
            changed = true;
            void client.setThinkingLevel("low");
          }
        });
        const mark = proxy.requests.length;
        await client.promptAndWait(
          "Run `sleep 4; echo SLEPT` with the bash tool, then reply with exactly what it printed.",
          undefined,
          180_000,
        );
        stop();
        expect(changed).toBe(true);
        const during = proxy.requests.slice(mark).filter((r) => r.tools > 0);
        // Before the tool and after it: the CLI reads thinking once per turn.
        expect(during.length).toBeGreaterThanOrEqual(2);
        for (const r of during) budget(16384)(r);

        const next = proxy.requests.length;
        await client.promptAndWait("Reply with just: done", undefined, 120_000);
        const after = proxy.requests.slice(next).filter((r) => r.tools > 0);
        expect(after.length).toBeGreaterThan(0);
        for (const r of after) budget(2048)(r);
        expect(spawns.count()).toBe(1);
        console.log(
          "live thinking mid-turn: change during a tool call applied on the next user turn, 1 process",
        );
      } catch (error) {
        console.error(client.getStderr());
        console.error(JSON.stringify(proxy.requests, null, 1));
        throw error;
      } finally {
        await client.stop();
        await proxy.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
