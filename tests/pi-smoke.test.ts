import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Smoke test against the pi this repository installs: the real pi binary
 * loads the working tree as an extension and lists the provider's models.
 * The only CLI involved is the stub answering `claude auth status`, which
 * the provider's auth check asks; no model is called.
 */

const repo = resolve(__dirname, "..");
// The package exports no `./package.json`, so it is read from where npm put it.
const piPackagePath = join(
  repo,
  "node_modules/@earendil-works/pi-coding-agent/package.json",
);
const piPackage: { version: string; bin: Record<string, string> } = JSON.parse(
  readFileSync(piPackagePath, "utf8"),
);
const piBinary = join(dirname(piPackagePath), piPackage.bin.pi);

const scratch = mkdtempSync(join(tmpdir(), "pi-claude-cli-smoke-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the installed pi", () => {
  it("is a 1.x release", () => {
    expect(Number(piPackage.version.split(".")[0])).toBeGreaterThanOrEqual(1);
  });

  /** The provider's rows of `pi --list-models`, with `claude` found on `path`. */
  const listedModels = async (name: string, path: string) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        piBinary,
        // Only the working tree: an installed copy of this package would
        // otherwise win the provider name.
        "-ne",
        "-e",
        repo,
        "--offline",
        "--list-models",
        "pi-claude-cli",
      ],
      {
        cwd: scratch,
        timeout: 60_000,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(scratch, name, "agent"),
          XDG_STATE_HOME: join(scratch, name, "state"),
          PI_CLAUDE_CLI_TRACE: "off",
          PATH: path,
        },
      },
    );
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("pi-claude-cli"));
  };

  it("loads the extension and registers the pi-claude-cli provider", async () => {
    // The stub CLI, logged in: the provider is configured.
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(repo, "tests/e2e/claude-stub.cjs"), join(bin, "claude"));
    const rows = await listedModels(
      "stub",
      `${bin}:${dirname(process.execPath)}`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => /\bclaude-haiku-4-5\b/.test(row))).toBe(true);
  }, 90_000);

  it("offers no models when there is no Claude CLI to use", async () => {
    // No `claude` to find: registration still works, and pi hides the models.
    const rows = await listedModels("none", dirname(process.execPath));
    expect(rows).toEqual([]);
  }, 90_000);
});
