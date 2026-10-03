"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronDown, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { useAllVaults, useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { fmtBps, fmtDelta, fmtNy, fmtPct, fmtUsd, fmtWadUsd, toNumber } from "@/lib/format";
import { clockNow, seriesPhase } from "@/lib/lifecycle";
import { PROFILE_KEY, fitsProfile, type Hold, type Upside } from "@/lib/profile";
import { position, type VaultHistory, type VaultSummary } from "@/lib/reads";
import { SHOWCASE_DECISION, tourPage } from "@/lib/tour";
import { Gate } from "./Gate";
import { MetaStrip } from "./MetaStrip";
import { StateTag } from "./StateTag";
import { Skeleton } from "./Skeleton";
import { MarketSub } from "./market/MarketHours";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./app.module.css";
import h from "./home/home.module.css";

export function strategyName(v: Pick<VaultSummary, "isCall">) {
  return v.isCall ? "Covered call" : "Cash-secured put";
}

/** Which protocol version's contracts a vault (or agent) belongs to, where a chain runs more than one. */
export function VersionTag({ version, label }: { version: string; label?: string }) {
  return (
    <span className={styles.version} data-version={version} title={`Strike ${version} contracts`}>
      {label ?? version}
    </span>
  );
}

type Row = { summary: VaultSummary; history: VaultHistory | null };

/** Newest protocol version first ("v3" before "v2"), keeping each deployment's own order inside. */
function byVersion(rows: Row[]): { version: string; rows: Row[] }[] {
  const groups: { version: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.version === r.summary.version);
    if (g) g.rows.push(r);
    else groups.push({ version: r.summary.version, rows: [r] });
  }
  const n = (v: string) => Number(v.replace(/^v/, "")) || 0;
  return groups.sort((a, b) => n(b.version) - n(a.version));
}

/* ================================================================ risk profile */

function useProfile() {
  const [hold, setHold] = useState<Hold>("all");
  const [upside, setUpside] = useState<Upside>("any");
  // A per-viewer convenience: remembered in this browser only, and the page works without it.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PROFILE_KEY) ?? "null") as {
        hold?: Hold;
        upside?: Upside;
      } | null;
      if (saved?.hold && ["all", "stock", "usdg"].includes(saved.hold)) setHold(saved.hold);
      if (saved?.upside && ["any", "some", "little"].includes(saved.upside)) setUpside(saved.upside);
    } catch {
      // storage blocked: start from "show all"
    }
  }, []);
  const save = (next: { hold: Hold; upside: Upside }) => {
    setHold(next.hold);
    setUpside(next.upside);
    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the answer lasts for this visit
    }
  };
  return { hold, upside, save };
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className={h.profileRow} role="group" aria-label={label}>
      <span className={h.profileQ} aria-hidden>
        {label}
      </span>
      <span className={h.seg}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={h.segBtn}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/* ================================================================ returning wallet */

function assetUsd(v: VaultSummary): number {
  return v.isCall ? toNumber(v.spot.price, 18) : 1;
}

/** A connected wallet with positions sees them first: value, premium to claim, and the way to the portfolio. */
function YourVaults({ rows }: { rows: Row[] }) {
  const { client, chainId } = useStrike();
  const { address } = useConnection();
  const q = useQuery({
    queryKey: ["strike", chainId, "home-positions", address, rows.map((r) => r.summary.address).join(",")],
    enabled: !!client && !!address && rows.length > 0,
    refetchInterval: 30_000,
    queryFn: () =>
      Promise.all(
        rows.map(async ({ summary: v }) => {
          const p = await position(client!, v.deployment, v, address!);
          const row = {
            shares: toNumber(p.shares, v.decimals),
            pendingPremium: toNumber(p.pendingPremium, v.usdg.decimals),
            queuedDeposit: toNumber(p.depositRequest.amount, v.asset.decimals),
            queuedRedeemShares: toNumber(p.redeemRequest.amount, v.decimals),
            claimableDepositShares: toNumber(p.claimableDepositShares, v.decimals),
            claimableRedeemAssets: toNumber(p.claimableRedeemAssets, v.asset.decimals),
            usd: toNumber(p.assets, v.asset.decimals) * assetUsd(v),
          };
          return row;
        }),
      ),
  });
  // Anything in the vault for this wallet: shares, premium to claim, or a request queued or ready to claim.
  const held = (q.data ?? []).filter(
    (p) =>
      p.shares > 0 ||
      p.pendingPremium > 0 ||
      p.queuedDeposit > 0 ||
      p.queuedRedeemShares > 0 ||
      p.claimableDepositShares > 0 ||
      p.claimableRedeemAssets > 0,
  );
  if (!address || held.length === 0) return null;
  const value = held.reduce((s, p) => s + p.usd, 0);
  const premium = held.reduce((s, p) => s + p.pendingPremium, 0);
  return (
    <section className={h.mine} aria-label="Your vaults" data-testid="home-portfolio">
      <div className={h.mineFigures}>
        <div className={h.mineFigure}>
          <span className="micro micro-muted">Your vaults</span>
          <span className={h.mineValue}>{held.length}</span>
        </div>
        <div className={h.mineFigure}>
          <span className="micro micro-muted">Deposits now</span>
          <span className={h.mineValue}>{fmtUsd(value, 2)}</span>
        </div>
        <div className={h.mineFigure}>
          <span className="micro micro-muted">Premium to claim</span>
          <span className={h.mineValue}>
            {premium.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG
          </span>
        </div>
      </div>
      <Link href="/app/portfolio" className="pill" data-testid="home-portfolio-link">
        Your portfolio: value, history and what needs you <ArrowRight size={14} aria-hidden />
      </Link>
    </section>
  );
}

/* ================================================================ the page */

const CHOICES = [
  {
    href: "#vault-list",
    title: "Earn on your stock tokens",
    note: "Pick a vault below, deposit, and collect the premium it earns each week.",
  },
  {
    href: "/app/playground",
    title: "Try it without a wallet",
    note: "Propose a strike and watch the contract accept it, or reject it and fine the agent.",
  },
  {
    href: SHOWCASE_DECISION,
    title: "See an AI decision",
    note: "Why an agent chose its strike, checked against the hash it put on-chain.",
  },
] as const;

/** The app's front door: what Strike is in one line, three ways in, and this week's vaults in plain words. */
export function VaultsPage() {
  const { meta, deployments } = useStrike();
  const vaults = useAllVaults();
  const market = useMarket();
  const { hold, upside, save } = useProfile();
  // Closed until asked for, so the list comes first; open when answers are already remembered.
  const [profileOpen, setProfileOpen] = useState(false);
  useEffect(() => {
    if (hold !== "all" || upside !== "any") setProfileOpen(true);
  }, [hold, upside]);
  const rows = vaults.data ?? [];
  // One group per deployment where the chain runs more than one (v3 and v2 on Robinhood Chain testnet).
  const multi = deployments.length > 1;
  const shown = rows.filter((r) => fitsProfile(r.summary, hold, upside));
  const groups = multi ? byVersion(shown) : [{ version: "", rows: shown }];
  const defaultVersion = deployments[0]?.version ?? "";
  const now = clockNow(market.data?.now);
  const purpose = tourPage("/app")?.purpose;
  const filtered = hold !== "all" || upside !== "any";

  const tvl = rows.reduce((s, r) => s + (r.summary.tvlUsd ?? 0), 0);
  // A series past expiry stays Selling on chain until it settles: counted apart, never as on sale.
  const live = rows.filter((r) => seriesPhase(r.summary, now) === "selling").length;
  const settling = rows.filter((r) => seriesPhase(r.summary, now) === "expired").length;
  const onSale = rows.filter(
    (r) =>
      seriesPhase(r.summary, now) === "selling" &&
      r.summary.series &&
      r.summary.series.sold < r.summary.series.size,
  ).length;
  const premium = rows.reduce(
    (s, r) => s + (r.history ? toNumber(r.history.premiumPaid, r.summary.usdg.decimals) : 0),
    0,
  );
  // Premium buyers have paid into live series: escrowed until settlement, so not in `premium` yet.
  const escrowed = rows.reduce(
    (s, r) =>
      s +
      (r.summary.state === 2 && r.summary.series
        ? toNumber(r.summary.series.premium, r.summary.usdg.decimals)
        : 0),
    0,
  );

  return (
    <>
      <header className={`theme-paper ${h.hero}`}>
        <div className="gutter">
          <SectionHead index="01" label="Vaults" right={meta.label} />
          <div className={h.heroGrid}>
            <h1 className={h.title}>Vaults that pay you every week</h1>
            <div className={h.lead}>
              {purpose ? (
                <p className={styles.heroPurpose} data-testid="page-purpose">
                  {purpose}
                </p>
              ) : null}
              <p className="body">
                Deposit a stock token or USDG. Each week the vault sells one option and pays you what the
                buyer paid. An AI agent picks the price, inside limits the contract enforces.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="gutter">
        <YourVaults rows={rows} />
        <nav aria-label="Start here">
          <ul className={h.choices}>
            {CHOICES.map((c, i) => (
              <li key={c.href}>
                <Link
                  href={c.href}
                  className={h.choice}
                  data-primary={i === 0 || undefined}
                  data-testid="home-choice"
                >
                  <span className={h.choiceStep}>{String(i + 1).padStart(2, "0")}</span>
                  <span className={h.choiceTitle}>
                    {c.title}{" "}
                    {c.href.startsWith("#") ? <ArrowRight aria-hidden /> : <ArrowUpRight aria-hidden />}
                  </span>
                  <span className={h.choiceNote}>{c.note}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className={h.firstRun}>
          First time with a wallet?{" "}
          <Link href="/app/faucet#start" className="text-link" data-testid="home-get-started">
            Get started: connect, free gas and 10 test USDG, then a vault
          </Link>
        </p>
      </div>

      <section id="vault-list" className={`gutter ${h.listSection}`} aria-labelledby="vault-list-title">
        <div className={h.listHead}>
          <h2 id="vault-list-title" className={h.listTitle}>
            This week&apos;s vaults
          </h2>
          <span className="micro micro-muted">Tap a vault for its option, the rules and the proof</span>
        </div>

        <details
          className={h.profile}
          data-testid="risk-profile"
          open={profileOpen}
          onToggle={(e) => setProfileOpen(e.currentTarget.open)}
        >
          <summary className={h.profileSummary}>
            <span>
              {filtered
                ? `Showing ${shown.length} of ${rows.length} vaults that fit your answers`
                : "Find the vaults that fit you: two optional questions"}
            </span>
            <ChevronDown size={15} aria-hidden />
          </summary>
          <Seg<Hold>
            label="What do you hold?"
            value={hold}
            onChange={(v) => save({ hold: v, upside })}
            options={[
              { value: "all", label: "Show all" },
              { value: "stock", label: "Stock tokens" },
              { value: "usdg", label: "USDG" },
            ]}
          />
          <Seg<Upside>
            label={
              hold === "usdg"
                ? "How much chance of buying the stock will you take?"
                : "How much upside will you give up?"
            }
            value={upside}
            onChange={(v) => save({ hold, upside: v })}
            options={[
              { value: "any", label: "Any" },
              { value: "some", label: "Some (delta ≤ 0.35)" },
              { value: "little", label: "Little (delta ≤ 0.25)" },
            ]}
          />
          <p className={h.profileFoot} aria-live="polite">
            <span data-testid="risk-profile-count">
              {filtered
                ? `${shown.length} of ${rows.length} vaults fit, by each vault's on-chain limit`
                : "Skip it to see every vault. The answers are matched to each vault's limits on chain."}
            </span>
            {filtered ? (
              <button
                type="button"
                className={h.linkBtn}
                onClick={() => save({ hold: "all", upside: "any" })}
              >
                Show all
              </button>
            ) : null}
          </p>
        </details>

        <Gate isLoading={vaults.isLoading} error={vaults.error} loading={<ListSkeleton />}>
          <div className={h.rows}>
            {rows.length === 0 ? (
              <p className="body">No vaults on this network yet.</p>
            ) : shown.length === 0 ? (
              <div className={h.empty} data-testid="risk-profile-empty">
                <p className="body">No vault on {meta.label} has limits that strict yet.</p>
                <button
                  type="button"
                  className={h.linkBtn}
                  onClick={() => save({ hold: "all", upside: "any" })}
                >
                  Show every vault
                </button>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.version || "all"} className={h.group} data-version={g.version || undefined}>
                  {multi ? (
                    <p className={`micro micro-muted ${h.groupHead}`}>
                      <VersionTag version={g.version} />
                      <span>
                        {g.rows.length} vault{g.rows.length === 1 ? "" : "s"}
                        {g.version === defaultVersion
                          ? " · the network's default deployment"
                          : ` · deployed next to ${defaultVersion}`}
                      </span>
                    </p>
                  ) : null}
                  {g.rows.map((r) => (
                    <VaultRow
                      key={r.summary.address}
                      vault={r.summary}
                      history={r.history}
                      showVersion={multi}
                      now={now}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </Gate>
      </section>

      {rows.length > 0 ? (
        <div className={h.figures}>
          <p className={`gutter micro micro-muted ${h.figuresHead}`}>Across every vault on {meta.label}</p>
          <MetaStrip
            cells={[
              {
                label: "Value locked",
                value: fmtUsd(tvl),
                sub: `${rows.length} vault${rows.length === 1 ? "" : "s"}`,
              },
              {
                label: "Live series",
                term: "series",
                value: String(live),
                sub: [
                  onSale === live ? "options on sale now" : `${onSale} with options left to buy`,
                  settling ? `${settling} expired, waiting for settlement` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              },
              {
                label: "Premium to depositors",
                term: "premium",
                value: fmtUsd(premium),
                sub:
                  escrowed > 0
                    ? `settled · ${escrowed.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG more in live series`
                    : "settled epochs, USDG",
              },
              {
                label: "US market",
                value: market.data ? (market.data.open ? "Open" : "Closed") : "—",
                sub: market.data ? <MarketSub market={market.data} /> : "NYSE hours",
              },
            ]}
          />
        </div>
      ) : null}
    </>
  );
}

/** This week in plain words, from the chain: what the vault is selling, or why it is not selling. */
export function weekStatus(v: VaultSummary, now: number): { main: string; sub: string } {
  const s = v.series;
  const phase = seriesPhase(v, now);
  if (phase === "selling" && s) {
    const kind = s.isCall ? "call" : "put";
    return {
      main: `Selling a ${fmtWadUsd(s.strike)} ${kind}`,
      sub: s.sold < s.size ? `On sale until ${fmtNy(s.expiry)}` : `Sold out · expires ${fmtNy(s.expiry)}`,
    };
  }
  if (phase === "expired" && s) {
    return {
      main: "Expired, waiting for settlement",
      sub: `${fmtWadUsd(s.strike)} ${s.isCall ? "call" : "put"} · expired ${fmtNy(s.expiry)}`,
    };
  }
  if (phase === "open") {
    return {
      main: "Waiting for the agent's strike",
      sub: "The agent proposes; the contract checks it against the vault's limits",
    };
  }
  return {
    main: "Between weeks",
    sub: "Deposits go in now; the next option is listed when a week opens (Mondays)",
  };
}

function VaultRow({
  vault,
  history,
  showVersion,
  now,
}: {
  vault: VaultSummary;
  history: VaultHistory | null;
  showVersion: boolean;
  now: number;
}) {
  const s = vault.series;
  const phase = seriesPhase(vault, now);
  const week = weekStatus(vault, now);
  const weekPremium =
    s && (phase === "selling" || phase === "expired") ? toNumber(s.premium, vault.usdg.decimals) : null;
  return (
    <Link
      href={`/app/vault/${vault.address}`}
      className={h.row}
      data-tone={vault.isCall ? "call" : "put"}
      aria-label={`${vault.underlying.symbol} ${strategyName(vault)} vault ${vault.symbol}, agent #${vault.agentId}${showVersion && vault.version ? ` (${vault.version})` : ""}`}
      data-version={vault.version || undefined}
      data-testid="vault-row"
    >
      <span className={h.name}>
        <span className={h.nameTop}>
          <span className={h.ticker}>{vault.underlying.symbol}</span>
          <span className={styles.kind} data-tone={vault.isCall ? "call" : "put"}>
            {strategyName(vault)}
          </span>
          {showVersion && vault.version ? <VersionTag version={vault.version} /> : null}
        </span>
        <span className={h.plain}>
          {vault.isCall
            ? `Earn on ${vault.underlying.symbol} you hold`
            : `Earn on USDG; you may buy ${vault.underlying.symbol} below the strike`}
        </span>
        <span className={h.expert}>
          <span data-testid="vault-row-meta">
            {vault.symbol} · agent #{vault.agentId.toString()}
          </span>{" "}
          ·{" "}
          <span data-testid="vault-row-mandate">
            Mandate: delta {fmtDelta(vault.mandate.minDeltaBps)}–{fmtDelta(vault.mandate.maxDeltaBps)} ·
            premium ≥ {fmtBps(vault.mandate.minPremiumBps)} of fair · sells ≤{" "}
            {fmtBps(vault.mandate.maxShareSoldBps)}
          </span>
        </span>
      </span>
      <span className={h.cell} data-label="This week">
        <span className={h.cellMain}>
          <StateTag state={vault.state} expired={phase === "expired"} />
        </span>
        <span className={h.cellMain} data-testid="vault-row-week">
          {week.main}
        </span>
        <span className={h.cellSub}>{week.sub}</span>
        <span className={h.cap} data-testid="vault-row-cap">
          <ShieldCheck size={14} aria-hidden />
          Its contract can never sell above {fmtDelta(vault.mandate.maxDeltaBps)} delta
        </span>
      </span>
      <span className={`${h.cell} ${h.right}`} data-label="Premium APY">
        {history && history.apy !== null ? (
          <>
            <span className={h.premium}>{fmtPct(history.apy)}</span>
            <span className={h.cellSub}>a year, trailing</span>
          </>
        ) : weekPremium === 0 && phase === "selling" ? (
          <>
            <span className={h.cellMain}>None sold yet</span>
            <span className={h.cellSub}>options on sale · APY after the first settlement</span>
          </>
        ) : weekPremium !== null ? (
          <>
            <span className={h.premium}>
              {weekPremium.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG
            </span>
            <span className={h.cellSub}>premium this week · APY after the first settlement</span>
          </>
        ) : (
          <>
            <span className={h.cellMain}>APY after the first settlement</span>
            <span className={h.cellSub}>trailing, from settled weeks</span>
          </>
        )}
      </span>
      <span className={h.arrow} aria-hidden>
        <ArrowUpRight size={18} strokeWidth={1.4} />
      </span>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className={h.rows} aria-busy="true" aria-label="Loading vaults">
      {[0, 1].map((i) => (
        <div key={i} className={h.row}>
          <span className={h.name}>
            <Skeleton width="5em" />
          </span>
          <span className={h.cell}>
            <Skeleton width="9em" />
          </span>
          <span className={h.cell}>
            <Skeleton width="4.5em" />
          </span>
          <span className={h.arrow} aria-hidden />
        </div>
      ))}
    </div>
  );
}
