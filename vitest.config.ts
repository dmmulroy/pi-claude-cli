import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Hermetic environment — see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // The modules unit tests cover: the ones that stay pure. The Effect
      // services are gated by `npm run test:scenarios` instead.
      include: [
        "src/event-bridge.ts",
        "src/overflow.ts",
        "src/pi-context.ts",
        "src/thinking-config.ts",
        "src/tool-mapping.ts",
      ],
      thresholds: {
        lines: 92,
        functions: 92,
        branches: 85,
        statements: 92,
      },
    },
  },
});
