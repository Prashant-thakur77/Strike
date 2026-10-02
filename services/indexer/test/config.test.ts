import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type IndexerSpec, findRoot, loadIndexerSpec, settingsFromEnv } from "../src/config.js";

const ROOT = findRoot(new URL(".", import.meta.url).pathname, {});
const scratch = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "strike-indexer-test-config");
mkdirSync(scratch, { recursive: true });
const tmp = mkdtempSync(join(scratch, "root-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const summary = (s: IndexerSpec) =>
  s.chains.map((c) => ({
    chainId: c.chainId,
    deployments: c.deployments.map((d) => ({
      id: d.id,
      deployBlock: d.deployBlock,
      epochManager: d.epochManager,
      kinds: d.contracts.map((k) => k.kind).join(","),
    })),
  }));

// A root with the deployment records and no strike.config.json, for the fallback path (the repository has the file).
const bare = mkdtempSync(join(scratch, "bare-"));
afterAll(() => rmSync(bare, { recursive: true, force: true }));
mkdirSync(join(bare, "contracts/deployments"), { recursive: true });
for (const f of ["46630", "46630-vaults", "46630-v3", "46630-v3-vaults", "421614", "421614-vaults"]) {
  copyFileSync(join(ROOT, `contracts/deployments/${f}.json`), join(bare, `contracts/deployments/${f}.json`));
}

describe("config", () => {
  const fallback = loadIndexerSpec({ root: bare, env: {} });

  it("without strike.config.json, reads the three deployment records the app counts", () => {
    expect(fallback.source).toBe("contracts/deployments");
    expect(summary(fallback)).toEqual([
      {
        chainId: 46630,
        deployments: [
          {
            id: "46630-v2",
            deployBlock: 125880607n,
            epochManager: "0x5a3b58df27e4dd5e0fa6493d90ff653e0e199c99",
            kinds:
              "epochManager,vaultFactory,agentRegistry,decisionLog,mirrorFeed,mirrorFeed,mirrorFeed,mirrorFeed,mirrorFeed,vault,vault",
          },
          {
            // v3 reads v2's five MirrorFeeds: they are watched once, by v2
            id: "46630-v3",
            deployBlock: 126713718n,
            epochManager: "0x256d4546486368dcb23e94758b4cb500c215929f",
            kinds: "epochManager,vaultFactory,agentRegistry,decisionLog,vault,vault",
          },
        ],
      },
      {
        chainId: 421614,
        deployments: [
          {
            id: "421614-v3",
            deployBlock: 314350623n,
            epochManager: "0xb8ed17588ab022d8f84b8305d784fa01478cb7f0",
            kinds: "epochManager,vaultFactory,agentRegistry,decisionLog,mirrorFeed,mirrorFeed,vault,vault",
          },
        ],
      },
    ]);
    expect(fallback.chains.map((c) => [c.name, c.short, c.explorer])).toEqual([
      ["Robinhood Chain testnet", "RH testnet", "https://explorer.testnet.chain.robinhood.com"],
      ["Arbitrum Sepolia", "Arb Sepolia", "https://sepolia.arbiscan.io"],
    ]);
    const feeds = fallback.chains[0]!.deployments[0]!.contracts.filter((c) => c.kind === "mirrorFeed");
    expect(feeds.map((f) => f.label)).toEqual(["AMD", "AMZN", "NFLX", "PLTR", "TSLA"]);
  });

  it("with strike.config.json (the cycle 13 schema), reads the same deployments from the files it lists", () => {
    mkdirSync(join(tmp, "contracts/deployments"), { recursive: true });
    for (const f of ["46630", "46630-vaults", "46630-v3", "46630-v3-vaults", "421614", "421614-vaults"]) {
      copyFileSync(
        join(ROOT, `contracts/deployments/${f}.json`),
        join(tmp, `contracts/deployments/${f}.json`),
      );
    }
    writeFileSync(
      join(tmp, "strike.config.json"),
      JSON.stringify({
        version: 1,
        chains: {
          "46630": {
            name: "Robinhood Chain testnet",
            explorer: "https://explorer.testnet.chain.robinhood.com",
            rpc: {
              public: "https://rpc.testnet.chain.robinhood.com",
              alchemy: "https://robinhood-testnet.g.alchemy.com/v2",
            },
            deployments: ["contracts/deployments/46630.json", "contracts/deployments/46630-v3.json"],
            mainnetFeedsChain: "4663",
          },
          "421614": {
            name: "Arbitrum Sepolia",
            explorer: "https://sepolia.arbiscan.io/",
            deployments: ["contracts/deployments/421614.json"],
          },
          "4663": {
            name: "Robinhood Chain",
            explorer: "https://explorer.chain.robinhood.com",
            deployments: [],
          },
        },
        services: { app: "https://strike-options.vercel.app", indexer: { port: 8899 } },
        secrets: { databaseUrl: "DATABASE_URL" },
      }),
    );
    const spec = loadIndexerSpec({ root: tmp, env: {} });
    expect(spec.source).toBe("strike.config.json");
    expect(spec.port).toBe(8899);
    expect(summary(spec)).toEqual(summary(fallback));
    expect(spec.chains.map((c) => c.explorer)).toEqual([
      "https://explorer.testnet.chain.robinhood.com",
      "https://sepolia.arbiscan.io",
    ]);
    expect(settingsFromEnv({}, spec).port).toBe(8899);
    expect(settingsFromEnv({ PORT: "9000" }, spec).port).toBe(9000);
  });

  it("the repository's strike.config.json gives the same deployments, without the local devnet unless asked", () => {
    const repo = loadIndexerSpec({ root: ROOT, env: {} });
    expect(repo.source).toBe("strike.config.json");
    expect(summary(repo)).toEqual(summary(fallback));
    const local = loadIndexerSpec({ root: ROOT, env: {}, chains: [31337] });
    expect(local.chains.map((c) => c.chainId)).toEqual([31337]);
  });

  it("limits the chains to INDEXER_CHAINS", () => {
    const s = settingsFromEnv({ INDEXER_CHAINS: "421614" });
    expect(s.chains).toEqual([421614]);
    expect(loadIndexerSpec({ root: ROOT, env: {}, chains: s.chains }).chains.map((c) => c.chainId)).toEqual([
      421614,
    ]);
  });

  it("validates the environment", () => {
    expect(settingsFromEnv({})).toMatchObject({
      port: 8787,
      confirmations: 5n,
      pollIntervalMs: 10_000,
      maxRange: 500_000n,
      readyMaxLagBlocks: 1000,
      tvlIntervalMs: 300_000,
    });
    expect(() => settingsFromEnv({ CONFIRMATIONS: "-1" })).toThrow("invalid CONFIRMATIONS");
    expect(() => settingsFromEnv({ INDEXER_CHAINS: "46630,abc" })).toThrow("invalid INDEXER_CHAINS entry");
    expect(() => settingsFromEnv({ PORT: "0" })).toThrow("invalid PORT");
  });
});
