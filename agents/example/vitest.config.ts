import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript sources (the "strike-source" export condition), so tests never
// depend on a stale or missing build of @strike/sdk.
const conditions = ["strike-source", "node", "import", "module", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
