import type { Page } from "@playwright/test";
import {
  createPublicClient,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionResult,
  http,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { rpcTraffic } from "./helpers";

// Lifecycle fixtures for the live vault pages. A live vault moves through four states in a week: selling, expired but
// not settled (still Selling on chain until the first price round at or after expiry exists), settled (Idle), and the
// next epoch open and waiting for a proposal. The live specs read the state the chain is in now and assert what that
// state should show; these patches put the page in each state on demand, so every state is tested whatever the week
// is doing. They rewrite the page's own eth_call answers (direct and inside Multicall3 batches), as market.spec.ts
// does for the market hours; nothing on chain changes.

export type LivePhase = "selling" | "expired" | "settled" | "open";

const EPOCHS = toFunctionSelector("epochs(address)");
const GET_SERIES = toFunctionSelector("getSeries(uint256)");
const STATUS = toFunctionSelector("status(address)");
const QUOTE_BUY = toFunctionSelector("quoteBuy(uint256,uint256)");
const IS_OPEN = toFunctionSelector("isMarketOpen()");
/** `EpochManager.spot(token)`, which reverts once the last print is older than the feed's `maxPriceAge`. */
export const SPOT = toFunctionSelector("spot(address)");
const AGGREGATE3 = toFunctionSelector("aggregate3((address,bool,bytes)[])");
export const STALE_PRICE = toFunctionSelector("StalePrice(uint256,uint256)");

/** `EpochManager.Series` is 16 static words. */
const SERIES = {
  expiry: 3,
  settled: 6,
  sold: 10,
  settlementPrice: 13,
  payoutPerOption: 14,
  escrow: 15,
} as const;
const SERIES_WORDS = 16;
/** `epochs(vault)`: state, openedAt, seriesId, openSpot, openSigma. */
const EPOCH = { state: 0, seriesId: 2 } as const;

export interface EthCall {
  to: string;
  data: Hex;
}
/**
 * Rewrite one eth_call answer. `result` is the answer's data (null when the call reverted). Return new data, a revert
 * with its data, or undefined to keep the answer.
 */
export type CallPatch = (call: EthCall, result: Hex | null) => Hex | { revert: Hex } | undefined;

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const words = (data: Hex) => data.slice(2).match(/.{64}/g) ?? [];

/** Set some 32-byte words of an ABI-encoded answer. */
export function setWords(data: Hex, set: Record<number, bigint>): Hex {
  const w = words(data);
  for (const [i, v] of Object.entries(set)) w[Number(i)] = word(v);
  return `0x${w.join("")}` as Hex;
}

/** The address argument of a call with one `address` parameter, lowercase. */
const addressArg = (data: Hex) => `0x${data.slice(10 + 24, 10 + 64)}`.toLowerCase();
const uintArg = (data: Hex, i: number) => BigInt(`0x${data.slice(10 + 64 * i, 10 + 64 * (i + 1))}`);

interface Rpc {
  id: number;
  method: string;
  params?: { to?: string; data?: Hex; input?: Hex }[];
}
type Answer = {
  id: number;
  jsonrpc?: string;
  result?: Hex;
  error?: { data?: Hex } & Record<string, unknown>;
};

/**
 * Pass a chain's RPC traffic from the page through, applying `patches` in order to each eth_call answer whose calldata
 * starts with one of `selectors` (and to those calls inside Multicall3 `aggregate3` batches).
 */
export async function patchEthCalls(
  page: Page,
  chainId: number,
  rpcUrl: string,
  selectors: Hex[],
  patches: CallPatch[],
): Promise<void> {
  const touches = (body: string) => selectors.some((s) => body.includes(s.slice(2)));
  const apply = (call: EthCall, result: Hex | null) => {
    let out: Hex | { revert: Hex } | null = result;
    for (const p of patches) {
      const next = p(call, typeof out === "string" ? out : null);
      if (next !== undefined) out = next;
    }
    return out;
  };
  await page.route(rpcTraffic(chainId, rpcUrl), async (route) => {
    const post = route.request().postData() ?? "";
    if (route.request().method() !== "POST" || !touches(post)) return route.continue();
    const body = JSON.parse(post) as Rpc | Rpc[];
    const calls = Array.isArray(body) ? body : [body];
    // The page keeps polling; a request still in flight when the test ends is dropped, not an error.
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    const json = (await res.json()) as Answer | Answer[];
    const answers = (Array.isArray(json) ? json : [json]).map((a): Answer => {
      const call = calls.find((c) => c.id === a.id);
      const p0 = call?.params?.[0];
      const data = p0?.data ?? p0?.input;
      if (!call || call.method !== "eth_call" || !data) return a;
      if (data.startsWith(AGGREGATE3) && a.result) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3") return a;
        const inner = decoded.args[0];
        const out = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: a.result });
        const patched = out.map((r, i) => {
          const sub = inner[i]!;
          if (!selectors.some((s) => sub.callData.startsWith(s))) return r;
          const next = apply({ to: sub.target, data: sub.callData }, r.success ? r.returnData : null);
          if (next === null) return r;
          return typeof next === "string"
            ? { success: true, returnData: next }
            : { success: false, returnData: next.revert };
        });
        return {
          ...a,
          result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: patched }),
        };
      }
      if (!selectors.some((s) => data.startsWith(s))) return a;
      const next = apply({ to: p0?.to ?? "", data }, a.result ?? null);
      if (next === null) return a;
      if (typeof next === "string") {
        const { error: _drop, ...rest } = a;
        void _drop;
        return { ...rest, result: next };
      }
      const { result: _drop, ...rest } = a;
      void _drop;
      return { ...rest, error: { code: 3, message: "execution reverted", data: next.revert } };
    });
    await route.fulfill({ response: res, json: Array.isArray(json) ? answers : answers[0] });
  });
}

/* ------------------------------------------------------------------ patches */

/** `StockOracle.isMarketOpen()` answers false. */
export const marketClosed: CallPatch = (c) =>
  c.data.startsWith(IS_OPEN) ? encodeAbiParameters([{ type: "bool" }], [false]) : undefined;

/** `status(token)`: the feed reports `status` (0 Ok, 2 StalePrice) with its last round at `updatedAt`, same price. */
export const feedStatus =
  (status: number, updatedAt: number): CallPatch =>
  (c, r) =>
    c.data.startsWith(STATUS) && r && r.length >= 2 + 64 * 3
      ? setWords(r, { 0: BigInt(status), 2: BigInt(updatedAt) })
      : undefined;

/**
 * `spot(token)` answers `price` where the chain's own call reverts. A fixture that reports the feed as fresh
 * (`feedStatus(0, ...)`) must also give a spot, or the risk panel finds the feed "Ok" and the spot reverting, which
 * happens on every weekend once the Friday print is older than `maxPriceAge` (25 hours).
 */
export const spotWhenReverted =
  (price: bigint): CallPatch =>
  (c, r) =>
    c.data.startsWith(SPOT) && r === null ? encodeAbiParameters([{ type: "uint256" }], [price]) : undefined;

/** The oracle's last print for `token` (`status(token)`'s price, 18 decimals), read straight from the chain. */
export async function lastPrint(rpcUrl: string, oracle: string, token: string): Promise<bigint> {
  const data = `${STATUS}${token.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: oracle, data }, "latest"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const { result } = (await res.json()) as { result: Hex };
  return BigInt(`0x${result.slice(2 + 64, 2 + 128)}`);
}

/** `quoteBuy` reverts with StalePrice, as SafeStockFeed makes it once the last print is past the limit. */
export const quoteReverts: CallPatch = (c) =>
  c.data.startsWith(QUOTE_BUY) ? { revert: `${STALE_PRICE}${"0".repeat(128)}` as Hex } : undefined;

/** `quoteBuy(id, amount)` answers `perOption` USDG base units per whole option (18-decimal tokens), collateral = amount. */
export const quoteAt =
  (perOption: bigint): CallPatch =>
  (c) => {
    if (!c.data.startsWith(QUOTE_BUY)) return undefined;
    const amount = uintArg(c.data, 1);
    const premium = (amount * perOption + 10n ** 18n - 1n) / 10n ** 18n || 1n;
    return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [premium, amount]);
  };

/** Every series reads as nothing sold yet. */
export const unsold: CallPatch = (c, r) =>
  c.data.startsWith(GET_SERIES) && r && r.length === 2 + 64 * SERIES_WORDS
    ? setWords(r, { [SERIES.sold]: 0n })
    : undefined;

export interface PhaseFixture {
  vault: Address;
  /** The series the vault sells or sold (its id never changes, so a past week's series works after it settles). */
  seriesId: bigint;
  phase: LivePhase;
  /** For "selling": the expiry to show (default: three days from now). */
  expiry?: number;
}

/**
 * Put one vault in `phase`: its `epochs(vault)` state and series id, and that series' expiry and settlement fields.
 * "expired" keeps the series' real (past) expiry and clears any recorded settlement; "selling" moves the expiry ahead.
 */
export function vaultPhase(f: PhaseFixture): CallPatch {
  const vault = f.vault.toLowerCase();
  const expiry = BigInt(f.expiry ?? Math.floor(Date.now() / 1000) + 3 * 86_400);
  return (c, r) => {
    if (!r) return undefined;
    if (c.data.startsWith(EPOCHS) && addressArg(c.data) === vault) {
      const state = f.phase === "settled" ? 0n : f.phase === "open" ? 1n : 2n;
      const seriesId = f.phase === "selling" || f.phase === "expired" ? f.seriesId : 0n;
      return setWords(r, { [EPOCH.state]: state, [EPOCH.seriesId]: seriesId });
    }
    if (
      c.data.startsWith(GET_SERIES) &&
      uintArg(c.data, 0) === f.seriesId &&
      r.length === 2 + 64 * SERIES_WORDS
    ) {
      if (f.phase === "selling")
        return setWords(r, {
          [SERIES.expiry]: expiry,
          [SERIES.settled]: 0n,
          [SERIES.settlementPrice]: 0n,
          [SERIES.payoutPerOption]: 0n,
          [SERIES.escrow]: 0n,
        });
      if (f.phase === "expired")
        return setWords(r, {
          [SERIES.settled]: 0n,
          [SERIES.settlementPrice]: 0n,
          [SERIES.payoutPerOption]: 0n,
          [SERIES.escrow]: 0n,
        });
    }
    return undefined;
  };
}

export const PHASE_SELECTORS: Hex[] = [EPOCHS, GET_SERIES, STATUS, QUOTE_BUY, IS_OPEN];

/* ------------------------------------------------------------------ the chain's own answer */

const emAbi = parseAbi([
  "function epochs(address) view returns (uint8 state, uint64 openedAt, uint256 seriesId, uint128 openSpot, uint64 openSigma)",
  "function getSeries(uint256) view returns ((address vault, address underlying, uint256 agentId, uint64 expiry, uint16 premiumBps, bool isCall, bool settled, bool cancelled, uint256 strike, uint256 size, uint256 sold, uint256 premium, uint256 collateral, uint256 settlementPrice, uint256 payoutPerOption, uint256 escrow))",
]);

/**
 * Which phase a vault is in now, read from the chain the way the page reads it: Open is "open"; Selling before
 * expiry "selling", after it "expired"; Idle is "settled" (between epochs, after a settlement or an abort).
 */
export async function livePhase(rpc: string, epochManager: Address, vault: Address): Promise<LivePhase> {
  const client = createPublicClient({ transport: http(rpc) });
  const [state, , seriesId] = await client.readContract({
    address: epochManager,
    abi: emAbi,
    functionName: "epochs",
    args: [vault],
  });
  if (state === 1) return "open";
  if (state !== 2 || seriesId === 0n) return "settled";
  const [series, block] = await Promise.all([
    client.readContract({ address: epochManager, abi: emAbi, functionName: "getSeries", args: [seriesId] }),
    client.getBlock(),
  ]);
  return Number(series.expiry) <= Number(block.timestamp) ? "expired" : "selling";
}
