import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@strike/sdk", "@strike/mcp"],
  // The workspace SDK is consumed from source through its "strike-source" export condition, and its ESM imports
  // use ".js" specifiers for ".ts" files. Turbopack supports neither, so the app builds with webpack.
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.conditionNames = ["strike-source", "...", "import", "module", "require", "default"];
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    // Markdown imports become strings at build time (docs/STRIKE_SKILL.md, served at /skill.md and by /api/mcp).
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.push({ test: /\.md$/, type: "asset/source" });
    // viem/chains pulls in ox's Tempo helpers, which use a dynamic require webpack can't analyse (harmless).
    config.ignoreWarnings = [...(config.ignoreWarnings ?? []), { module: /ox[\\/]_esm[\\/]tempo/ }];
    return config;
  },
};

export default nextConfig;
