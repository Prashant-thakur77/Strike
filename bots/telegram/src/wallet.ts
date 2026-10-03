import {
  type Claimables,
  type SeriesState,
  type StrikeClient,
  type VaultState,
  epochManagerAbi,
  explainError,
  optionTokenAbi,
} from "@strike/sdk";
import { type Address, type PublicClient, getAddress } from "viem";
import type { Alert } from "./format.js";
import { amount, shortAddress, usd, utc } from "./format.js";
import { isRangeLimitError } from "./logs.js";

// Per-wallet items for /watch and /status <address>: what a wallet holds on each deployment and what it needs to do,
// derived from chain state (claimables, option balances, series state) rather than from events, so an item is never
// stale: it shows while the chain says it is true and goes away once it is not. The one event-based item is a slash
// paid into a vault the wallet is in, taken from the alert loop (which keeps a persisted cursor per deployment).

/** The chain reads the wallet view needs (a subset of `StrikeClient`, so tests can fake it). */
export type WalletReader = Pick<
  StrikeClient,
  "listVaults" | "claimables" | "optionBalance" | "getSeries" | "blockTimestamp"
>;

/** One deployment's wallet reads: the client and the option series an address has received. */
export interface WalletSource {
  reader: WalletReader;
  /** Ids of every option series the address has bought or received on this deployment. */
  heldSeries(address: Address): Promise<bigint[]>;
}

export type ActionKind =
  | "premium"
  | "deposit-processed"
  | "withdrawal-ready"
  | "option-in-the-money"
  | "option-refund"
  | "awaiting-price"
  | "slash";

/** Something a wallet should act on (or wait for). `key` is stable while the item stands, for dedupe. */
export interface ActionItem {
  key: string;
  kind: ActionKind;
  text: string;
}

/** What a wallet holds on one deployment, and what it needs to do there. */
export interface WalletView {
  label: string;
  positions: string[];
  items: ActionItem[];
}

const sym = (v: VaultState) => v.symbol;

/** Items and positions from one vault's claimables (as of chain time `now`). */
export function vaultItems(
  label: string,
  key: string,
  v: VaultState,
  c: Claimables,
  now: bigint,
  usdgDecimals: number,
): { positions: string[]; items: ActionItem[] } {
  const positions: string[] = [];
  const items: ActionItem[] = [];
  const at = `${sym(v)} (${label})`;
  const base = `${key}:${v.address.toLowerCase()}`;
  if (c.shares > 0n) {
    const assets = (c.shares * v.pricePerShare) / 10n ** BigInt(v.decimals);
    positions.push(
      `${at}: ${amount(c.shares, v.decimals)} shares, about ${amount(assets, v.assetDecimals)} ${v.assetSymbol}`,
    );
  }
  if (c.depositRequest.amount > 0n && c.depositShares === 0n) {
    positions.push(
      `${at}: deposit of ${amount(c.depositRequest.amount, v.assetDecimals)} ${v.assetSymbol} queued for epoch ${c.depositRequest.epoch}`,
    );
  }
  if (c.redeemRequest.amount > 0n && c.redeemAssets === 0n) {
    positions.push(
      `${at}: withdrawal of ${amount(c.redeemRequest.amount, v.decimals)} shares queued for epoch ${c.redeemRequest.epoch}`,
    );
  }
  if (c.premium > 0n) {
    items.push({
      key: `${base}:premium:${v.lastProcessedEpoch}`,
      kind: "premium",
      text: `Premium ready to claim: ${amount(c.premium, usdgDecimals, 6)} USDG from ${at} (claimPremium).`,
    });
  }
  if (c.depositShares > 0n) {
    items.push({
      key: `${base}:deposit:${c.depositRequest.epoch}`,
      kind: "deposit-processed",
      text: `Queued deposit processed: claim ${amount(c.depositShares, v.decimals)} ${sym(v)} shares in ${at} (claimDeposit).`,
    });
  }
  if (c.redeemAssets > 0n) {
    items.push({
      key: `${base}:redeem:${c.redeemRequest.epoch}`,
      kind: "withdrawal-ready",
      text: `Withdrawal ready: claim ${amount(c.redeemAssets, v.assetDecimals)} ${v.assetSymbol} from ${at} (claimRedeem).`,
    });
  }
  const s = v.series;
  const invested = c.shares > 0n || c.depositShares > 0n;
  if (invested && s && v.epoch.state === "Selling" && !s.settled && !s.cancelled && now >= s.expiry) {
    items.push({
      key: `${base}:awaiting:${s.id}`,
      kind: "awaiting-price",
      text: `${at}: the ${s.isCall ? "call" : "put"} series at ${usd(s.strike)} expired ${utc(s.expiry)} and is waiting for its settlement price (the first mainnet Chainlink price at or after expiry). Nothing to do yet.`,
    });
  }
  return { positions, items };
}

/** Items and positions from one option series the wallet holds `balance` of. */
export function optionItems(
  label: string,
  key: string,
  s: SeriesState,
  v: Pick<VaultState, "symbol" | "underlyingSymbol" | "underlyingDecimals">,
  balance: bigint,
  now: bigint,
): { positions: string[]; items: ActionItem[] } {
  if (balance === 0n) return { positions: [], items: [] };
  const kind = s.isCall ? "call" : "put";
  const n = amount(balance, v.underlyingDecimals, 6);
  const what = `${n} ${v.underlyingSymbol} ${kind}${n === "1" ? "" : "s"} at ${usd(s.strike)} (${v.symbol}, ${label})`;
  const base = `${key}:series:${s.id}`;
  const positions = [`${what}, expiry ${utc(s.expiry)}`];
  const items: ActionItem[] = [];
  if (s.cancelled) {
    items.push({
      key: `${base}:refund`,
      kind: "option-refund",
      text: `Series cancelled: redeem your ${what} for the premium refund (redeem).`,
    });
  } else if (s.settled && s.payoutPerOption > 0n) {
    items.push({
      key: `${base}:itm`,
      kind: "option-in-the-money",
      text: `In the money at settlement (${usd(s.settlementPrice)}): redeem your ${what} for the payout (redeem).`,
    });
  } else if (!s.settled && now >= s.expiry) {
    items.push({
      key: `${base}:awaiting`,
      kind: "awaiting-price",
      text: `Your ${what} expired ${utc(s.expiry)} and the series is waiting for its settlement price. Nothing to do yet.`,
    });
  }
  return { positions, items };
}

/** A wallet's positions and items on one deployment. Throws when the chain cannot be read. */
export async function walletView(
  t: { key: string; label: string; usdgDecimals: number; wallet: WalletSource },
  address: Address,
): Promise<WalletView> {
  const r = t.wallet.reader;
  const [vaults, now, held] = await Promise.all([
    r.listVaults(),
    r.blockTimestamp(),
    t.wallet.heldSeries(address),
  ]);
  const out: WalletView = { label: t.label, positions: [], items: [] };
  const claims = await Promise.all(vaults.map((v) => r.claimables(v.address, address)));
  vaults.forEach((v, i) => {
    const x = vaultItems(t.label, t.key, v, claims[i]!, now, t.usdgDecimals);
    out.positions.push(...x.positions);
    out.items.push(...x.items);
  });
  const byAddress = new Map(vaults.map((v) => [v.address.toLowerCase(), v]));
  for (const id of held) {
    const [balance, s] = await Promise.all([r.optionBalance(id, address), r.getSeries(id)]);
    if (!s || balance === 0n) continue;
    const v = byAddress.get(s.vault.toLowerCase());
    if (!v) continue;
    const x = optionItems(t.label, t.key, s, v, balance, now);
    out.positions.push(...x.positions);
    out.items.push(...x.items);
  }
  return out;
}

/** Every deployment's view of one wallet; a deployment that cannot be read gives an `error` line instead. */
export async function walletViews(
  targets: readonly { key: string; label: string; usdgDecimals: number; wallet?: WalletSource }[],
  address: Address,
): Promise<{ views: WalletView[]; errors: string[] }> {
  const usable = targets.filter((t): t is (typeof targets)[number] & { wallet: WalletSource } => !!t.wallet);
  const results = await Promise.allSettled(usable.map((t) => walletView(t, address)));
  const views: WalletView[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") views.push(r.value);
    else errors.push(`${usable[i]!.label}: could not read (${explainError(r.reason)})`);
  });
  return { views, errors };
}

/** The /status <address> reply. */
export function walletStatusText(
  address: Address,
  views: WalletView[],
  errors: string[],
  appUrl?: string,
): string {
  const positions = views.flatMap((v) => v.positions);
  const items = views.flatMap((v) => v.items);
  const lines = [`Wallet ${address}`, ""];
  lines.push(positions.length ? "Positions:" : "No Strike positions on the deployments read.");
  for (const p of positions) lines.push(`• ${p}`);
  const act = items.filter((i) => i.kind !== "awaiting-price");
  const waiting = items.filter((i) => i.kind === "awaiting-price");
  lines.push("");
  lines.push(act.length ? "Needs your action:" : "Nothing needs your action.");
  for (const it of act) lines.push(`• ${it.text}`);
  if (waiting.length) {
    lines.push("", "Waiting for a settlement price:");
    for (const it of waiting) lines.push(`• ${it.text}`);
  }
  if (errors.length) lines.push("", ...errors);
  if (appUrl && act.length) lines.push("", `Act in the app: ${appUrl}/app/portfolio`);
  return lines.join("\n");
}

/** The alert a watching chat gets for new items of one wallet. */
export function watchAlertText(address: Address, items: ActionItem[], appUrl?: string): string {
  const lines = [`Wallet ${shortAddress(address)}:`];
  for (const it of items) lines.push(`• ${it.text}`);
  if (appUrl && items.some((i) => i.kind !== "awaiting-price" && i.kind !== "slash")) {
    lines.push(`Act in the app: ${appUrl}/app/portfolio`);
  }
  return lines.join("\n");
}

/**
 * Which items each chat has been told about, per watched wallet, in memory only (the state file keeps nothing but
 * which chat watches which address). An item that disappears is forgotten, so it alerts again if it comes back. After
 * a restart each open item is sent once more.
 */
export class WatchTracker {
  private seen = new Map<string, Set<string>>();

  private slot(chatId: number, address: string): Set<string> {
    const k = `${chatId}:${address.toLowerCase()}`;
    let s = this.seen.get(k);
    if (!s) {
      s = new Set();
      this.seen.set(k, s);
    }
    return s;
  }

  /** The items the chat has not been told about yet; marks them told. `complete` prunes items no longer there. */
  fresh(chatId: number, address: string, items: ActionItem[], complete = true): ActionItem[] {
    const s = this.slot(chatId, address);
    const out = items.filter((i) => !s.has(i.key));
    for (const i of out) s.add(i.key);
    if (complete) {
      const now = new Set(items.map((i) => i.key));
      for (const k of [...s]) if (!now.has(k)) s.delete(k);
    }
    return out;
  }

  /** Forget a chat's wallet (after /unwatch). */
  forget(chatId: number, address: string): void {
    this.seen.delete(`${chatId}:${address.toLowerCase()}`);
  }
}

/**
 * The option series an address has bought (OptionsBought `recipient`) or been sent (OptionToken TransferSingle `to`)
 * on one deployment, from its deploy block, scanned once and then from where the last scan stopped. In memory.
 */
export function optionSeriesScanner(
  publicClient: Pick<PublicClient, "getLogs" | "getBlockNumber">,
  epochManager: Address,
  optionToken: Address,
  startBlock: bigint,
  maxRange: bigint,
): (address: Address) => Promise<bigint[]> {
  const state = new Map<string, { next: bigint; ids: Set<bigint>; running?: Promise<bigint[]> }>();
  const bought = epochManagerAbi.find((x) => x.type === "event" && x.name === "OptionsBought")!;
  const sent = optionTokenAbi.find((x) => x.type === "event" && x.name === "TransferSingle")!;
  return (address) => {
    const k = getAddress(address).toLowerCase();
    let s = state.get(k);
    if (!s) {
      s = { next: startBlock, ids: new Set() };
      state.set(k, s);
    }
    const st = s;
    if (st.running) return st.running;
    st.running = (async () => {
      try {
        const head = await publicClient.getBlockNumber({ cacheTime: 0 });
        let size = maxRange > 0n ? maxRange : 1n;
        while (st.next <= head) {
          const end = st.next + size - 1n < head ? st.next + size - 1n : head;
          try {
            const [a, b] = await Promise.all([
              publicClient.getLogs({
                address: epochManager,
                event: bought as never,
                args: { recipient: address } as never,
                fromBlock: st.next,
                toBlock: end,
              }),
              publicClient.getLogs({
                address: optionToken,
                event: sent as never,
                args: { to: address } as never,
                fromBlock: st.next,
                toBlock: end,
              }),
            ]);
            for (const l of a as unknown as { args: { seriesId: bigint } }[]) st.ids.add(l.args.seriesId);
            for (const l of b as unknown as { args: { id: bigint } }[]) st.ids.add(l.args.id);
            st.next = end + 1n;
          } catch (err) {
            if (isRangeLimitError(err) && size > 1n) size /= 2n;
            else throw err;
          }
        }
        return [...st.ids];
      } finally {
        st.running = undefined;
      }
    })();
    return st.running;
  };
}

/**
 * A slash paid into a vault: one item for each watched wallet that is in the vault (shares, or a deposit queued or
 * processed there). From the alert loop's ProposalRejected, so it is sent once per log.
 */
export async function slashItems(
  alert: Alert,
  reader: Pick<WalletReader, "claimables">,
  addresses: readonly Address[],
  label: string,
  key: string,
  usdgDecimals: number,
): Promise<Map<Address, ActionItem>> {
  const out = new Map<Address, ActionItem>();
  if (alert.name !== "ProposalRejected" || alert.slashed === 0n) return out;
  const v = alert.vault;
  await Promise.all(
    addresses.map(async (a) => {
      try {
        const c = await reader.claimables(v.address, a);
        if (c.shares === 0n && c.depositShares === 0n && c.depositRequest.amount === 0n) return;
        out.set(a, {
          key: `${key}:slash:${alert.txHash}:${alert.logIndex}`,
          kind: "slash",
          text: `Agent ${alert.agentId} proposed outside ${v.symbol}'s mandate (${label}): ${amount(alert.slashed, usdgDecimals, 6)} USDG of its bond was slashed to the vault, paid to its depositors (you included) at epoch close.`,
        });
      } catch {
        // a wallet we cannot read gets no slash notice; its /status still works
      }
    }),
  );
  return out;
}
