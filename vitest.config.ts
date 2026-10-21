import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/eval/**/*.test.ts",
      "tests/visuals/**/*.test.ts",
    ],
    // The Playwright suite lives in `tests/e2e` and is run by `npm run
    // test:e2e`, not by Vitest. The `include` above already excludes it; the
    // explicit exclude keeps it excluded if the include is ever widened.
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**", "dist/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` THROWS when it is imported outside a React Server
      // Component. Its own `react-server` export condition resolves to
      // `empty.js`, which does nothing. The eval tests import the content
      // layer on purpose (to check the claim ledger), so the marker is
      // aliased to that empty export. Nothing else changes: the alias only
      // affects modules that import `server-only`, which previously threw.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
