import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessGroup } from "../src/claude-process-pool";
import { InactivityTimeout } from "../src/errors";

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (condition: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return condition();
};

describe("killProcessGroup", () => {
  it("signals the process group first", () => {
    const calls: Array<[number, string]> = [];
    killProcessGroup(4242, (pid, signal) => void calls.push([pid, signal]));
    expect(calls).toEqual([[-4242, "SIGKILL"]]);
  });

  it("falls back to the process itself when it leads no group", () => {
    const calls: Array<number> = [];
    killProcessGroup(4242, (pid) => {
      calls.push(pid);
      if (pid < 0) throw new Error("ESRCH");
    });
    expect(calls).toEqual([-4242, 4242]);
  });

  it("is silent when the process is already gone", () => {
    expect(() =>
      killProcessGroup(4242, () => {
        throw new Error("ESRCH");
      }),
    ).not.toThrow();
  });

  it("kills a detached process together with the child it started", async () => {
    // The leader prints its child's pid; the child ignores SIGTERM and holds
    // no pipe, so nothing but a group kill ends it.
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath,
           ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
           { stdio: "ignore" });
         console.log(child.pid); setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const childPid = await new Promise<number>((resolve) =>
      leader.stdout.once("data", (chunk) => resolve(Number(String(chunk)))),
    );
    try {
      expect(isRunning(leader.pid!)).toBe(true);
      expect(isRunning(childPid)).toBe(true);

      killProcessGroup(leader.pid!);

      expect(await until(() => !isRunning(childPid))).toBe(true);
      expect(
        await until(
          () => leader.exitCode !== null || leader.signalCode !== null,
        ),
      ).toBe(true);
    } finally {
      for (const pid of [leader.pid!, childPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, as expected.
        }
      }
    }
  });
});

describe("InactivityTimeout", () => {
  it("tells pi's user what happened and which setting governs it", () => {
    const message = new InactivityTimeout({ seconds: 300 }).message;
    expect(message).toContain("stalled");
    expect(message).toContain("timed out after 300 seconds without output");
    expect(message).toContain("PI_CLAUDE_CLI_TIMEOUT_MS");
  });
});
