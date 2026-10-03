import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@strike/sdk", "@strike/mcp"],
  // Response headers on every route: no MIME sniffing, no full URLs in the Referer sent to other sites, and none of
  // the device APIs the app never uses. Framing is left alone (the demo and submission pages may embed the app).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  // Whether browsers read through /api/rpc, the server-side Alchemy proxy: on when the build sees ALCHEMY_API_KEY
  // (Vercel exposes its env vars to builds), or forced with NEXT_PUBLIC_STRIKE_RPC_PROXY=1/0. Only this flag is
  // inlined into the bundle; the key itself is read by the server at request time (src/lib/rpc/server.ts).
  env: {
    NEXT_PUBLIC_STRIKE_RPC_PROXY:
      process.env.NEXT_PUBLIC_STRIKE_RPC_PROXY ?? (process.env.ALCHEMY_API_KEY?.trim() ? "1" : "0"),
  },
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
