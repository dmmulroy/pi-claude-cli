import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["coverage/**", "node_modules/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "typescript/no-explicit-any": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        // Fixtures stand in for pi's and the CLI's loosely typed objects.
        files: ["tests/**"],
        rules: { "typescript/no-explicit-any": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["coverage/**", "node_modules/**"],
  },
  test: {
    globals: true,
    // Hermetic environment — see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // The modules unit tests cover: the ones that stay pure. The Effect
      // services are gated by `vp run test:scenarios` instead.
      include: [
        "src/account-models.ts",
        "src/cli-auth.ts",
        "src/event-bridge.ts",
        "src/overflow.ts",
        "src/pi-context.ts",
        "src/signed-thinking.ts",
        "src/subscription-env.ts",
        "src/thinking-config.ts",
        "src/tool-call-id.ts",
        "src/tool-mapping.ts",
        "src/usage-credits.ts",
      ],
      thresholds: { lines: 92, functions: 92, branches: 85, statements: 92 },
    },
  },
  run: {
    cache: { scripts: false, tasks: true },
  },
});
