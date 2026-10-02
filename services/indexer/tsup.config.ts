import { defineConfig } from "tsup";

// One self-contained file per entry: @strike/sdk (from its TypeScript sources), viem, pg, pino and fastify are
// bundled in, so the Docker image needs no node_modules. pg's optional native binding is never loaded.
export default defineConfig({
  entry: ["src/main.ts", "src/once.ts", "src/migrate-cli.ts", "src/compare-cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/.*/],
  external: ["pg-native"],
  banner: {
    // Bundled CommonJS dependencies (pg, pino) call require(); give the ES module one.
    js: 'import { createRequire as __strikeCreateRequire } from "node:module"; const require = __strikeCreateRequire(import.meta.url);',
  },
  esbuildOptions(options) {
    // esbuild adds "node", "import" or "require" (by the kind of import) and "default" itself; listing "import" here
    // would make a require() of pg load its ES module build.
    options.conditions = ["strike-source", "module"];
  },
});
