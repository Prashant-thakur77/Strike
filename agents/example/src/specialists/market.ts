import {
  type FeedStatus,
  MAINNET_CHAINLINK_FEEDS,
  type StrikeClient,
  aggregatorProxyAbi,
  epochManagerAbi,
  feedStatusName,
  formatWad,
  getStrikeChain,
  marketCalendarAbi,
  mirrorFeedAbi,
  mirrorRpcEndpoints,
  stockOracleAbi,
  testStockTokenAbi,
  transportFromEndpoints,
  wadToNumber,
} from "@strike/sdk";
import { type Address, createPublicClient, getAddress } from "viem";
import { cleanError } from "../candidates.js";
import { type NotProvided, type StageSource, isNotProvided, notProvided } from "../pipeline.js";

// The market analyst: may the agent trade this week at all? It reads the oracle and its freshness, the implied
// volatility input and its bounds, the NYSE session and the next open (MarketCalendar), a pending ERC-8056 corporate
// action and the L2 sequencer feed, straight from the contracts, plus the mainnet Chainlink print the testnet feed
// mirrors. Its output is a brief and a go / no-go with every check's measured value and limit. A no-go is a no-trade
// decision, recorded like any other.

/** A price round: what a feed answered and when. */
export interface FeedRound {
  roundId: string;
  /** USD per token, decimal string. */
  price: string;
  /** Unix seconds. */
  updatedAt: number;
}

/** Everything the analyst reads, in plain values (`readMarket` fills it from the chain; tests pass fixtures). */
export interface MarketReads {
  chainId: number;
  /** Chain time, unix seconds. */
  now: number;
  token: { symbol: string; address: string };
  /** `StockOracle.status(token)`: the non-reverting SafeStockFeed verdict, the price and its time. */
  oracle: { status: FeedStatus; price: string | null; updatedAt: number | null };
  /** `StockOracle.feedConfig(token)`. */
  feed: { address: string; maxPriceAge: number; corporateActionGrace: number };
  /** `StockOracle.isMarketOpen()`, and from the MarketCalendar the next session open and close. */
  session: { open: boolean; nextOpen: number | null; nextClose: number | null };
  /** `EpochManager.underlyings(token)`: the sigma the pricer uses and the bounds the admin may set it within. */
  sigma: { value: number; min: number; max: number };
  /** ERC-8056 multiplier fields of the token; not provided for a token without them. */
  corporateAction: { uiMultiplier: string; newUIMultiplier: string; effectiveAt: number } | NotProvided;
  /** The L2 sequencer uptime feed; not provided when the StockOracle has none configured. */
  sequencer: { feed: string; up: boolean; startedAt: number; grace: number } | NotProvided;
  /** The latest round of the feed the StockOracle reads (the testnet MirrorFeed). */
  mirror: FeedRound | NotProvided;
  /** The latest round of the mainnet Chainlink feed the mirror copies (Robinhood Chain mainnet). */
  mainnet: (FeedRound & { chainId: number; feed: string }) | NotProvided;
  /** The spot the MCP server's vault_state reported, to cross-check with the direct read. */
  mcpSpot: string | null;
  sources: StageSource[];
}

/** One go / no-go check: what was measured, the limit, and whether it passed. */
export interface MarketCheck {
  check: "session" | "feed-status" | "feed-fresh" | "corporate-action" | "sequencer" | "sigma-bounds";
  ok: boolean;
  /** `--ignore-session` (dry runs only) waived this failed check; the record says so. */
  waived?: boolean;
  measured: string;
  limit: string;
}

/** Two inputs that should agree, compared (PRISM's "contradictions", computed here instead of asked of an LLM). */
export interface Contradiction {
  between: [string, string];
  agree: boolean;
  measured: string;
  limit: string;
}

export interface MarketBrief {
  go: boolean;
  /** The failed checks in words (no-go), or one line saying all passed. */
  reasons: string[];
  checks: MarketCheck[];
  contradictions: Contradiction[];
  /** True when `--ignore-session` evaluated the run as if the NYSE were open. */
  sessionWaived: boolean;
  chainTimeIso: string;
  underlying: { symbol: string; address: string };
  spot: {
    price: string | null;
    status: FeedStatus;
    updatedAtIso: string | null;
    ageSeconds: number | null;
    maxAgeSeconds: number;
  };
  sigma: { value: number; min: number; max: number; source: string };
  session: { open: boolean; nextOpenIso: string | null; nextCloseIso: string | null };
  corporateAction:
    MarketReads["corporateAction"] | { provided: true; pending: boolean; effectiveAtIso: string | null };
  sequencer:
    MarketReads["sequencer"] | { provided: true; up: boolean; sinceIso: string; graceSeconds: number };
  mainnet: MarketReads["mainnet"];
}

/** How far the mirror may lag the mainnet print it copies (the keeper pushes every 10 minutes when it runs). */
export const MIRROR_LAG_LIMIT_SECONDS = 30 * 60;
/** How far the MCP server's spot may differ from the direct oracle read. */
export const SPOT_AGREEMENT_LIMIT = 0.0001;

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 5 Oct 13:30 UTC". */
export function utcLabel(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

/** "9.2 h" or "35 min". */
export function ageLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** The brief and the go / no-go, from the reads. Pure: the same reads give the same brief. */
export function marketBrief(r: MarketReads, opts: { ignoreSession?: boolean } = {}): MarketBrief {
  const checks: MarketCheck[] = [];
  const ignoreSession = opts.ignoreSession === true;

  const sessionOk = r.session.open;
  checks.push({
    check: "session",
    ok: sessionOk,
    ...(!sessionOk && ignoreSession ? { waived: true } : {}),
    measured: sessionOk
      ? `NYSE open (closes ${r.session.nextClose ? utcLabel(r.session.nextClose) : "at the session close"})`
      : `NYSE closed${r.session.nextOpen ? ` until ${utcLabel(r.session.nextOpen)}` : ""}`,
    limit: "the NYSE regular session (openEpoch and buy revert outside it)",
  });

  const status = r.oracle.status;
  const blocking: FeedStatus[] = ["InvalidPrice", "TokenPaused", "FeedPaused"];
  checks.push({
    check: "feed-status",
    ok: !blocking.includes(status),
    measured: `StockOracle.status: ${status}`,
    limit: "a valid price from a feed and token that are not paused",
  });

  const age = r.oracle.updatedAt !== null ? Math.max(0, r.now - r.oracle.updatedAt) : null;
  checks.push({
    check: "feed-fresh",
    ok: age !== null && age <= r.feed.maxPriceAge && status !== "StalePrice",
    measured:
      age === null
        ? "no price round"
        : `last print ${ageLabel(age)} old (${utcLabel(r.oracle.updatedAt as number)})`,
    limit: `at most ${ageLabel(r.feed.maxPriceAge)} old (feedConfig.maxPriceAge)`,
  });

  let corporate: MarketBrief["corporateAction"];
  let corporatePending = status === "CorporateActionPending";
  if (isNotProvided(r.corporateAction)) {
    corporate = r.corporateAction;
  } else {
    const c = r.corporateAction;
    const scheduled = c.uiMultiplier !== c.newUIMultiplier;
    const inGrace = c.effectiveAt > 0 && r.now < c.effectiveAt + r.feed.corporateActionGrace;
    corporatePending = corporatePending || scheduled || inGrace;
    corporate = {
      provided: true,
      pending: corporatePending,
      effectiveAtIso: c.effectiveAt > 0 ? iso(c.effectiveAt) : null,
    };
  }
  checks.push({
    check: "corporate-action",
    ok: !corporatePending,
    measured: corporatePending
      ? `a multiplier change is pending or took effect less than ${ageLabel(r.feed.corporateActionGrace)} ago`
      : isNotProvided(r.corporateAction)
        ? `none reported by StockOracle.status (the token's multiplier fields were not provided: ${r.corporateAction.reason})`
        : "none: uiMultiplier equals newUIMultiplier and no change took effect within the grace window",
    limit: `no ERC-8056 multiplier change pending or within ${ageLabel(r.feed.corporateActionGrace)} of taking effect`,
  });

  let sequencer: MarketBrief["sequencer"];
  let sequencerOk = true;
  let sequencerText: string;
  if (isNotProvided(r.sequencer)) {
    sequencer = r.sequencer;
    sequencerText = `not provided: ${r.sequencer.reason}`;
  } else {
    const s = r.sequencer;
    const upFor = r.now - s.startedAt;
    sequencerOk = s.up && upFor >= s.grace;
    sequencer = { provided: true, up: s.up, sinceIso: iso(s.startedAt), graceSeconds: s.grace };
    sequencerText = s.up ? `up for ${ageLabel(upFor)}` : "down";
  }
  checks.push({
    check: "sequencer",
    ok: sequencerOk,
    measured: sequencerText,
    limit: isNotProvided(r.sequencer)
      ? "up and past its grace period, when a sequencer feed is configured (the contract skips the check without one)"
      : `up for at least ${ageLabel(r.sequencer.grace)} (sequencerGrace)`,
  });

  const sigmaOk = r.sigma.value > 0 && r.sigma.value >= r.sigma.min && r.sigma.value <= r.sigma.max;
  checks.push({
    check: "sigma-bounds",
    ok: sigmaOk,
    measured: `sigma ${(r.sigma.value * 100).toFixed(1)}% a year`,
    limit: `${(r.sigma.min * 100).toFixed(0)}% to ${(r.sigma.max * 100).toFixed(0)}% (EpochManager.underlyings minSigma, maxSigma)`,
  });

  const contradictions: Contradiction[] = [];
  if (!isNotProvided(r.mirror) && !isNotProvided(r.mainnet)) {
    const lag = r.mainnet.updatedAt - r.mirror.updatedAt;
    contradictions.push({
      between: ["testnet MirrorFeed latest round", "mainnet Chainlink latest round"],
      agree: lag <= MIRROR_LAG_LIMIT_SECONDS,
      measured:
        lag <= 0
          ? `the mirror has the mainnet's latest print ($${r.mainnet.price} at ${utcLabel(r.mainnet.updatedAt)})`
          : `mainnet printed $${r.mainnet.price} at ${utcLabel(r.mainnet.updatedAt)}, ${ageLabel(lag)} after the mirror's last round ($${r.mirror.price})`,
      limit: `the mirror at most ${ageLabel(MIRROR_LAG_LIMIT_SECONDS)} behind mainnet`,
    });
  }
  if (r.mcpSpot !== null && r.oracle.price !== null) {
    const a = Number(r.mcpSpot);
    const b = Number(r.oracle.price);
    const diff = b > 0 ? Math.abs(a - b) / b : 1;
    contradictions.push({
      between: ["MCP vault_state spot", "StockOracle.status price"],
      agree: diff <= SPOT_AGREEMENT_LIMIT,
      measured: `$${r.mcpSpot} against $${r.oracle.price}`,
      limit: `within ${(SPOT_AGREEMENT_LIMIT * 100).toFixed(2)}%`,
    });
  }

  const failed = checks.filter((c) => !c.ok && !c.waived);
  const go = failed.length === 0;
  const reasons = go
    ? [
        `all ${checks.length} checks passed${checks.some((c) => c.waived) ? " (the session check waived by --ignore-session, a dry run)" : ""}`,
      ]
    : failed.map((c) =>
        c.check === "session" && r.session.nextOpen
          ? `market closed until ${utcLabel(r.session.nextOpen)}`
          : `${c.check}: ${c.measured} (limit: ${c.limit})`,
      );

  return {
    go,
    reasons,
    checks,
    contradictions,
    sessionWaived: ignoreSession && !sessionOk,
    chainTimeIso: iso(r.now),
    underlying: r.token,
    spot: {
      price: r.oracle.price,
      status,
      updatedAtIso: r.oracle.updatedAt !== null ? iso(r.oracle.updatedAt) : null,
      ageSeconds: age,
      maxAgeSeconds: r.feed.maxPriceAge,
    },
    sigma: { ...r.sigma, source: "EpochManager.underlyings(token).sigma" },
    session: {
      open: r.session.open,
      nextOpenIso: r.session.nextOpen ? iso(r.session.nextOpen) : null,
      nextCloseIso: r.session.nextClose ? iso(r.session.nextClose) : null,
    },
    corporateAction: corporate,
    sequencer,
    mainnet: r.mainnet,
  };
}

const DAY = 86_400;

/** The next session open after `now` and the next close at or after it, from the MarketCalendar (14 days ahead). */
export async function nextSession(
  isTradingDay: (day: bigint) => Promise<boolean>,
  sessionOf: (day: bigint) => Promise<readonly [bigint, bigint]>,
  now: number,
): Promise<{ nextOpen: number | null; nextClose: number | null }> {
  let nextOpen: number | null = null;
  let nextClose: number | null = null;
  const today = Math.floor(now / DAY);
  for (let i = 0; i < 14 && (nextOpen === null || nextClose === null); i++) {
    const day = BigInt(today + i);
    if (!(await isTradingDay(day))) continue;
    const [open, close] = await sessionOf(day);
    if (nextOpen === null && Number(open) > now) nextOpen = Number(open);
    if (nextClose === null && Number(close) >= now) nextClose = Number(close);
  }
  return { nextOpen, nextClose };
}

/** Read the analyst's inputs from the chain (and the mainnet Chainlink feed), for one vault. */
export async function readMarket(
  strike: StrikeClient,
  vault: string,
  mcpSpot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MarketReads> {
  const pc = strike.viem.publicClient;
  const v = await strike.getVault(getAddress(vault) as Address);
  const token = v.underlying;
  const so = strike.addresses.stockOracle;
  const em = strike.addresses.epochManager;
  const oracle = { address: so, abi: stockOracleAbi } as const;
  const sources: StageSource[] = [
    { kind: "contract", name: "StockOracle.status", address: so },
    { kind: "contract", name: "StockOracle.feedConfig", address: so },
    { kind: "contract", name: "StockOracle.isMarketOpen", address: so },
    { kind: "contract", name: "StockOracle.sequencerFeed", address: so },
    { kind: "contract", name: "EpochManager.underlyings", address: em },
  ];
  const [now, statusRaw, cfg, open, calendar, seqFeed, seqGrace, u] = await Promise.all([
    strike.blockTimestamp(),
    pc.readContract({ ...oracle, functionName: "status", args: [token] }),
    pc.readContract({ ...oracle, functionName: "feedConfig", args: [token] }),
    pc.readContract({ ...oracle, functionName: "isMarketOpen" }),
    pc.readContract({ ...oracle, functionName: "calendar" }),
    pc.readContract({ ...oracle, functionName: "sequencerFeed" }),
    pc.readContract({ ...oracle, functionName: "sequencerGrace" }),
    pc.readContract({ address: em, abi: epochManagerAbi, functionName: "underlyings", args: [token] }),
  ]);
  const [code, priceWad, updatedAt] = statusRaw;
  const nowSec = Number(now);
  const cal = { address: calendar, abi: marketCalendarAbi } as const;
  sources.push(
    { kind: "contract", name: "MarketCalendar.isTradingDay", address: calendar },
    { kind: "contract", name: "MarketCalendar.sessionOf", address: calendar },
  );
  const session = await nextSession(
    (day) => pc.readContract({ ...cal, functionName: "isTradingDay", args: [day] }),
    (day) => pc.readContract({ ...cal, functionName: "sessionOf", args: [day] }),
    nowSec,
  );

  let corporateAction: MarketReads["corporateAction"];
  try {
    const t = { address: token, abi: testStockTokenAbi } as const;
    const [ui, next, at] = await Promise.all([
      pc.readContract({ ...t, functionName: "uiMultiplier" }),
      pc.readContract({ ...t, functionName: "newUIMultiplier" }),
      pc.readContract({ ...t, functionName: "effectiveAt" }),
    ]);
    corporateAction = {
      uiMultiplier: ui.toString(),
      newUIMultiplier: next.toString(),
      effectiveAt: Number(at),
    };
    sources.push({
      kind: "contract",
      name: "ERC-8056 uiMultiplier, newUIMultiplier, effectiveAt",
      address: token,
    });
  } catch (err) {
    corporateAction = notProvided(
      `the token did not answer the ERC-8056 multiplier calls (${cleanError(err)})`,
    );
  }

  let sequencer: MarketReads["sequencer"];
  if (/^0x0{40}$/i.test(seqFeed)) {
    sequencer = notProvided(
      "no sequencer uptime feed is configured on this chain's StockOracle (sequencerFeed is the zero address); the contract skips the check too",
    );
  } else {
    try {
      const [, answer, startedAt] = await pc.readContract({
        address: seqFeed,
        abi: aggregatorProxyAbi,
        functionName: "latestRoundData",
      });
      sequencer = { feed: seqFeed, up: answer === 0n, startedAt: Number(startedAt), grace: Number(seqGrace) };
      sources.push({ kind: "contract", name: "sequencer feed latestRoundData", address: seqFeed });
    } catch (err) {
      sequencer = notProvided(`the sequencer feed did not answer (${cleanError(err)})`);
    }
  }

  const scale = (answer: bigint, decimals: number) =>
    decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
  let mirror: MarketReads["mirror"];
  try {
    const [roundId, answer, , at] = await pc.readContract({
      address: cfg.feed,
      abi: mirrorFeedAbi,
      functionName: "latestRoundData",
    });
    mirror = {
      roundId: roundId.toString(),
      price: formatWad(scale(answer, cfg.feedDecimals), 4),
      updatedAt: Number(at),
    };
    sources.push({ kind: "contract", name: "MirrorFeed.latestRoundData", address: cfg.feed });
  } catch (err) {
    mirror = notProvided(`the price feed did not answer latestRoundData (${cleanError(err)})`);
  }

  const mainnet = await readMainnet(v.underlyingSymbol, strike.chainId, env);
  if (!isNotProvided(mainnet))
    sources.push({
      kind: "contract",
      name: "Chainlink latestRoundData",
      address: mainnet.feed,
      chainId: mainnet.chainId,
    });

  return {
    chainId: strike.chainId,
    now: nowSec,
    token: { symbol: v.underlyingSymbol, address: token },
    oracle: {
      status: feedStatusName(code),
      price: priceWad > 0n ? formatWad(priceWad, 4) : null,
      updatedAt: updatedAt > 0n ? Number(updatedAt) : null,
    },
    feed: { address: cfg.feed, maxPriceAge: cfg.maxPriceAge, corporateActionGrace: cfg.corporateActionGrace },
    session: { open, nextOpen: session.nextOpen, nextClose: session.nextClose },
    sigma: { value: wadToNumber(u[2]), min: wadToNumber(u[3]), max: wadToNumber(u[4]) },
    corporateAction,
    sequencer,
    mirror,
    mainnet,
    mcpSpot,
    sources,
  };
}

/** The mainnet Chainlink feed's latest round for a stock symbol, when the chain mirrors one. */
async function readMainnet(
  symbol: string,
  chainId: number,
  env: NodeJS.ProcessEnv,
): Promise<MarketReads["mainnet"]> {
  const feed = MAINNET_CHAINLINK_FEEDS[symbol];
  if (!feed) return notProvided(`no mainnet Chainlink feed is listed for ${symbol} in strike.config.json`);
  if (chainId === 31337) return notProvided("a local devnet mirrors no mainnet feed");
  const mainnetId = 4663;
  try {
    const chain = getStrikeChain(mainnetId);
    const client = createPublicClient({
      chain,
      transport: transportFromEndpoints(mirrorRpcEndpoints(mainnetId, env)),
    });
    const [decimals, round] = await Promise.all([
      client.readContract({ address: feed, abi: DECIMALS_ABI, functionName: "decimals" }),
      client.readContract({ address: feed, abi: aggregatorProxyAbi, functionName: "latestRoundData" }),
    ]);
    const [roundId, answer, , updatedAt] = round;
    const wad =
      decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
    return {
      chainId: mainnetId,
      feed,
      roundId: roundId.toString(),
      price: formatWad(wad, 4),
      updatedAt: Number(updatedAt),
    };
  } catch (err) {
    return notProvided(`Robinhood Chain mainnet could not be read (${cleanError(err)})`);
  }
}

const DECIMALS_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
