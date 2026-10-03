// The portfolio dashboard's arithmetic: one wallet's vault positions, its value over time, epoch-by-epoch results,
// options and activity, rebuilt from the chain's event logs and checked against today's reads.
//
// Why events and not historical reads: the public RPCs of both testnets keep no historical state ("historical state
// … is not available" for a call at any older block, checked 2026-10-03), so the share price at a past block cannot
// be read. It does not need to be: a vault's share price (totalAssets / totalSupply) only changes at settlement
// (deposits and withdrawals go in and out at the current price), and every settlement emits the vault's
// EpochSettled(epoch, payout, premium, assets, supply, accPremium), the same numbers the contract keeps as its epoch
// snapshot. Replaying the wallet's own events (shares in and out, queued requests, claims) against those snapshots
// gives its holding, its premium and its cash flows at every point in time, with the contract's own formulas.
//
// Pure, with no runtime imports, so Playwright's CommonJS loader can test it on fixtures (e2e/portfolio.spec.ts). The
// server (portfolioRead.ts) reads the logs and today's state and passes them in.

/* ================================================================ inputs */

export type LogSource = "vault" | "epochManager" | "agentRegistry" | "feeManager" | "feed";

/** A decoded log. Integers are decimal strings and addresses lower case (the indexer's JSON encoding too). */
export interface PLog {
  chainId: number;
  /** Deployment key, "46630-v3". */
  deployment: string;
  /** The emitting contract, lower case. */
  address: string;
  source: LogSource;
  event: string;
  args: Record<string, unknown>;
  block: number;
  logIndex: number;
  tx: string;
  /** Block timestamp, unix seconds (null when it could not be read). */
  time: number | null;
}

/** A price in USD per whole underlying token at time `t` (a feed round). */
export interface PricePoint {
  t: number;
  price: number;
}

export interface SeriesLive {
  id: string;
  strike: number;
  expiry: number;
  /** Options, in whole underlying tokens. */
  size: number;
  sold: number;
  /** USDG escrowed from buyers. */
  premium: number;
  /** Vault collateral locked for the sold options, in the vault's asset. */
  collateral: number;
  settled: boolean;
  cancelled: boolean;
}

/** Today's reads of one vault for the wallet (raw base units for anything the replay is checked against). */
export interface VaultLive {
  totalAssets: bigint;
  totalSupply: bigint;
  balance: bigint;
  pendingPremium: bigint;
  depositRequest: { epoch: number; amount: bigint };
  redeemRequest: { epoch: number; amount: bigint };
  claimableDepositShares: bigint;
  claimableRedeemAssets: bigint;
  currentEpoch: number;
  lastProcessedEpoch: number;
  locked: boolean;
  /** EpochManager epoch state: 0 idle, 1 open (waiting for a proposal), 2 selling. */
  state: number;
  series: SeriesLive | null;
}

export interface VaultInput {
  chainId: number;
  deployment: string;
  version: string;
  /** Lower case. */
  vault: string;
  symbol: string;
  isCall: boolean;
  /** Underlying symbol ("TSLA"). */
  underlying: string;
  assetSymbol: string;
  assetDecimals: number;
  shareDecimals: number;
  usdgDecimals: number;
  /** Oracle spot now, USD per whole underlying token (0 when unreadable). */
  spot: number;
  /** The underlying's feed rounds, USD per whole token, oldest first. */
  prices: PricePoint[];
  /** On-chain annualised volatility the EpochManager prices with (null when unreadable). */
  sigma: number | null;
  live: VaultLive;
}

/** One row of the indexer's GET /events (services/indexer). */
export interface IndexerEvent {
  chainId: number;
  deployment: string;
  blockNumber: number;
  blockTime: string;
  txHash: string;
  logIndex: number;
  address: string;
  source: string;
  event: string | null;
  args: Record<string, unknown> | null;
}

const INDEXER_SOURCE: Record<string, LogSource> = {
  vault: "vault",
  epochManager: "epochManager",
  agentRegistry: "agentRegistry",
  mirrorFeed: "feed",
};

/** One indexer event row as a PLog (null for contracts the portfolio does not use or undecoded logs). */
export function fromIndexer(e: IndexerEvent, chainId: number, deployment: string): PLog | null {
  const source = INDEXER_SOURCE[e.source];
  if (!source || !e.event || !e.args) return null;
  const ms = Date.parse(e.blockTime);
  return {
    chainId,
    deployment,
    address: e.address.toLowerCase(),
    source,
    event: e.event,
    args: e.args,
    block: e.blockNumber,
    logIndex: e.logIndex,
    tx: e.txHash,
    time: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
  };
}

/* ================================================================ outputs */

export interface Exposure {
  seriesId: string;
  strike: number;
  expiry: number;
  phase: "selling" | "expired";
  /** The wallet's shares (held and queued to leave) over the vault's supply. */
  shareOfVault: number;
  /** The wallet's part of the options the vault sold, in whole tokens. */
  optionsSold: number;
  /** The wallet's part of the collateral locked for sold options, in the vault's asset. */
  collateralAtRisk: number;
  /** That collateral in USD at the strike: the most the epoch can pay out of it, before premium. */
  collateralAtRiskUsd: number;
  /** The wallet's part of the premium buyers paid so far (USDG, before the performance fee). */
  premiumShare: number;
  /** Settlement price past which the payout is larger than the premium. */
  breakEven: number | null;
  spot: number;
  /** Model: the pricing model's odds the option ends in the money, N(±d2) from today's spot and the on-chain σ. */
  modelProbItm: number | null;
  /** Model: the odds it ends past break-even (the epoch loses money for depositors). */
  modelProbLoss: number | null;
}

export type EpochStatus =
  "settled" | "settled-unsold" | "aborted" | "cancelled" | "running" | "open" | "expired-settling";

export interface EpochResult {
  chainId: number;
  deployment: string;
  version: string;
  vault: string;
  symbol: string;
  underlying: string;
  isCall: boolean;
  assetSymbol: string;
  epoch: number;
  status: EpochStatus;
  openedAt: number | null;
  closedAt: number | null;
  seriesId: string | null;
  strike: number | null;
  expiry: number | null;
  settlementPrice: number | null;
  /** The wallet's shares over the vault's supply when the epoch closed (or now, for a running one). */
  shareOfVault: number;
  /** USDG premium credited to the wallet (null while the epoch runs). */
  premium: number | null;
  /** The wallet's part of the settlement payout, in the vault's asset and in USD at the settlement price. */
  payoutAssets: number | null;
  payoutUsd: number | null;
  /** premium − payoutUsd. */
  net: number | null;
  /** Oracle spot when the epoch opened (EpochOpened), USD per token. */
  spotAtOpen: number | null;
  /**
   * Calls only: what the wallet's tokens in the vault gained or lost from the stock's move over the epoch (open spot
   * to settlement price), the "just holding" result to compare the strategy's with (strategy = hold + net).
   */
  holdUsd: number | null;
  txOpened: string | null;
  txProposed: string | null;
  txClosed: string | null;
}

export interface VaultPosition {
  chainId: number;
  deployment: string;
  version: string;
  vault: string;
  symbol: string;
  isCall: boolean;
  underlying: string;
  assetSymbol: string;
  /** Shares in the wallet, queued to leave, or processed and waiting to be claimed. */
  shares: number;
  /** What those shares and any pending assets are worth, in the asset and in USD at the oracle spot. */
  valueAssets: number;
  valueUsd: number;
  /** USD per asset unit now (the oracle spot for calls, 1 for USDG). */
  assetUsd: number;
  /** pendingPremium, plus premium on processed requests the contract credits when they are claimed. */
  pendingPremium: number;
  /** What claimPremium pays now (the vault's pendingPremium). */
  premiumClaimable: number;
  premiumClaimed: number;
  premiumEarned: number;
  depositedAssets: number;
  withdrawnAssets: number;
  depositedUsd: number;
  withdrawnUsd: number;
  /** Cost of what is still held (average cost, USD at the oracle price of each deposit). */
  costBasisUsd: number;
  /** valueUsd + pendingPremium + withdrawnUsd + premiumClaimed − depositedUsd. */
  pnlUsd: number;
  /** valueAssets + withdrawnAssets − depositedAssets: the strategy in the asset, premium aside. */
  pnlAssets: number;
  realisedUsd: number;
  unrealisedUsd: number;
  queuedDeposit: number;
  queuedRedeemShares: number;
  claimableDepositShares: number;
  claimableRedeemAssets: number;
  exposure: Exposure | null;
  /**
   * Rebuilt from events next to today's reads; `ok` when they agree to the last base unit or two. `premiumLive` is
   * pendingPremium plus the premium of processed requests not yet claimed (credited by the contract at the claim).
   */
  check: {
    sharesRebuilt: number;
    sharesLive: number;
    premiumRebuilt: number;
    premiumLive: number;
    ok: boolean;
  };
  /** Settled and running epochs the wallet was in, oldest first. */
  epochs: EpochResult[];
  /** True when the wallet has something here now or ever had. */
  touched: boolean;
  firstAt: number | null;
}

export interface Step {
  t: number;
  /** Holding in the vault's asset (shares at the share price, plus queued or claimable assets). */
  assets: number;
  /** Premium credited and not yet claimed, USDG. */
  premiumPending: number;
  /** Cumulative deposits − withdrawals − premium claimed, USD at each flow's price. */
  invested: number;
}

export interface ChartPoint {
  t: number;
  value: number;
  invested: number;
}

export interface ChartMarker {
  t: number;
  kind: "deposit" | "withdraw" | "open" | "settle" | "claim";
  label: string;
}

export interface Totals {
  valueUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  premiumEarned: number;
  premiumClaimed: number;
  premiumPending: number;
  pnlUsd: number;
  /** pnlUsd / depositedUsd (null with nothing deposited). */
  pnlPct: number | null;
  realisedUsd: number;
  unrealisedUsd: number;
  vaults: number;
}

/* ================================================================ helpers */

const ACC = 10n ** 36n;
const YEAR = 31_536_000;

/** A base-unit amount as a number of whole units (exact to ~15 significant digits). */
export function units(x: bigint, decimals: number): number {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const d = 10n ** BigInt(decimals);
  const n = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -n : n;
}

const B = (x: unknown): bigint => {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(Math.trunc(x));
  if (typeof x === "string" && x !== "") return BigInt(x);
  return 0n;
};
const A = (x: unknown): string => (typeof x === "string" ? x.toLowerCase() : "");
const ZERO = "0x0000000000000000000000000000000000000000";

export function byChainOrder(
  a: Pick<PLog, "block" | "logIndex">,
  b: Pick<PLog, "block" | "logIndex">,
): number {
  return a.block - b.block || a.logIndex - b.logIndex;
}

/** The feed's price at `t`: the last round at or before it, else the first round after it, else null. */
export function priceAt(points: PricePoint[], t: number): number | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (points[0]!.t > t) return points[0]!.price;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo]!.price;
}

/** A standard normal CDF (Abramowitz–Stegun 7.1.26 through erf), for the model odds. */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** The model's odds the stock ends beyond `level` against the seller (above for a call, below for a put). */
export function modelOddsBeyond(
  isCall: boolean,
  spot: number,
  level: number,
  sigma: number,
  tenorSeconds: number,
): number | null {
  if (!(spot > 0) || !(level > 0) || !(sigma > 0) || !(tenorSeconds > 0)) return null;
  const vol = sigma * Math.sqrt(tenorSeconds / YEAR);
  const d2 = (Math.log(spot / level) - (vol * vol) / 2) / vol;
  return isCall ? normCdf(d2) : normCdf(-d2);
}

/* ================================================================ one vault */

interface Snapshot {
  assets: bigint;
  supply: bigint;
  acc: bigint;
  perShare: bigint;
}

interface EpochEvents {
  opened?: { t: number | null; tx: string; spot: number };
  proposed?: { seriesId: string; strike: number; expiry: number; tx: string };
  settled?: { price: number; tx: string };
  aborted?: { tx: string };
  cancelled?: { tx: string };
}

export interface VaultReplay {
  position: VaultPosition;
  steps: Step[];
  markers: ChartMarker[];
  activity: ActivityRow[];
  /** USD per asset unit at a time (the feed's round then for calls, 1 for USDG). */
  priceAt: (t: number) => number;
}

/**
 * Replay one vault's logs for `account`. `logs` holds the vault's own logs and its EpochManager's (any order; they
 * are sorted here). `now` is the chain's latest block time.
 */
export function replayVault(input: VaultInput, logs: PLog[], account: string, now: number): VaultReplay {
  const acct = account.toLowerCase();
  const vault = input.vault.toLowerCase();
  const live = input.live;
  const dA = input.assetDecimals;
  const dS = input.shareDecimals;
  const dU = input.usdgDecimals;
  const px = (t: number | null): number =>
    input.isCall ? (priceAt(input.prices, t ?? now) ?? input.spot) : 1;

  const mine = logs
    .filter(
      (l) =>
        (l.source === "vault" && l.address === vault) ||
        (l.source === "epochManager" && A(l.args.vault) === vault),
    )
    .sort(byChainOrder);

  const em = new Map<number, EpochEvents>();
  const at = (e: number) => {
    let x = em.get(e);
    if (!x) em.set(e, (x = {}));
    return x;
  };
  for (const l of mine) {
    if (l.source !== "epochManager") continue;
    const e = Number(B(l.args.epoch));
    if (l.event === "EpochOpened") at(e).opened = { t: l.time, tx: l.tx, spot: units(B(l.args.spot), 18) };
    else if (l.event === "SeriesProposed")
      at(e).proposed = {
        seriesId: String(l.args.seriesId),
        strike: units(B(l.args.strike), 18),
        expiry: Number(B(l.args.expiry)),
        tx: l.tx,
      };
    else if (l.event === "EpochSettled")
      at(e).settled = { price: units(B(l.args.settlementPrice), 18), tx: l.tx };
    else if (l.event === "EpochAborted") at(e).aborted = { tx: l.tx };
    else if (l.event === "SeriesCancelled") at(e).cancelled = { tx: l.tx };
  }

  // State, in base units.
  let bal = 0n;
  type DQ = { epoch: number; amount: bigint; costUsd: number };
  type RQ = { epoch: number; shares: bigint };
  let dq = null as DQ | null;
  let rq = null as RQ | null;
  let lastProcessed = 0;
  const snaps = new Map<number, Snapshot>();
  let prevAcc = 0n;
  let ratio = { assets: 0n, supply: 0n };
  let accrued = 0n;
  let claimed = 0n;
  let depositedAssets = 0n;
  let withdrawnAssets = 0n;
  let depositedUsd = 0;
  let withdrawnUsd = 0;
  let claimedUsd = 0;
  let cost = 0;
  let realisedFlows = 0;
  let touched = false;
  let firstAt: number | null = null;

  const steps: Step[] = [];
  const markers: ChartMarker[] = [];
  const activity: ActivityRow[] = [];
  const epochs: EpochResult[] = [];

  const shareValue = (shares: bigint): bigint =>
    ratio.supply === 0n && ratio.assets === 0n
      ? shares
      : (shares * (ratio.assets + 1n)) / (ratio.supply + 1n);
  const dqShares = (q: { epoch: number; amount: bigint }) => {
    const s = snaps.get(q.epoch);
    return s ? (q.amount * (s.supply + 1n)) / (s.assets + 1n) : 0n;
  };
  const rqAssets = (q: { epoch: number; shares: bigint }) => {
    const s = snaps.get(q.epoch);
    return s ? (q.shares * (s.assets + 1n)) / (s.supply + 1n) : 0n;
  };
  const econShares = () =>
    bal +
    (rq && rq.epoch > lastProcessed ? rq.shares : 0n) +
    (dq && dq.epoch <= lastProcessed ? dqShares(dq) : 0n);
  const pendingAssets = () =>
    (dq && dq.epoch > lastProcessed ? dq.amount : 0n) + (rq && rq.epoch <= lastProcessed ? rqAssets(rq) : 0n);
  const holdingAssets = () => shareValue(econShares()) + pendingAssets();

  const meta = {
    chainId: input.chainId,
    deployment: input.deployment,
    version: input.version,
    vault,
    symbol: input.symbol,
  };
  const push = (t: number | null) => {
    if (t === null) return;
    steps.push({
      t,
      assets: units(holdingAssets(), dA),
      premiumPending: units(accrued - claimed, dU),
      invested: depositedUsd - withdrawnUsd - claimedUsd,
    });
  };
  const inflow = (amount: bigint, t: number | null) => {
    const usd = units(amount, dA) * px(t);
    depositedAssets += amount;
    depositedUsd += usd;
    cost += usd;
    return usd;
  };
  const outflow = (amount: bigint, t: number | null) => {
    const after = units(holdingAssets(), dA);
    const a = units(amount, dA);
    const usd = a * px(t);
    const frac = after + a > 0 ? a / (after + a) : 1;
    const costOut = cost * frac;
    realisedFlows += usd - costOut;
    cost -= costOut;
    withdrawnAssets += amount;
    withdrawnUsd += usd;
    return usd;
  };
  const note = (
    l: PLog,
    kind: ActivityKind,
    text: string,
    marker?: ChartMarker["kind"],
    money?: { asset: string; amount: number; usd: number },
  ) => {
    touched = true;
    if (firstAt === null && l.time !== null) firstAt = l.time;
    activity.push({
      ...meta,
      t: l.time,
      block: l.block,
      logIndex: l.logIndex,
      kind,
      text,
      tx: l.tx,
      ...money,
    });
    if (marker && l.time !== null)
      markers.push({ t: l.time, kind: marker, label: `${input.symbol}: ${text}` });
  };
  const fmt = (x: bigint, d: number, sym: string) => `${fmtNum(units(x, d))} ${sym}`;

  for (const l of mine) {
    if (l.source === "epochManager") {
      if (l.event === "EpochOpened" && econShares() > 0n && l.time !== null) {
        markers.push({
          t: l.time,
          kind: "open",
          label: `${input.symbol}: epoch ${String(l.args.epoch)} opened`,
        });
        push(l.time);
      }
      continue;
    }
    const a = l.args;
    switch (l.event) {
      case "EpochSettled": {
        const e = Number(B(a.epoch));
        const assets = B(a.assets);
        const supply = B(a.supply);
        const acc = B(a.accPremium);
        const perShare = acc - prevAcc;
        prevAcc = acc;
        const held = econShares();
        if (held > 0n) {
          const mine = (held * perShare) / ACC;
          accrued += mine;
          const ev = em.get(e) ?? {};
          const payout = supply > 0n ? (B(a.payout) * held) / supply : 0n;
          const payoutAssets = units(payout, dA);
          const settlePx = ev.settled?.price ?? null;
          const payoutUsd = input.isCall ? payoutAssets * (settlePx ?? px(l.time)) : payoutAssets;
          const premium = units(mine, dU);
          // The wallet's tokens in the vault through the epoch: its shares at the closing share price plus the payout.
          const heldTokens = units((held * (assets + 1n)) / (supply + 1n), dA) + payoutAssets;
          const openSpot = ev.opened?.spot ?? null;
          epochs.push({
            ...meta,
            underlying: input.underlying,
            isCall: input.isCall,
            assetSymbol: input.assetSymbol,
            epoch: e,
            status: ev.aborted
              ? "aborted"
              : ev.cancelled
                ? "cancelled"
                : ev.settled && settlePx
                  ? "settled"
                  : "settled-unsold",
            openedAt: ev.opened?.t ?? null,
            closedAt: l.time,
            seriesId: ev.proposed?.seriesId ?? null,
            strike: ev.proposed?.strike ?? null,
            expiry: ev.proposed?.expiry ?? null,
            settlementPrice: settlePx || null,
            shareOfVault: supply > 0n ? Number((held * 1_000_000n) / supply) / 1_000_000 : 0,
            premium,
            payoutAssets,
            payoutUsd,
            net: premium - payoutUsd,
            spotAtOpen: openSpot,
            holdUsd: input.isCall && openSpot && settlePx ? heldTokens * (settlePx - openSpot) : null,
            txOpened: ev.opened?.tx ?? null,
            txProposed: ev.proposed?.tx ?? null,
            txClosed: ev.settled?.tx ?? ev.aborted?.tx ?? ev.cancelled?.tx ?? l.tx,
          });
          if (l.time !== null)
            markers.push({ t: l.time, kind: "settle", label: `${input.symbol}: epoch ${e} closed` });
        }
        snaps.set(e, { assets, supply, acc, perShare });
        lastProcessed = e;
        ratio = { assets, supply };
        if (held > 0n || pendingAssets() > 0n) push(l.time);
        break;
      }
      case "Transfer": {
        const from = A(a.from);
        const to = A(a.to);
        const v = B(a.value);
        if (from === to) break;
        if (to === acct) {
          bal += v;
          if (from !== ZERO && from !== vault) {
            const usd = inflow(shareValue(v), l.time);
            note(
              l,
              "shares-in",
              `received ${fmt(v, dS, "shares")} from ${short(from)} (${usd$(usd)})`,
              "deposit",
              {
                asset: `${input.symbol} shares`,
                amount: units(v, dS),
                usd,
              },
            );
            push(l.time);
          }
        } else if (from === acct) {
          bal -= v;
          if (to !== ZERO && to !== vault) {
            const usd = outflow(shareValue(v), l.time);
            note(l, "shares-out", `sent ${fmt(v, dS, "shares")} to ${short(to)} (${usd$(usd)})`, "withdraw", {
              asset: `${input.symbol} shares`,
              amount: -units(v, dS),
              usd: -usd,
            });
            push(l.time);
          }
        }
        break;
      }
      case "Deposit": {
        if (A(a.owner) !== acct) break;
        const usd = inflow(B(a.assets), l.time);
        note(l, "deposit", `deposited ${fmt(B(a.assets), dA, input.assetSymbol)} (${usd$(usd)})`, "deposit", {
          asset: input.assetSymbol,
          amount: -units(B(a.assets), dA),
          usd: -usd,
        });
        push(l.time);
        break;
      }
      case "Withdraw": {
        if (A(a.owner) !== acct) break;
        const usd = outflow(B(a.assets), l.time);
        note(
          l,
          "withdraw",
          `withdrew ${fmt(B(a.assets), dA, input.assetSymbol)} (${usd$(usd)})`,
          "withdraw",
          {
            asset: input.assetSymbol,
            amount: units(B(a.assets), dA),
            usd,
          },
        );
        push(l.time);
        break;
      }
      case "DepositRequested": {
        if (A(a.account) !== acct) break;
        const amount = B(a.assets);
        const usd = inflow(amount, l.time);
        const d0 = dq as DQ | null;
        dq = {
          epoch: Number(B(a.epoch)),
          amount: (d0?.amount ?? 0n) + amount,
          costUsd: (d0?.costUsd ?? 0) + usd,
        };
        note(
          l,
          "deposit-queued",
          `queued a deposit of ${fmt(amount, dA, input.assetSymbol)} for the end of epoch ${String(a.epoch)}`,
          "deposit",
          { asset: input.assetSymbol, amount: -units(amount, dA), usd: -usd },
        );
        push(l.time);
        break;
      }
      case "DepositRequestCancelled": {
        if (A(a.account) !== acct) break;
        const amount = B(a.assets);
        const usd = dq?.costUsd ?? units(amount, dA) * px(l.time);
        depositedAssets -= amount;
        depositedUsd -= usd;
        cost -= usd;
        dq = null;
        note(
          l,
          "deposit-cancelled",
          `cancelled a queued deposit of ${fmt(amount, dA, input.assetSymbol)}`,
          undefined,
          {
            asset: input.assetSymbol,
            amount: units(amount, dA),
            usd,
          },
        );
        push(l.time);
        break;
      }
      case "DepositClaimed": {
        if (A(a.account) !== acct) break;
        dq = null;
        note(
          l,
          "deposit-claimed",
          `claimed ${fmt(B(a.shares), dS, "shares")} from the epoch ${String(a.epoch)} deposit`,
        );
        break;
      }
      case "RedeemRequested": {
        if (A(a.account) !== acct) break;
        const r0 = rq as RQ | null;
        rq = { epoch: Number(B(a.epoch)), shares: (r0?.shares ?? 0n) + B(a.shares) };
        note(
          l,
          "redeem-queued",
          `queued ${fmt(B(a.shares), dS, "shares")} to withdraw at the end of epoch ${String(a.epoch)}`,
        );
        push(l.time);
        break;
      }
      case "RedeemClaimed": {
        if (A(a.account) !== acct) break;
        rq = null;
        const usd = outflow(B(a.assets), l.time);
        note(
          l,
          "redeem-claimed",
          `claimed ${fmt(B(a.assets), dA, input.assetSymbol)} from the epoch ${String(a.epoch)} withdrawal (${usd$(usd)})`,
          "withdraw",
          { asset: input.assetSymbol, amount: units(B(a.assets), dA), usd },
        );
        push(l.time);
        break;
      }
      case "PremiumClaimed": {
        if (A(a.account) !== acct) break;
        claimed += B(a.amount);
        claimedUsd += units(B(a.amount), dU);
        note(l, "premium-claimed", `claimed ${fmt(B(a.amount), dU, "USDG")} premium`, "claim", {
          asset: "USDG",
          amount: units(B(a.amount), dU),
          usd: units(B(a.amount), dU),
        });
        push(l.time);
        break;
      }
    }
  }

  // Today, from the reads.
  const sharesLive =
    live.balance +
    (live.redeemRequest.epoch > live.lastProcessedEpoch ? live.redeemRequest.amount : 0n) +
    live.claimableDepositShares;
  const assetUsd = input.isCall ? input.spot : 1;
  const liveShareValue =
    live.totalSupply === 0n ? sharesLive : (sharesLive * (live.totalAssets + 1n)) / (live.totalSupply + 1n);
  const queuedDeposit = live.depositRequest.epoch > live.lastProcessedEpoch ? live.depositRequest.amount : 0n;
  const valueAssets = units(liveShareValue + queuedDeposit + live.claimableRedeemAssets, dA);
  const valueUsd = valueAssets * assetUsd;
  // Premium the contract credits only when a processed request is claimed (claimDeposit, claimRedeem): pendingPremium
  // does not count it yet, but it is the wallet's. From the rebuilt requests, with the contract's formulas.
  let unclaimedRequestPremium = 0n;
  const dqEnd = dq as DQ | null;
  const rqEnd = rq as RQ | null;
  if (dqEnd && dqEnd.epoch <= lastProcessed) {
    const s0 = snaps.get(dqEnd.epoch);
    if (s0) unclaimedRequestPremium += (dqShares(dqEnd) * (prevAcc - s0.acc)) / ACC;
  }
  if (rqEnd && rqEnd.epoch <= lastProcessed) {
    const s0 = snaps.get(rqEnd.epoch);
    if (s0) unclaimedRequestPremium += (rqEnd.shares * s0.perShare) / ACC;
  }
  const pendingRaw = live.pendingPremium + unclaimedRequestPremium;
  const pendingPremium = units(pendingRaw, dU);
  const premiumClaimed = units(claimed, dU);
  const premiumEarned = premiumClaimed + pendingPremium;
  const sharesRebuilt = econShares();
  const premiumRebuilt = accrued - claimed;
  const tol = 2n;
  const ok =
    abs(sharesRebuilt - sharesLive) <= tol + sharesLive / 1_000_000_000n &&
    abs(premiumRebuilt - pendingRaw) <= tol + BigInt(epochs.length) * 2n;
  const pnlUsd = valueUsd + pendingPremium + withdrawnUsd + claimedUsd - depositedUsd;
  const unrealisedUsd = valueUsd - cost;
  const realisedUsd = realisedFlows + premiumEarned;

  // The running epoch, when the wallet is in it.
  let exposure: Exposure | null = null;
  const runningShares = sharesLive;
  if (live.locked && runningShares > 0n && live.totalSupply > 0n) {
    const e = live.currentEpoch;
    const ev = em.get(e) ?? {};
    const share = Number((runningShares * 1_000_000_000n) / live.totalSupply) / 1_000_000_000;
    const s = live.series;
    const expired = s ? now >= s.expiry : false;
    if (s && s.sold > 0) {
      const perOption = s.premium / s.sold;
      const be = input.isCall ? s.strike + perOption : s.strike - perOption;
      const tenor = s.expiry - now;
      exposure = {
        seriesId: s.id,
        strike: s.strike,
        expiry: s.expiry,
        phase: expired ? "expired" : "selling",
        shareOfVault: share,
        optionsSold: s.sold * share,
        collateralAtRisk: s.collateral * share,
        collateralAtRiskUsd: input.isCall ? s.collateral * share * s.strike : s.collateral * share,
        premiumShare: s.premium * share,
        breakEven: be,
        spot: input.spot,
        modelProbItm:
          expired || input.sigma === null
            ? null
            : modelOddsBeyond(input.isCall, input.spot, s.strike, input.sigma, tenor),
        modelProbLoss:
          expired || input.sigma === null
            ? null
            : modelOddsBeyond(input.isCall, input.spot, be, input.sigma, tenor),
      };
    } else if (s) {
      exposure = {
        seriesId: s.id,
        strike: s.strike,
        expiry: s.expiry,
        phase: expired ? "expired" : "selling",
        shareOfVault: share,
        optionsSold: 0,
        collateralAtRisk: 0,
        collateralAtRiskUsd: 0,
        premiumShare: 0,
        breakEven: null,
        spot: input.spot,
        modelProbItm: null,
        modelProbLoss: null,
      };
    }
    epochs.push({
      ...meta,
      underlying: input.underlying,
      isCall: input.isCall,
      assetSymbol: input.assetSymbol,
      epoch: e,
      status: !s ? "open" : expired ? "expired-settling" : "running",
      openedAt: ev.opened?.t ?? null,
      closedAt: null,
      seriesId: s?.id ?? ev.proposed?.seriesId ?? null,
      strike: s?.strike ?? null,
      expiry: s?.expiry ?? null,
      settlementPrice: null,
      shareOfVault: share,
      premium: null,
      payoutAssets: null,
      payoutUsd: null,
      net: null,
      spotAtOpen: ev.opened?.spot ?? null,
      holdUsd: null,
      txOpened: ev.opened?.tx ?? null,
      txProposed: ev.proposed?.tx ?? null,
      txClosed: null,
    });
  }

  const hasNow =
    sharesLive > 0n ||
    pendingRaw > 0n ||
    queuedDeposit > 0n ||
    live.claimableRedeemAssets > 0n ||
    live.claimableDepositShares > 0n;

  return {
    position: {
      ...meta,
      isCall: input.isCall,
      underlying: input.underlying,
      assetSymbol: input.assetSymbol,
      shares: units(sharesLive, dS),
      valueAssets,
      valueUsd,
      assetUsd,
      pendingPremium,
      premiumClaimable: units(live.pendingPremium, dU),
      premiumClaimed,
      premiumEarned,
      depositedAssets: units(depositedAssets, dA),
      withdrawnAssets: units(withdrawnAssets, dA),
      depositedUsd,
      withdrawnUsd,
      costBasisUsd: cost,
      pnlUsd,
      pnlAssets: valueAssets + units(withdrawnAssets - depositedAssets, dA),
      realisedUsd,
      unrealisedUsd,
      queuedDeposit: units(queuedDeposit, dA),
      queuedRedeemShares: units(
        live.redeemRequest.epoch > live.lastProcessedEpoch ? live.redeemRequest.amount : 0n,
        dS,
      ),
      claimableDepositShares: units(live.claimableDepositShares, dS),
      claimableRedeemAssets: units(live.claimableRedeemAssets, dA),
      exposure,
      check: {
        sharesRebuilt: units(sharesRebuilt, dS),
        sharesLive: units(sharesLive, dS),
        premiumRebuilt: units(premiumRebuilt, dU),
        premiumLive: pendingPremium,
        ok,
      },
      epochs,
      touched: touched || hasNow,
      firstAt,
    },
    steps,
    markers,
    activity,
    priceAt: (t: number) => (t >= now ? assetUsd : px(t)),
  };
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function fmtNum(x: number, frac = 4): string {
  return x.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(x) > 0 && Math.abs(x) < 0.01 ? 6 : frac,
  });
}
const usd$ = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ================================================================ activity */

export type ActivityKind =
  | "deposit"
  | "deposit-queued"
  | "deposit-cancelled"
  | "deposit-claimed"
  | "withdraw"
  | "redeem-queued"
  | "redeem-claimed"
  | "premium-claimed"
  | "shares-in"
  | "shares-out"
  | "option-bought"
  | "option-received"
  | "option-redeemed"
  | "agent";

export interface ActivityRow {
  chainId: number;
  deployment: string;
  version: string;
  vault: string | null;
  symbol: string | null;
  t: number | null;
  block: number;
  logIndex: number;
  kind: ActivityKind;
  text: string;
  tx: string;
  /** What moved: the asset, the amount in it and its USD value at the time (oracle price then), when it is money. */
  asset?: string;
  amount?: number;
  usd?: number;
}

/** Newest first; within a chain by block and log index. */
export function sortActivity(rows: ActivityRow[]): ActivityRow[] {
  return [...rows].sort(
    (a, b) =>
      (b.t ?? 0) - (a.t ?? 0) || b.chainId - a.chainId || b.block - a.block || b.logIndex - a.logIndex,
  );
}

/* ================================================================ options */

export interface OptionInput {
  chainId: number;
  deployment: string;
  version: string;
  vault: string;
  symbol: string;
  underlying: string;
  isCall: boolean;
  /** Options carry the underlying's decimals. */
  underlyingDecimals: number;
  usdgDecimals: number;
  spot: number;
  series: {
    id: string;
    strike: number;
    expiry: number;
    settled: boolean;
    cancelled: boolean;
    /** Calls: token fraction per option (WAD); puts: USD per option (WAD). */
    payoutPerOption: bigint;
    /** USD per token. */
    settlementPrice: number;
    premium: bigint;
    sold: bigint;
  };
  balance: bigint;
}

export type OptionState = "live" | "expired" | "paid" | "worthless" | "cancelled";

export interface OptionPosition {
  chainId: number;
  deployment: string;
  version: string;
  vault: string;
  symbol: string;
  underlying: string;
  isCall: boolean;
  seriesId: string;
  strike: number;
  expiry: number;
  state: OptionState;
  held: number;
  bought: number;
  premiumPaid: number;
  /** strike ± premium paid per option: where the buyer's payout covers its cost. */
  breakEven: number | null;
  settlementPrice: number | null;
  /** USD one option pays (settled), or refunds (cancelled). */
  payoutPerOptionUsd: number | null;
  /** What the options still held can be redeemed for, in what they pay (stock tokens for calls, USDG for puts). */
  redeemable: number;
  redeemableUnit: string;
  redeemableUsd: number;
  redeemed: number;
  redeemedUsd: number;
  /** For a live or expired series: what the held options would pay if they settled at today's spot. Not a price. */
  intrinsicNowUsd: number | null;
  /** redeemedUsd + redeemableUsd − premiumPaid (null while the series is open). */
  netUsd: number | null;
  spot: number;
}

export function buildOptions(
  inputs: OptionInput[],
  logs: PLog[],
  account: string,
  now: number,
): { options: OptionPosition[]; activity: ActivityRow[] } {
  const acct = account.toLowerCase();
  const activity: ActivityRow[] = [];
  const options: OptionPosition[] = [];
  for (const o of inputs) {
    const s = o.series;
    const dO = o.underlyingDecimals;
    const em = logs
      .filter(
        (l) =>
          l.source === "epochManager" &&
          l.deployment === o.deployment &&
          String(l.args.seriesId) === s.id &&
          (l.event === "OptionsBought" || l.event === "OptionsRedeemed"),
      )
      .sort(byChainOrder);
    let bought = 0n;
    let premiumPaid = 0n;
    let redeemed = 0n;
    let paidOut = 0n;
    const label = `${o.underlying} ${o.isCall ? "call" : "put"} ${usd$(s.strike)}`;
    const row = (
      l: PLog,
      kind: ActivityKind,
      text: string,
      money?: { asset: string; amount: number; usd: number },
    ) =>
      activity.push({
        ...money,
        chainId: o.chainId,
        deployment: o.deployment,
        version: o.version,
        vault: o.vault,
        symbol: o.symbol,
        t: l.time,
        block: l.block,
        logIndex: l.logIndex,
        kind,
        text,
        tx: l.tx,
      });
    for (const l of em) {
      const a = l.args;
      if (l.event === "OptionsBought") {
        const buyer = A(a.buyer);
        const to = A(a.recipient);
        if (to === acct) {
          bought += B(a.amount);
          premiumPaid += B(a.premium);
          row(
            l,
            buyer === acct ? "option-bought" : "option-received",
            `${buyer === acct ? "bought" : `received from ${short(buyer)}`} ${fmtNum(units(B(a.amount), dO))} ${label} for ${fmtNum(units(B(a.premium), o.usdgDecimals))} USDG`,
            {
              asset: "USDG",
              amount: -units(B(a.premium), o.usdgDecimals),
              usd: -units(B(a.premium), o.usdgDecimals),
            },
          );
        } else if (buyer === acct) {
          row(
            l,
            "option-bought",
            `bought ${fmtNum(units(B(a.amount), dO))} ${label} for ${short(to)}, ${fmtNum(units(B(a.premium), o.usdgDecimals))} USDG`,
          );
        }
      } else if (A(a.holder) === acct) {
        redeemed += B(a.amount);
        paidOut += B(a.paid);
        const unit = s.cancelled || !o.isCall ? "USDG" : o.underlying;
        const dec = s.cancelled || !o.isCall ? o.usdgDecimals : dO;
        row(
          l,
          "option-redeemed",
          `redeemed ${fmtNum(units(B(a.amount), dO))} ${label} for ${fmtNum(units(B(a.paid), dec))} ${unit}`,
          {
            asset: unit,
            amount: units(B(a.paid), dec),
            usd: unit === "USDG" ? units(B(a.paid), dec) : units(B(a.paid), dec) * s.settlementPrice,
          },
        );
      }
    }
    if (o.balance === 0n && bought === 0n && redeemed === 0n) continue;
    const held = units(o.balance, dO);
    const state: OptionState = s.cancelled
      ? "cancelled"
      : s.settled
        ? s.payoutPerOption > 0n
          ? "paid"
          : "worthless"
        : now >= s.expiry
          ? "expired"
          : "live";
    const ppo = units(s.payoutPerOption, 18);
    const sold = units(s.sold, dO);
    const refund = sold > 0 ? units(s.premium, o.usdgDecimals) / sold : 0;
    const perOptionUsd =
      state === "cancelled" ? refund : s.settled ? (o.isCall ? ppo * s.settlementPrice : ppo) : null;
    const redeemable = state === "cancelled" ? held * refund : s.settled ? held * ppo : 0;
    const redeemableUnit = state === "cancelled" || !o.isCall ? "USDG" : o.underlying;
    const redeemableUsd = perOptionUsd === null ? 0 : held * perOptionUsd;
    const redeemedUnits =
      state === "cancelled" || !o.isCall ? units(paidOut, o.usdgDecimals) : units(paidOut, dO);
    const redeemedUsd =
      state === "cancelled" || !o.isCall ? redeemedUnits : redeemedUnits * s.settlementPrice;
    const boughtN = units(bought, dO);
    const paidN = units(premiumPaid, o.usdgDecimals);
    const perPaid = boughtN > 0 ? paidN / boughtN : null;
    options.push({
      chainId: o.chainId,
      deployment: o.deployment,
      version: o.version,
      vault: o.vault,
      symbol: o.symbol,
      underlying: o.underlying,
      isCall: o.isCall,
      seriesId: s.id,
      strike: s.strike,
      expiry: s.expiry,
      state,
      held,
      bought: boughtN,
      premiumPaid: paidN,
      breakEven: perPaid === null ? null : o.isCall ? s.strike + perPaid : s.strike - perPaid,
      settlementPrice: s.settled && s.settlementPrice > 0 ? s.settlementPrice : null,
      payoutPerOptionUsd: perOptionUsd,
      redeemable,
      redeemableUnit,
      redeemableUsd,
      redeemed: redeemedUnits,
      redeemedUsd,
      intrinsicNowUsd:
        state === "live" || state === "expired"
          ? held * (o.isCall ? Math.max(o.spot - s.strike, 0) : Math.max(s.strike - o.spot, 0))
          : null,
      netUsd: state === "live" || state === "expired" ? null : redeemedUsd + redeemableUsd - paidN,
      spot: o.spot,
    });
  }
  options.sort((a, b) => b.expiry - a.expiry || a.seriesId.localeCompare(b.seriesId));
  return { options, activity };
}

/* ================================================================ agents */

export interface AgentInput {
  chainId: number;
  deployment: string;
  version: string;
  registry: string;
  id: string;
  owner: string;
  signer: string;
  payout: string;
  status: number;
  strikes: number;
  accepted: number;
  rejected: number;
  /** USDG. */
  bond: number;
  unbonding: number;
  settledEpochs: number;
  /** Depositors' cumulative result under this agent, USDG. */
  cumulativePnl: number;
  /** FeeManager.claimable(payout), USDG. */
  feesClaimable: number;
  usdgDecimals: number;
}

export interface AgentView extends Omit<AgentInput, "usdgDecimals"> {
  roles: ("owner" | "signer" | "payout")[];
  slashes: number;
  slashedUsdg: number;
  bondPosted: number;
  /** The agent's share of performance fees credited to its payout address, USDG. */
  feesCredited: number;
  feesClaimed: number;
}

export function buildAgents(inputs: AgentInput[], logs: PLog[], account: string): AgentView[] {
  const acct = account.toLowerCase();
  const out: AgentView[] = [];
  for (const g of inputs) {
    const roles = (["owner", "signer", "payout"] as const).filter((r) => g[r].toLowerCase() === acct);
    if (roles.length === 0) continue;
    const reg = logs.filter((l) => l.deployment === g.deployment && l.source === "agentRegistry");
    const fee = logs.filter((l) => l.deployment === g.deployment && l.source === "feeManager");
    const ofAgent = (l: PLog) => String(l.args.agentId) === g.id;
    const slashed = reg.filter((l) => l.event === "Slashed" && ofAgent(l));
    const { usdgDecimals, ...rest } = g;
    out.push({
      ...rest,
      roles: [...roles],
      slashes: slashed.length,
      slashedUsdg: slashed.reduce((s, l) => s + units(B(l.args.amount), usdgDecimals), 0),
      bondPosted: reg
        .filter((l) => l.event === "BondPosted" && ofAgent(l))
        .reduce((s, l) => s + units(B(l.args.amount), usdgDecimals), 0),
      feesCredited: fee
        .filter((l) => l.event === "FeesCredited" && A(l.args.agent) === g.payout.toLowerCase())
        .reduce((s, l) => s + units(B(l.args.agentAmount), usdgDecimals), 0),
      feesClaimed: fee
        .filter((l) => l.event === "Claimed" && A(l.args.account) === g.payout.toLowerCase())
        .reduce((s, l) => s + units(B(l.args.amount), usdgDecimals), 0),
    });
  }
  return out;
}

/* ================================================================ the whole wallet */

const DAY = 86_400;

/** Totals over the positions. */
export function totalsOf(positions: VaultPosition[]): Totals {
  const sum = (f: (p: VaultPosition) => number) => positions.reduce((s, p) => s + f(p), 0);
  const depositedUsd = sum((p) => p.depositedUsd);
  const pnlUsd = sum((p) => p.pnlUsd);
  return {
    valueUsd: sum((p) => p.valueUsd + p.pendingPremium),
    depositedUsd,
    withdrawnUsd: sum((p) => p.withdrawnUsd),
    premiumEarned: sum((p) => p.premiumEarned),
    premiumClaimed: sum((p) => p.premiumClaimed),
    premiumPending: sum((p) => p.pendingPremium),
    pnlUsd,
    pnlPct: depositedUsd > 0 ? pnlUsd / depositedUsd : null,
    realisedUsd: sum((p) => p.realisedUsd),
    unrealisedUsd: sum((p) => p.unrealisedUsd),
    vaults: positions.filter((p) => p.valueUsd > 0 || p.pendingPremium > 0).length,
  };
}

/**
 * The wallet's value over time: a point at every step of every vault (its own flows, the settlements and opens of
 * epochs it was in), one a day at 00:00 UTC in between (call vaults move with the feed), and one now from today's
 * reads. `invested` is deposits − withdrawals − premium claimed so far, so value − invested is the P&L then.
 */
export function valueSeries(replays: VaultReplay[], now: number, totals: Totals): ChartPoint[] {
  const all = replays.filter((r) => r.steps.length > 0);
  if (all.length === 0) return [];
  const first = Math.min(...all.map((r) => r.steps[0]!.t));
  const times = new Set<number>();
  for (const r of all) for (const s of r.steps) if (s.t < now) times.add(s.t);
  for (let t = Math.ceil(first / DAY) * DAY; t < now; t += DAY) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const idx = all.map(() => -1);
  const points: ChartPoint[] = [];
  for (const t of sorted) {
    let value = 0;
    let invested = 0;
    all.forEach((r, i) => {
      while (idx[i]! + 1 < r.steps.length && r.steps[idx[i]! + 1]!.t <= t) idx[i] = idx[i]! + 1;
      const s = idx[i]! >= 0 ? r.steps[idx[i]!]! : null;
      if (!s) return;
      value += s.assets * r.priceAt(t) + s.premiumPending;
      invested += s.invested;
    });
    points.push({ t, value, invested });
  }
  points.push({
    t: now,
    value: totals.valueUsd,
    invested: totals.depositedUsd - totals.withdrawnUsd - totals.premiumClaimed,
  });
  return points;
}
