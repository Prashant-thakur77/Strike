import { defineConfig } from "@playwright/test";

// Runs against a production build: `pnpm build && pnpm e2e`. Local-chain tests need a Strike devnet at
// E2E_RPC (default http://127.0.0.1:8545) and the app built with NEXT_PUBLIC_LOCAL_RPC pointing at it.
const PORT = Number(process.env.E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./node_modules/.cache/playwright/results",
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    colorScheme: "light",
  },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  ],
});
