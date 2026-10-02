// The price mirror audit for the app: the JSON /api/mirror-audit serves, its per-instance cache, and the text the
// proof page and the vault badge show. Pure: the route passes in the SDK's `auditMirror`, so this file can be tested
// without a network (e2e/mirror.spec.ts). Only types come from @strike/sdk.

import type { MirrorAudit, MirrorFeedAudit, MirrorRoundCheck } from "@strike/sdk";

/** The testnets whose prices come from MirrorFeeds. Robinhood Chain mainnet reads Chainlink directly. */
export const MIRROR_CHAINS = [46630, 421614] as const;
export type MirrorChainId = (typeof MIRROR_CHAINS)[number];

export const MIRROR_CHAIN_NAMES: Record<MirrorChainId, string> = {
  46630: "Robinhood Chain testnet",
  421614: "Arbitrum Sepolia",
};

/** How long an instance reuses a computed audit (the CDN keeps it as long: see the route's Cache-Control). */
export const MIRROR_TTL_MS = 10 * 60_000;
/** A failed or partial audit is retried sooner. */
export const MIRROR_ERROR_TTL_MS = 60_000;

/** The command that reproduces an answer, with no key. */
export const verifyCommand = (chainId: number, symbol?: string) =>
  `node scripts/verify-mirror.mjs --chain ${chainId}${symbol ? ` --symbol ${symbol}` : ""}`;

export function isMirrorChain(id: unknown): id is MirrorChainId {
  return MIRROR_CHAINS.includes(id as MirrorChainId);
}

/** `?chain=` as a mirror chain id, or an error message for a 400. Default 46630. */
export function parseMirrorChain(param: string | null): { chainId: MirrorChainId } | { error: string } {
  if (param === null || param === "") return { chainId: 46630 };
  const id = /^\d+$/.test(param) ? Number(param) : NaN;
  if (!isMirrorChain(id)) {
    return {
      error: `chain must be ${MIRROR_CHAINS.join(" or ")}: the testnets whose prices are mirrored (got "${param}")`,
    };
  }
  return { chainId: id };
}

// ------------------------------------------------------------------ JSON shape

/** One round, as JSON (big numbers as decimal strings). */
export interface MirrorRoundJson {
  roundId: string;
  /** The answer with the feed's decimals ("356.68"), and raw. */
  price: string;
  answer: string;
  updatedAt: number;
  pushTx: string | null;
  status: MirrorRoundCheck["status"];
  /** The mainnet round with the same updatedAt: "phase:aggregator round" and the proxy round id. */
  mainnetRound: string | null;
  mainnetRoundId: string | null;
  mainnetPrice: string | null;
}

export interface MirrorGapJson {
  symbol: string;
  fromRound: string;
  toRound: string;
  from: number;
  to: number;
  seconds: number;
  mainnetRoundsBetween: number;
}

export interface MirrorFeedJson {
  symbol: string;
  testnetFeed: string;
  mainnetFeed: string | null;
  mainnetDescription: string | null;
  decimals: number;
  latestRound: string;
  /** Keeper rounds checked and matched (the deploy seed and unchecked feeds excluded). */
  checked: number;
  matched: number;
  /** Mainnet prints from the keeper's first push to its last, and after the last. */
  mainnetPrints: number;
  mainnetPrintsSince: number;
  largestGap: MirrorGapJson | null;
  unverifiable: string | null;
  seed: MirrorRoundJson | null;
  rounds: MirrorRoundJson[];
}

export interface MirrorAuditJson {
  chainId: number;
  chainName: string;
  /** When the chains were read (the mainnet head's time), ISO. */
  checkedAt: string;
  testnetBlock: string;
  mainnetBlock: string;
  ok: boolean;
  rounds: number;
  matched: number;
  mismatched: number;
  counts: MirrorAudit["summary"]["counts"];
  unverifiable: MirrorAudit["summary"]["unverifiable"];
  seeds: { symbol: string; roundId: string; price: string; updatedAt: number }[];
  largestGap: MirrorGapJson | null;
  /** Every round that failed, across feeds. */
  mismatches: (MirrorRoundJson & { symbol: string })[];
  /** The feed each deployment's StockOracle reads for each token, against the audited one. */
  oracleFeeds: MirrorAudit["oracleFeeds"];
  /** The StockOracle each deployment's EpochManager reads, against the recorded one. */
  managerOracles: MirrorAudit["managerOracles"];
  feeds: MirrorFeedJson[];
  command: string;
}

/** An answer with its decimals, as "443.21" (same as the SDK's fmtAnswer, kept here so this file has no runtime SDK import). */
export function formatAnswer(answer: bigint, decimals: number): string {
  const neg = answer < 0n;
  const a = neg ? -answer : answer;
  const d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / d}${frac ? `.${frac}` : ""}`;
}

function roundJson(r: MirrorRoundCheck, decimals: number): MirrorRoundJson {
  return {
    roundId: r.roundId.toString(),
    price: formatAnswer(r.answer, decimals),
    answer: r.answer.toString(),
    updatedAt: Number(r.updatedAt),
    pushTx: r.pushTx,
    status: r.status,
    mainnetRound: r.mainnet ? `${r.mainnet.phase}:${r.mainnet.aggregatorRound}` : null,
    mainnetRoundId: r.mainnet ? r.mainnet.roundId.toString() : null,
    mainnetPrice: r.mainnet ? formatAnswer(r.mainnet.answer, decimals) : null,
  };
}

const gapJson = (symbol: string, g: MirrorFeedAudit["largestGap"]): MirrorGapJson | null =>
  g
    ? {
        symbol,
        fromRound: g.fromRound.toString(),
        toRound: g.toRound.toString(),
        from: Number(g.from),
        to: Number(g.to),
        seconds: Number(g.seconds),
        mainnetRoundsBetween: g.mainnetRoundsBetween,
      }
    : null;

const FAILED = new Set<MirrorRoundCheck["status"]>([
  "no-mainnet-round",
  "answer-differs",
  "future-timestamp",
]);

/** The SDK's audit as JSON for /api/mirror-audit. */
export function toMirrorAuditJson(audit: MirrorAudit): MirrorAuditJson {
  const s = audit.summary;
  const feeds: MirrorFeedJson[] = audit.feeds.map((f) => {
    const keeper = f.rounds.filter((r) => r.status !== "deploy-seed" && r.status !== "unchecked");
    return {
      symbol: f.symbol,
      testnetFeed: f.testnetFeed,
      mainnetFeed: f.mainnetFeed,
      mainnetDescription: f.mainnetDescription,
      decimals: f.testnetDecimals,
      latestRound: f.latestRound.toString(),
      checked: keeper.length,
      matched: f.counts.match,
      mainnetPrints: f.mainnetRoundsInWindow,
      mainnetPrintsSince: f.mainnetRoundsAfterLastPush,
      largestGap: gapJson(f.symbol, f.largestGap),
      unverifiable: f.unverifiable,
      seed: f.seed ? roundJson(f.seed, f.testnetDecimals) : null,
      rounds: f.rounds.map((r) => roundJson(r, f.testnetDecimals)),
    };
  });
  return {
    chainId: audit.chainId,
    chainName: isMirrorChain(audit.chainId) ? MIRROR_CHAIN_NAMES[audit.chainId] : `chain ${audit.chainId}`,
    checkedAt: new Date(Number(audit.mainnetTime) * 1000).toISOString(),
    testnetBlock: audit.testnetBlock.toString(),
    mainnetBlock: audit.mainnetBlock.toString(),
    ok: audit.ok,
    rounds: s.rounds,
    matched: s.matched,
    mismatched: s.mismatched,
    counts: s.counts,
    unverifiable: s.unverifiable,
    seeds: s.seeds.map((x) => ({
      symbol: x.symbol,
      roundId: x.roundId.toString(),
      price: formatAnswer(x.answer, audit.feeds.find((f) => f.symbol === x.symbol)?.testnetDecimals ?? 8),
      updatedAt: Number(x.updatedAt),
    })),
    largestGap: s.largestGap ? gapJson(s.largestGap.symbol, s.largestGap) : null,
    mismatches: feeds.flatMap((f) =>
      f.rounds.filter((r) => FAILED.has(r.status)).map((r) => ({ ...r, symbol: f.symbol })),
    ),
    oracleFeeds: audit.oracleFeeds,
    managerOracles: audit.managerOracles,
    feeds,
    command: verifyCommand(audit.chainId),
  };
}

// ------------------------------------------------------------------ cache

type Auditor = (chainId: MirrorChainId) => Promise<MirrorAudit>;

interface Entry {
  at: number;
  ttl: number;
  value?: MirrorAuditJson;
  error?: string;
}

/**
 * One audit per chain per {@link MIRROR_TTL_MS} on this instance, with concurrent requests sharing one run. A failure
 * is remembered for {@link MIRROR_ERROR_TTL_MS} so a struggling RPC is not hammered by every visitor.
 */
export class MirrorAuditCache {
  private entries = new Map<MirrorChainId, Entry>();
  private inflight = new Map<MirrorChainId, Promise<Entry>>();

  constructor(
    private readonly audit: Auditor,
    private readonly now: () => number = Date.now,
  ) {}

  async get(chainId: MirrorChainId): Promise<{ value?: MirrorAuditJson; error?: string; cached: boolean }> {
    const hit = this.entries.get(chainId);
    if (hit && this.now() - hit.at < hit.ttl) return { value: hit.value, error: hit.error, cached: true };
    let run = this.inflight.get(chainId);
    if (!run) {
      run = this.audit(chainId)
        .then((a): Entry => ({ at: this.now(), ttl: MIRROR_TTL_MS, value: toMirrorAuditJson(a) }))
        .catch((err: unknown): Entry => ({
          at: this.now(),
          ttl: MIRROR_ERROR_TTL_MS,
          error: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        }))
        .then((e) => {
          this.entries.set(chainId, e);
          this.inflight.delete(chainId);
          return e;
        });
      this.inflight.set(chainId, run);
    }
    const e = await run;
    return { value: e.value, error: e.error, cached: false };
  }
}

// ------------------------------------------------------------------ text

/** A feed of the audit for a vault's underlying (by symbol, case-insensitive). */
export function feedFor(audit: MirrorAuditJson, symbol: string): MirrorFeedJson | null {
  const s = symbol.toUpperCase().replace(/^RH/, "");
  return audit.feeds.find((f) => f.symbol.toUpperCase() === s) ?? null;
}

/** The vault page's one-liner for a symbol: the badge text, and whether every round matched. */
export function mirrorBadge(
  audit: MirrorAuditJson,
  symbol: string,
): { ok: boolean; text: string; title: string } | null {
  const f = feedFor(audit, symbol);
  if (!f) return null;
  if (f.unverifiable) {
    return {
      ok: false,
      text: `Price not checkable against mainnet Chainlink (${f.rounds.length} round${f.rounds.length === 1 ? "" : "s"})`,
      title: f.unverifiable,
    };
  }
  const ok = f.matched === f.checked;
  const n = `${f.matched} of ${f.checked} round${f.checked === 1 ? "" : "s"}`;
  return ok
    ? {
        ok,
        text: `Price checked against mainnet Chainlink ✓ (${n})`,
        title: `Every ${f.symbol} price the keeper pushed to this testnet equals a Robinhood Chain mainnet Chainlink round (same time, same answer). Checked ${audit.checkedAt.slice(0, 16).replace("T", " ")} UTC.`,
      }
    : {
        ok,
        text: `Price mirror audit: ${f.checked - f.matched} of ${f.checked} rounds do not match mainnet Chainlink`,
        title: "See the price mirror audit for the rounds that differ.",
      };
}

/** "21h 33m", "3d 2h", "14m". */
export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** The headline: "66 of 66 rounds match Robinhood Chain mainnet Chainlink". */
export const headline = (a: Pick<MirrorAuditJson, "matched" | "rounds">) =>
  `${a.matched} of ${a.rounds} rounds match Robinhood Chain mainnet Chainlink`;
