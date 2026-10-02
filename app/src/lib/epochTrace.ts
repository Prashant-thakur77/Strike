// The epoch trace on the vault page: every step of the current and the last epoch, each with its transaction and the
// evidence it carries (the opening snapshot, the anchored decision record, the accepted series or the rejection and
// its slash, each buy, the settlement price and round, redemptions and claims). The server reads the logs
// (src/lib/epochTraceRead.ts, served by /api/epoch-trace); this file turns decoded logs into the steps. Pure, with no
// SDK import, so the Playwright specs load it as it is (e2e/trace.spec.ts).

import { formatUnits } from "viem";
import { REASONS } from "./labels";

/** A decoded log of one of the contracts the trace reads. */
export interface TraceLog {
  source: "epochManager" | "vault" | "oracle" | "decisionLog";
  eventName: string;
  args: Record<string, unknown>;
  tx: string;
  block: bigint;
  logIndex: number;
  /** The block's timestamp (null when it could not be read). */
  time: number | null;
}

export interface TraceContext {
  chainId: number;
  vault: string;
  explorer: string;
  /** StrikeVault.currentEpoch: the last epoch opened (it stays until the next opens). */
  currentEpoch: bigint;
  /** EpochManager.EpochState of the vault now: 0 Idle, 1 Open, 2 Selling. */
  state: number;
  isCall: boolean;
  underlying: { address: string; symbol: string; decimals: number };
  asset: { symbol: string; decimals: number };
  /** The vault share's decimals. */
  shareDecimals: number;
  usdgDecimals: number;
  /** `epochs(vault).openSigma` (WAD): the current epoch's snapshot volatility. */
  openSigma: bigint | null;
  /** The chain head's timestamp. */
  now: number;
}

export type StepKind =
  "open" | "record" | "rejected" | "accepted" | "buy" | "settle" | "abort" | "pending" | "redeem" | "claim";

export interface TraceStepJson {
  kind: StepKind;
  title: string;
  /** The evidence the step carries, one fact per line. */
  facts: string[];
  tx: string | null;
  time: number | null;
  tone: "good" | "bad" | "neutral";
  /** For a decision record: where it is published, and its hash. */
  record?: { uri: string; hash: string; agentId: string };
  /** For a settlement: the round the oracle recorded (checked against mainnet by /api/settlement-audit). */
  round?: { roundId: string; price: string; tx: string | null };
}

export interface TraceEpochJson {
  epoch: string;
  current: boolean;
  status: "open" | "selling" | "settled" | "aborted";
  seriesId: string | null;
  expiry: number | null;
  /** The settlement price in USD ("436.0712"), once the epoch settled with options sold; null otherwise. */
  settlementPrice?: string | null;
  steps: TraceStepJson[];
}

export interface EpochTraceJson {
  chainId: number;
  vault: string;
  explorer: string;
  now: number;
  epochs: TraceEpochJson[];
}

// ------------------------------------------------------------------ formatting

const big = (x: unknown): bigint => (typeof x === "bigint" ? x : BigInt(String(x ?? 0)));

/** A token amount with at most `maxFrac` decimals (more for small amounts), "1,234.5". */
export function fmtUnits(value: bigint, decimals: number, maxFrac = 2): string {
  const n = Number(formatUnits(value, decimals));
  const frac = n !== 0 && Math.abs(n) < 1 ? Math.max(maxFrac, 4) : maxFrac;
  return n.toLocaleString("en-US", { maximumFractionDigits: frac });
}

/** A WAD dollar price, "$369.86". */
export function fmtWad(wad: bigint): string {
  return `$${Number(formatUnits(wad, 18)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20:00 UTC on Fri 2 Oct". */
export function fmtWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "1 call", "4 calls", "0.5 calls". */
const count = (n: string, one: string, many = `${one}s`) => `${n} ${n === "1" ? one : many}`;

const short = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

// ------------------------------------------------------------------ the steps

const order = (a: TraceLog, b: TraceLog) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1;

/**
 * The current epoch and the one before it, newest first, each as its steps in chain order. Logs from other vaults
 * (the EpochManager, StockOracle and DecisionLog are shared) are ignored.
 */
export function buildTrace(ctx: TraceContext, logs: readonly TraceLog[]): EpochTraceJson {
  const vault = ctx.vault.toLowerCase();
  const sorted = [...logs].sort(order);
  const ofVault = (l: TraceLog) => String(l.args.vault ?? "").toLowerCase() === vault;
  const em = sorted.filter((l) => l.source === "epochManager");
  const own = sorted.filter((l) => l.source === "vault");

  // Which series belongs to which epoch, and when each epoch closed (premium claims fall after it).
  const seriesOf = new Map<string, bigint>();
  for (const l of em)
    if (l.eventName === "SeriesProposed" && ofVault(l))
      seriesOf.set(String(l.args.epoch), big(l.args.seriesId));
  const closedAt = new Map<string, TraceLog>();
  for (const l of em)
    if ((l.eventName === "EpochSettled" || l.eventName === "EpochAborted") && ofVault(l))
      closedAt.set(String(l.args.epoch), l);

  const epochs: TraceEpochJson[] = [];
  const wanted = [ctx.currentEpoch, ctx.currentEpoch - 1n].filter((e) => e >= 1n);
  for (const e of wanted) {
    const key = e.toString();
    const seriesId = seriesOf.get(key) ?? null;
    const steps: { log: TraceLog | null; step: TraceStepJson }[] = [];
    const add = (log: TraceLog | null, step: Omit<TraceStepJson, "tx" | "time"> & Partial<TraceStepJson>) =>
      steps.push({ log, step: { tx: log?.tx ?? null, time: log?.time ?? null, ...step } });
    let expiry: number | null = null;
    let settlementPrice: string | null = null;
    let status: TraceEpochJson["status"] = "open";

    for (const l of em) {
      const a = l.args;
      const mine = ofVault(l) && String(a.epoch) === key;
      if (l.eventName === "EpochOpened" && mine) {
        const facts = [
          `Snapshot spot ${fmtWad(big(a.spot))}: every proposal this epoch is priced against it`,
        ];
        if (e === ctx.currentEpoch && ctx.openSigma)
          facts.push(`Snapshot volatility ${Number(formatUnits(ctx.openSigma, 16)).toFixed(0)}%`);
        facts.push("Vault locked: deposits and withdrawals queue until the epoch closes");
        add(l, { kind: "open", title: `Epoch ${key} opened`, facts, tone: "neutral" });
      } else if (l.eventName === "ProposalRejected" && mine) {
        const r = REASONS[Number(a.reason)] ?? { name: `Reason ${String(a.reason)}`, text: "" };
        const slashed = big(a.slashed);
        add(l, {
          kind: "rejected",
          title: `Proposal rejected: ${r.name}`,
          facts: [
            `${r.text}. Asked: strike ${fmtWad(big(a.strike))}, expiry ${fmtWhen(Number(a.expiry))}, ${count(fmtUnits(big(a.size), ctx.underlying.decimals), "option")} at ${Number(a.premiumBps) / 100}% of fair value`,
            slashed > 0n
              ? `Agent #${String(a.agentId)} slashed ${fmtUnits(slashed, ctx.usdgDecimals)} USDG from its bond, paid to this vault's depositors when the epoch closes`
              : `Agent #${String(a.agentId)} was not slashed (no bond at stake)`,
          ],
          tone: "bad",
        });
      } else if (l.eventName === "SeriesProposed" && mine) {
        expiry = Number(a.expiry);
        status = "selling";
        const delta = Number(formatUnits(big(a.delta) < 0n ? -big(a.delta) : big(a.delta), 18)).toFixed(2);
        add(l, {
          kind: "accepted",
          title: "Proposal accepted: the series is on sale",
          facts: [
            `Strike ${fmtWad(big(a.strike))}, expiry ${fmtWhen(expiry)}, ${count(fmtUnits(big(a.size), ctx.underlying.decimals), ctx.isCall ? "call" : "put")} at ${Number(a.premiumBps) / 100}% of fair value`,
            `Fair value ${fmtWad(big(a.fairValue))} per option, |delta| ${delta}, inside the vault's mandate`,
          ],
          tone: "good",
        });
      } else if (l.eventName === "OptionsBought" && seriesId !== null && big(a.seriesId) === seriesId) {
        add(l, {
          kind: "buy",
          title: `Bought ${count(fmtUnits(big(a.amount), ctx.underlying.decimals), ctx.isCall ? "call" : "put")}`,
          facts: [
            `${fmtUnits(big(a.premium), ctx.usdgDecimals)} USDG premium, escrowed for the vault until settlement`,
            `Buyer ${short(String(a.buyer))}`,
          ],
          tone: "neutral",
        });
      } else if (l.eventName === "EpochSettled" && mine) {
        status = "settled";
        const price = big(a.settlementPrice);
        if (price > 0n) settlementPrice = formatUnits(price, 18);
        const fee = big(a.fee);
        const recorded = sorted.find(
          (o) =>
            o.source === "oracle" &&
            o.eventName === "SettlementPriceRecorded" &&
            String(o.args.token ?? "").toLowerCase() === ctx.underlying.address.toLowerCase() &&
            expiry !== null &&
            Number(o.args.expiry) === expiry,
        );
        const facts = [
          price > 0n
            ? `Settlement price ${fmtWad(price)}${recorded ? `, MirrorFeed round ${String(recorded.args.roundId)}` : ""}`
            : "No options were sold, so no price was needed",
          `Paid to option holders: ${fmtUnits(big(a.payout), ctx.asset.decimals, 4)} ${ctx.asset.symbol}`,
          `Premium to the vault: ${fmtUnits(big(a.premium) - fee, ctx.usdgDecimals)} USDG${fee > 0n ? ` after a ${fmtUnits(fee, ctx.usdgDecimals)} USDG fee` : ""}`,
        ];
        add(l, {
          kind: "settle",
          title: price > 0n ? `Settled at ${fmtWad(price)}` : "Settled",
          facts,
          tone: "good",
          round: recorded
            ? {
                roundId: String(recorded.args.roundId),
                price: fmtWad(big(recorded.args.price)),
                tx: recorded.tx,
              }
            : undefined,
        });
      } else if (l.eventName === "EpochAborted" && mine) {
        status = "aborted";
        const paid = own.find((v) => v.eventName === "EpochSettled" && String(v.args.epoch) === key);
        const comp = paid ? big(paid.args.premium) : 0n;
        add(l, {
          kind: "abort",
          title: "Aborted: no series was accepted",
          facts: [
            comp > 0n
              ? `${fmtUnits(comp, ctx.usdgDecimals)} USDG of slashed bonds paid to the vault's depositors`
              : "Nothing was sold; the vault unlocked",
          ],
          tone: "neutral",
        });
      } else if (l.eventName === "OptionsRedeemed" && seriesId !== null && big(a.seriesId) === seriesId) {
        add(l, {
          kind: "redeem",
          title: `Redeemed ${count(fmtUnits(big(a.amount), ctx.underlying.decimals), "option")}`,
          facts: [
            `Paid ${fmtUnits(big(a.paid), ctx.asset.decimals, 4)} ${ctx.asset.symbol} to ${short(String(a.recipient))}`,
          ],
          tone: "neutral",
        });
      }
    }

    // Decision records anchored for this vault and epoch.
    for (const l of sorted) {
      if (
        l.source !== "decisionLog" ||
        l.eventName !== "DecisionRecorded" ||
        !ofVault(l) ||
        String(l.args.epoch) !== key
      )
        continue;
      const hash = String(l.args.recordHash);
      add(l, {
        kind: "record",
        title: "Decision record anchored in DecisionLog",
        facts: [`Agent #${String(l.args.agentId)}, keccak256 ${short(hash)}`],
        tone: "neutral",
        record: { uri: String(l.args.uri ?? ""), hash, agentId: String(l.args.agentId) },
      });
    }

    // Depositors' claims of this epoch, and premium claims made after it closed (before the next one closed).
    const closed = closedAt.get(key);
    const nextClosed = closedAt.get((e + 1n).toString());
    for (const l of own) {
      const a = l.args;
      if (l.eventName === "RedeemClaimed" && String(a.epoch) === key) {
        add(l, {
          kind: "claim",
          title: "Withdrawal claimed",
          facts: [
            `${fmtUnits(big(a.assets), ctx.asset.decimals, 4)} ${ctx.asset.symbol} for ${count(fmtUnits(big(a.shares), ctx.shareDecimals, 4), "share")}, by ${short(String(a.account))}`,
          ],
          tone: "neutral",
        });
      } else if (l.eventName === "DepositClaimed" && String(a.epoch) === key) {
        add(l, {
          kind: "claim",
          title: "Queued deposit claimed",
          facts: [
            `${fmtUnits(big(a.assets), ctx.asset.decimals, 4)} ${ctx.asset.symbol} became ${count(fmtUnits(big(a.shares), ctx.shareDecimals, 4), "share")}, by ${short(String(a.account))}`,
          ],
          tone: "neutral",
        });
      } else if (
        l.eventName === "PremiumClaimed" &&
        closed &&
        order(l, closed) > 0 &&
        (!nextClosed || order(l, nextClosed) < 0)
      ) {
        add(l, {
          kind: "claim",
          title: "Premium claimed",
          facts: [`${fmtUnits(big(a.amount), ctx.usdgDecimals)} USDG by ${short(String(a.account))}`],
          tone: "neutral",
        });
      }
    }

    steps.sort((x, y) => (x.log && y.log ? order(x.log, y.log) : x.log ? -1 : 1));
    if (status === "selling" && expiry !== null) {
      steps.push({
        log: null,
        step: {
          kind: "pending",
          title: "Settlement pending",
          facts: [
            ctx.now < expiry
              ? `Settles after ${fmtWhen(expiry)}, at the first price round at or after expiry. Anyone may call settle then.`
              : `Expired at ${fmtWhen(expiry)}; waiting for the first price round at or after expiry (the settlement price), then for the settle transaction, which anyone may send.`,
          ],
          tx: null,
          time: null,
          tone: "neutral",
        },
      });
    }
    epochs.push({
      epoch: key,
      current: e === ctx.currentEpoch,
      status,
      seriesId: seriesId === null ? null : seriesId.toString(),
      expiry,
      settlementPrice,
      steps: steps.map((s) => s.step),
    });
  }
  return { chainId: ctx.chainId, vault: ctx.vault, explorer: ctx.explorer, now: ctx.now, epochs };
}
