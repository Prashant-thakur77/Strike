// What the SDK derives from strike.config.json (chains, public and Alchemy RPCs, endpoint selection) must not change
// when its source moves into the config: this snapshot was written from the code before the move (sdk/src/chains.ts
// and rpc.ts with viem's chain list and the hard-coded Alchemy networks) and every value is compared after it. The
// deployments map was in it too while the move was proven (commit 26fd410); it is left out now because deployment
// files change with every deployment, and config.test.ts checks the map against the files the config lists.
// A deliberate change to a chain's RPC or explorer in strike.config.json changes this snapshot: regenerate it with
// STRIKE_UPDATE_SNAPSHOT=1 pnpm --filter @strike/sdk test configSnapshot
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import fixture from "./fixtures/config-snapshot.json?raw";

const CHAIN_IDS = [4663, 46630, 42161, 421614, 31337, 412346, 1];
const KEY = "snapshotKey_0123456789";
const ENVS: Record<string, Record<string, string>> = {
  none: {},
  alchemy: { ALCHEMY_API_KEY: KEY },
  custom: { STRIKE_RPC_URL: "https://rpc.example.org/strike" },
  both: { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: "https://rpc.example.org/strike" },
  loopback: { ALCHEMY_API_KEY: KEY, STRIKE_RPC_URL: "http://127.0.0.1:8545" },
  alchemyUrl: { STRIKE_RPC_URL: "https://robinhood-testnet.g.alchemy.com/v2/abcdefgh12345678" },
  badKey: { ALCHEMY_API_KEY: "${ALCHEMY_API_KEY}" },
};

/** JSON-safe copy: functions become "[function]", bigints "<n>n". */
const plain = (x: unknown): unknown =>
  x === undefined
    ? null
    : JSON.parse(
        JSON.stringify(x, (_k, v: unknown) =>
          typeof v === "function" ? "[function]" : typeof v === "bigint" ? `${v}n` : v,
        ),
      );

const attempt = (f: () => unknown) => {
  try {
    return { ok: plain(f()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const perChain = (f: (id: number) => unknown) =>
  Object.fromEntries(CHAIN_IDS.map((id) => [id, attempt(() => f(id))]));
const perChainEnv = (f: (id: number, env: Record<string, string>) => unknown) =>
  Object.fromEntries(
    CHAIN_IDS.map((id) => [
      id,
      Object.fromEntries(Object.entries(ENVS).map(([name, env]) => [name, attempt(() => f(id, env))])),
    ]),
  );

function snapshot() {
  return {
    exports: Object.keys(sdk).sort(),
    strikeChains: plain(sdk.strikeChains),
    strikeChainIds: plain(sdk.strikeChainIds),
    strikeLocalChain: plain(sdk.strikeLocalChain),
    getStrikeChain: perChain((id) => sdk.getStrikeChain(id)),
    ALCHEMY_NETWORKS: plain(sdk.ALCHEMY_NETWORKS),
    alchemyEndpoint: perChain((id) => sdk.alchemyEndpoint(id)),
    publicRpcUrl: perChain((id) => sdk.publicRpcUrl(id)),
    rpcEndpointsFor: perChainEnv((id, env) => sdk.rpcEndpointsFor(id, env)),
    rpcUrlFor: perChainEnv((id, env) => sdk.rpcUrlFor(id, env)),
    describeRpc: perChainEnv((id, env) => sdk.describeRpc(sdk.rpcEndpointsFor(id, env))),
    DEPLOYMENT_ENV: plain(sdk.DEPLOYMENT_ENV),
  };
}

type Fs = { writeFileSync(path: string, data: string): void };
const proc = (
  globalThis as {
    process?: { env?: Record<string, string | undefined>; getBuiltinModule?(id: string): unknown };
  }
).process;

describe("config-derived SDK values (snapshot from before strike.config.json)", () => {
  const now = snapshot();
  if (proc?.env?.STRIKE_UPDATE_SNAPSHOT === "1") {
    const fs = proc.getBuiltinModule?.("node:fs") as Fs;
    fs.writeFileSync(
      new URL("./fixtures/config-snapshot.json", import.meta.url).pathname,
      `${JSON.stringify(now, null, 2)}\n`,
    );
  }
  const before = JSON.parse(fixture) as ReturnType<typeof snapshot>;

  it("keeps every public export (new ones may be added)", () => {
    expect(now.exports).toEqual(expect.arrayContaining(before.exports));
  });

  for (const key of Object.keys(before).filter((k) => k !== "exports") as (keyof typeof before)[]) {
    it(`${key} is unchanged`, () => {
      expect(now[key]).toEqual(before[key]);
    });
  }
});
