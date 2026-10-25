import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { InactivityTimeout } from "../src/errors";

/**
 * Ctrl-C in `pi -p` while the CLI is mid-turn. The terminal signals pi's
 * process group; pi exits without running exit handlers, and the real CLI
 * keeps a running model request going when only its stdin closes. So the
 * CLI must be in pi's group to get the signal itself. The stub behaves like
 * the real CLI here: a closed stdin does not end its turn.
 */

const repo = resolve(__dirname, "..");
const piBinary = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const scratch = mkdtempSync(join(tmpdir(), "pi-claude-cli-interrupt-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return condition();
};

describe("Ctrl-C in print mode", () => {
  it("ends the CLI along with pi while a turn is running", async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    copyFileSync(join(repo, "tests/e2e/claude-stub.cjs"), join(bin, "claude"));
    chmodSync(join(bin, "claude"), 0o755);
    const pidFile = join(scratch, "cli.pid");

    // Its own group, like a shell job: the group is what Ctrl-C signals.
    const pi = spawn(
      process.execPath,
      [
        piBinary,
        "-ne",
        "-e",
        repo,
        "--offline",
        "-p",
        "--model",
        "pi-claude-cli/claude-haiku-4-5",
        "hang",
      ],
      {
        cwd: scratch,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PI_CODING_AGENT_DIR: join(scratch, "agent"),
          XDG_STATE_HOME: join(scratch, "state"),
          PI_CLAUDE_CLI_TRACE: "off",
          CLAUDE_STUB_PID_FILE: pidFile,
        },
      },
    );
    let cliPid = 0;
    try {
      expect(await until(() => existsSync(pidFile), 30_000)).toBe(true);
      cliPid = Number(readFileSync(pidFile, "utf8"));
      expect(isRunning(cliPid)).toBe(true);

      process.kill(-pi.pid!, "SIGINT");

      expect(await until(() => !isRunning(pi.pid!), 5_000)).toBe(true);
      expect(await until(() => !isRunning(cliPid), 5_000)).toBe(true);
    } finally {
      for (const pid of [cliPid, pi.pid!])
        if (pid > 0 && isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  }, 60_000);
});

describe("InactivityTimeout", () => {
  it("tells pi's user what happened and which setting governs it", () => {
    const message = new InactivityTimeout({ seconds: 300 }).message;
    expect(message).toContain("stalled");
    expect(message).toContain("timed out after 300 seconds without output");
    expect(message).toContain("PI_CLAUDE_CLI_TIMEOUT_MS");
  });
});
