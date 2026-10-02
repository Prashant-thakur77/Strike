import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources (the "strike-source" condition; no explicit "import", which
// would make a require() of pg load its ES module build). Every test file gets its
// own database on one real Postgres: TEST_DATABASE_URL when set (CI's service container), else an embedded
// Postgres started by test/global-setup.ts.
const conditions = ["strike-source", "module", "node"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
