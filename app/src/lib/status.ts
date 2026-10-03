// The liveness card on /app/proof: is Strike running by itself? The JSON /api/status serves (read on the server by
// src/lib/statusRead.ts), the scheduled jobs as the workflow files define them, and the judgments the card shows.
// Pure, with no SDK import, so the Playwright specs load it as it is (e2e/status.spec.ts).
//
// The thresholds below are display judgment, not protocol claims. The one protocol figure is the oracle's own
// `maxPriceAge` (25 hours on these deployments), read from `StockOracle.feedConfig` and shown next to them.

/** A feed whose last mirrored round is older than this on an NYSE trading day is stale (the brief's 26 hours: past
 *  the contracts' 25-hour limit, with an hour's grace). */
export const STALE_AFTER = 26 * 3600;
/** A mainnet print the keeper has not mirrored for this long marks the feed as behind. The keeper is scheduled every
 *  10 minutes; GitHub often starts scheduled runs late, so 30 minutes. */
export const LAG_GRACE = 30 * 60;

export type Tone = "good" | "warn" | "bad" | "neutral";

// ------------------------------------------------------------------ JSON shape

export interface FeedStatusJson {
  symbol: string;
  /** The testnet MirrorFeed. */
  feed: string;
  roundId: string;
  /** The answer with the feed's decimals, "356.68". */
  price: string;
  updatedAt: number;
  /** The oracle's staleness limit for this token (StockOracle.feedConfig), seconds. */
  maxPriceAge: number | null;
  /** The Robinhood Chain mainnet Chainlink proxy it copies, and that proxy's latest print (null: no mainnet feed). */
  mainnetFeed: string | null;
  mainnet: { roundId: string; price: string; updatedAt: number } | null;
  /** The testnet's latest round is mainnet's latest print (same time, same answer); null without a mainnet read. */
  mirrored: boolean | null;
  /** When mainnet has printed since: the time of the oldest unmirrored print seen (mainnet's latest, or the one
   *  before it when that is also newer than the testnet's round). */
  unmirroredSince: number | null;
  error?: string;
}

export interface SettlementRefJson {
  epoch: string;
  kind: "settled" | "aborted";
  tx: string;
  time: number | null;
  /** Settlement price, "$356.68" (null when aborted or nothing was sold). */
  price: string | null;
}

export interface VaultStatusJson {
  address: string;
  symbol: string;
  isCall: boolean;
  /** EpochManager.EpochState: 0 Idle, 1 Open, 2 Selling. */
  state: number;
  epoch: string;
  /** The selling series' expiry (unix seconds), else null. */
  expiry: number | null;
  lastSettlement: SettlementRefJson | null;
}

export interface DeploymentStatusJson {
  version: string;
  epochManager: string;
  vaults: VaultStatusJson[];
}

export interface ChainStatusJson {
  chainId: number;
  chainName: string;
  explorer: string;
  /** The testnet head's timestamp when read. */
  blockTime: number;
  /** MarketCalendar.isTradingDay(today) and StockOracle.isMarketOpen() at that block. */
  tradingDay: boolean | null;
  marketOpen: boolean | null;
  feeds: FeedStatusJson[];
  deployments: DeploymentStatusJson[];
  errors: string[];
}

export interface RunJson {
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  /** The run's title, "Weekly agent (settle)" (agent.yml's run-name), when GitHub gives one. */
  title?: string;
}

export interface ScheduleStatusJson {
  workflow: string;
  name: string;
  /** "on": the last scheduled run that was not cancelled did work; "off": it was skipped by its switch; "none":
   *  GitHub lists no scheduled run yet; "unknown": GitHub's run list could not be read. */
  state: "on" | "off" | "none" | "unknown";
  lastScheduled: RunJson | null;
  /** The newest run started by workflow_dispatch: the keeper's chain, keeper.yml dispatching agent.yml, or by hand. */
  lastManual: RunJson | null;
  /** The newest finished run of either kind that was not cancelled or skipped: what "last run" means on the card.
   *  Absent from JSON served before 3 October 2026. */
  lastRun?: RunJson | null;
  error?: string;
}

export interface StatusJson {
  generatedAt: string;
  chains: ChainStatusJson[];
  schedules: ScheduleStatusJson[];
}

// ------------------------------------------------------------------ the scheduled jobs

export interface Schedule {
  workflow: "keeper.yml" | "agent.yml";
  name: string;
  /** Each cron line of the workflow's `on.schedule`, and what it means. */
  crons: { cron: string; text: string }[];
  /** The repository variable the job's `if:` checks for 'true'. */
  gate: string;
  does: string;
}

/**
 * The two scheduled jobs, as .github/workflows/keeper.yml and agent.yml define them. e2e/status.spec.ts reads both
 * files and fails if a cron line or a switch here differs.
 */
export const SCHEDULES: readonly Schedule[] = [
  {
    workflow: "keeper.yml",
    name: "Testnet keeper",
    crons: [{ cron: "*/10 * * * *", text: "every 10 minutes" }],
    gate: "KEEPER_ENABLED",
    does: "mirrors mainnet Chainlink rounds to the MirrorFeeds on 46630 and 421614 and settles expired epochs",
  },
  {
    workflow: "agent.yml",
    name: "Weekly agent",
    crons: [
      { cron: "0 15 * * 1", text: "Mondays 15:00 UTC (propose)" },
      { cron: "15 21 * * 5", text: "Fridays 21:15 UTC (settle and record)" },
    ],
    gate: "AGENT_ENABLED",
    does: "opens each vault's epoch and proposes the week's option, then records each settlement in the DecisionLog",
  },
];

interface GitHubRun {
  event?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  html_url?: string;
  display_title?: string;
}

const runJson = (r: GitHubRun): RunJson => ({
  event: r.event ?? "",
  status: r.status ?? "",
  conclusion: r.conclusion ?? null,
  createdAt: r.created_at ?? "",
  url: r.html_url ?? "",
  ...(r.display_title ? { title: r.display_title } : {}),
});

/** Runs GitHub cancelled say nothing about the job: keeper.yml's concurrency group cancels a queued scheduled run
 *  when its own chain has already queued the next one. */
const cancelled = (r: GitHubRun) => r.conclusion === "cancelled";

/**
 * Whether a scheduled job is switched on, and how its last run went, from GitHub's list of its runs (newest first).
 * Both workflows gate their jobs on a repository variable, which is not public; a run whose jobs were all skipped
 * concludes "skipped", so the newest run that was not cancelled, scheduled or dispatched (the keeper restarts itself
 * with workflow_dispatch and dispatches agent.yml; the same switch gates both), says which way the switch is. The last
 * run is the newest finished one of either trigger that was not cancelled or skipped.
 */
export function scheduleState(
  workflow: string,
  runs: GitHubRun[] | null,
  error?: string,
): Omit<ScheduleStatusJson, "name"> {
  if (!runs)
    return { workflow, state: "unknown", lastScheduled: null, lastManual: null, lastRun: null, error };
  const own = runs.filter(
    (r) => (r.event === "schedule" || r.event === "workflow_dispatch") && !cancelled(r),
  );
  const scheduled = own.find((r) => r.event === "schedule");
  const manual = runs.find((r) => r.event === "workflow_dispatch");
  const finished = own.find((r) => r.status === "completed" && r.conclusion !== "skipped");
  const base = {
    workflow,
    lastScheduled: scheduled ? runJson(scheduled) : null,
    lastManual: manual ? runJson(manual) : null,
    lastRun: finished ? runJson(finished) : null,
  };
  const newest = own[0];
  if (!newest) return { ...base, state: "none" };
  if (newest.conclusion === "skipped") return { ...base, state: "off" };
  return { ...base, state: "on" };
}

// ------------------------------------------------------------------ judgments

export interface Verdict {
  tone: Tone;
  label: string;
  detail: string;
}

/** "3h 05m", "2d 4h", "12m", "under a minute". */
export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "under a minute";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** "Fri 2 Oct, 20:00 UTC". */
export function fmtUtc(ts: number): string {
  const d = new Date(ts * 1000);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${wd} ${d.getUTCDate()} ${mo}, ${hh}:${mm} UTC`;
}

/** How fresh one MirrorFeed is at `now`, against mainnet's latest print and the 26-hour line on trading days. */
export function feedVerdict(f: FeedStatusJson, now: number, tradingDay: boolean | null): Verdict {
  if (f.error) return { tone: "bad", label: "Unreadable", detail: f.error };
  const age = now - f.updatedAt;
  if (f.mainnetFeed === null) {
    return {
      tone: "neutral",
      label: "No mainnet feed",
      detail: `Chainlink publishes no ${f.symbol} feed on Robinhood Chain mainnet, so the keeper has nothing to mirror; its round is ${fmtAge(age)} old.`,
    };
  }
  if (tradingDay && age > STALE_AFTER) {
    return {
      tone: "bad",
      label: "Stale",
      detail: `Last mirrored ${fmtAge(age)} ago, past ${STALE_AFTER / 3600} h on a trading day. The contracts refuse a price older than ${
        f.maxPriceAge ? `${f.maxPriceAge / 3600} h` : "the oracle's limit"
      } (StalePrice), so buys and new epochs wait for the next push.${
        f.mirrored ? " Mainnet has not printed since either." : ""
      }`,
    };
  }
  if (f.mirrored === false && f.mainnet) {
    const waiting = now - (f.unmirroredSince ?? f.mainnet.updatedAt);
    if (waiting > LAG_GRACE) {
      return {
        tone: "warn",
        label: "Behind mainnet",
        detail: `Mainnet has printed since (latest ${f.mainnet.price} at ${fmtUtc(f.mainnet.updatedAt)}); a print has waited ${fmtAge(waiting)} to be mirrored. The testnet's last round is ${fmtAge(age)} old.`,
      };
    }
    return {
      tone: "good",
      label: "In step",
      detail: `Mainnet printed ${fmtAge(now - f.mainnet.updatedAt)} ago, not mirrored yet: within the ${LAG_GRACE / 60}-minute grace.`,
    };
  }
  if (f.mirrored === true) {
    return {
      tone: "good",
      label: "In step",
      detail: `Mainnet's latest print is mirrored (${fmtAge(age)} old${tradingDay === false ? "; no session today" : ""}).`,
    };
  }
  return {
    tone: "neutral",
    label: "Mainnet unread",
    detail: `Mainnet could not be read; the round is ${fmtAge(age)} old.`,
  };
}

/** The age of a chain's newest mirrored round: the most recent keeper push among its feeds that copy mainnet. */
export function newestRound(chain: ChainStatusJson): FeedStatusJson | null {
  const mirrored = chain.feeds.filter((f) => f.mainnetFeed !== null && !f.error);
  return mirrored.reduce<FeedStatusJson | null>((a, f) => (!a || f.updatedAt > a.updatedAt ? f : a), null);
}

/** The worst tone of a chain's feeds (neutral ones do not count). */
export function chainTone(chain: ChainStatusJson, now: number): Tone {
  const tones = chain.feeds.map((f) => feedVerdict(f, now, chain.tradingDay).tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  return tones.includes("good") ? "good" : "neutral";
}

/**
 * The next time a schedule's cron lines fire after `now` (unix seconds, UTC), for the two shapes the workflows use:
 * "*\/N * * * *" and "M H * * D". Null for any other shape.
 */
export function nextSlot(schedule: Schedule, now: number): number | null {
  let best: number | null = null;
  for (const { cron } of schedule.crons) {
    const [min, hour, dom, mon, dow] = cron.split(/\s+/);
    let t: number | null = null;
    const every = /^\*\/(\d+)$/.exec(min ?? "");
    if (every && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      const step = Number(every[1]) * 60;
      t = Math.floor(now / step) * step + step;
    } else if (
      /^\d+$/.test(min ?? "") &&
      /^\d+$/.test(hour ?? "") &&
      dom === "*" &&
      mon === "*" &&
      /^\d$/.test(dow ?? "")
    ) {
      const day = Math.floor(now / 86_400);
      for (let i = 0; i <= 7 && t === null; i++) {
        const d = day + i;
        if ((d + 4) % 7 !== Number(dow)) continue; // 1970-01-01 was a Thursday
        const at = d * 86_400 + Number(hour) * 3600 + Number(min) * 60;
        if (at > now) t = at;
      }
    }
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** The card's words for a scheduled job, at `now` (unix seconds). */
export function scheduleVerdict(s: ScheduleStatusJson, schedule: Schedule, now: number): Verdict {
  const when = (r: RunJson | null) => (r ? fmtUtc(Date.parse(r.createdAt) / 1000) : "");
  if (s.state === "off") {
    // The skipped run that says so: the newer of the last scheduled and the last dispatched run.
    const skipped = [s.lastScheduled, s.lastManual]
      .filter((r): r is RunJson => r?.conclusion === "skipped")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return {
      tone: "warn",
      label: "Switched off",
      detail: `The last ${skipped?.event === "workflow_dispatch" ? "run" : "scheduled run"} (${when(skipped ?? s.lastScheduled)}) was skipped: its switch, the repository variable ${schedule.gate}, is not 'true'. Run by hand until the scheduled jobs are switched on.`,
    };
  }
  if (s.state === "on") {
    // JSON from before lastRun existed: the last scheduled run, unless GitHub cancelled it.
    const last =
      s.lastRun !== undefined
        ? s.lastRun
        : s.lastScheduled?.conclusion && s.lastScheduled.conclusion !== "cancelled"
          ? s.lastScheduled
          : null;
    if (!last) {
      return {
        tone: "good",
        label: "On",
        detail: "No finished run to judge yet: the newest is still running, and cancelled runs do not count.",
      };
    }
    const failed = last.conclusion !== "success";
    const trigger = last.event === "schedule" ? "scheduled" : "dispatched";
    const mode = /\((\w+)\)$/.exec(last.title ?? "")?.[1];
    return {
      tone: failed ? "bad" : "good",
      label: failed ? "On, last run failed" : "On",
      detail: `Last run ${when(last)} (${trigger}${mode ? `, ${mode}` : ""}), ${last.conclusion}.`,
    };
  }
  if (s.state === "none") {
    const next = nextSlot(schedule, now);
    return {
      tone: "neutral",
      label: "No scheduled run yet",
      detail: `GitHub lists no scheduled run of ${schedule.workflow} yet${
        next ? `; the next slot is ${fmtUtc(next)}` : ""
      }. It does work only while the repository variable ${schedule.gate} is 'true'; until then it is run by hand.`,
    };
  }
  return {
    tone: "neutral",
    label: "Unknown",
    detail: `GitHub's run list could not be read${s.error ? ` (${s.error})` : ""}. The job runs only while the repository variable ${schedule.gate} is 'true'.`,
  };
}
