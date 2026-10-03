"use client";

import { useQuery } from "@tanstack/react-query";
import { strikeVaultAbi, epochManagerAbi } from "@strike/sdk";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useConnection } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { CHAIN_META, explorerUrl, isAppChainId, type AppChainId } from "@/lib/chains";
import type {
  ActivityRow,
  AgentView,
  EpochResult,
  OptionPosition,
  VaultPosition,
} from "@/lib/portfolioLedger";
import type { ActionItem, Opportunity, PortfolioJson } from "@/lib/portfolioView";
import { TEAM_WALLETS, isTeamWallet } from "@/lib/usage/team";
import { MetaStrip, MetaStripSkeleton } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import { TableWrap } from "../TableWrap";
import styles from "../app.module.css";
import own from "./portfolio.module.css";
import { EpochBars } from "./EpochBars";
import { ValueChart, money } from "./ValueChart";

/** Team wallets offered as examples: a QA test wallet (deposit and withdrawal) and the deployer (epochs, options, an agent). */
export const EXAMPLE_WALLETS = [
  { address: "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044", label: "Team QA test wallet 1" },
  { address: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff", label: "Team deployer wallet" },
] as const;

const amt = (x: number, frac = 4) =>
  x.toLocaleString("en-US", { maximumFractionDigits: x !== 0 && Math.abs(x) < 0.01 ? 6 : frac });
const pct = (x: number | null, frac = 1) =>
  x === null || !Number.isFinite(x)
    ? "—"
    : `${(x * 100).toLocaleString("en-US", { maximumFractionDigits: frac })}%`;
const signed = (x: number) => `${x > 0 ? "+" : ""}${money(x)}`;
const tone = (x: number) => (x > 0.005 ? own.gain : x < -0.005 ? own.loss : undefined);
const utc = (t: number | null) =>
  t === null ? "—" : `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const dayUtc = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
const chainLabel = (id: number) => (isAppChainId(id) ? CHAIN_META[id].label : String(id));
const where = (p: { chainId: number; version: string }) => `${chainLabel(p.chainId)} ${p.version}`;

function TxLink({ chainId, hash, children }: { chainId: number; hash: string | null; children?: ReactNode }) {
  if (!hash) return <span className={styles.cellMuted}>—</span>;
  const url = isAppChainId(chainId) ? explorerUrl(chainId, "tx", hash) : null;
  const text = children ?? `${hash.slice(0, 8)}…${hash.slice(-4)}`;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="mono text-link">
      {text}
    </a>
  ) : (
    <span className="mono">{text}</span>
  );
}

const vaultHref = (p: { vault: string; chainId: number }) =>
  `/app/vault/${getAddress(p.vault)}?chain=${p.chainId}`;

async function fetchPortfolio(address: string, devnet: boolean): Promise<PortfolioJson> {
  const res = await fetch(`/api/portfolio?address=${address}${devnet ? "&chain=31337" : ""}`);
  const body = (await res.json().catch(() => null)) as (PortfolioJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** One wallet across every Strike deployment: the connected one, or any address typed in (read-only). */
export function PortfolioPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { address: connected } = useConnection();
  // The local devnet is read too when the app is on it (a developer's own chain); the testnets always are.
  const devnet = useStrike().chainId === 31337;
  const param = params.get("address");
  const typed = param && isAddress(param, { strict: false }) ? getAddress(param) : null;
  const viewing: Address | null = typed ?? connected ?? null;
  const q = useQuery({
    queryKey: ["portfolio", viewing?.toLowerCase(), devnet],
    enabled: !!viewing,
    queryFn: () => fetchPortfolio(viewing!, devnet),
    staleTime: 20_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const go = (address: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (address) next.set("address", address);
    else next.delete("address");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const canAct = !!connected && !!viewing && connected.toLowerCase() === viewing.toLowerCase();

  return (
    <>
      <PageHero
        label="Portfolio"
        right="Every network"
        title="Portfolio"
        lead={
          <>
            <p className="lead">
              Your positions, profit and loss, premium and options across every Strike vault on Robinhood
              Chain testnet and Arbitrum Sepolia, rebuilt from the chain. Look up any address read-only.
            </p>
            <AddressBar
              current={viewing}
              connected={connected ?? null}
              bad={param !== null && !typed ? param : null}
              onView={go}
            />
          </>
        }
      />
      {!viewing ? (
        <NoWallet onExample={go} />
      ) : q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <section className={`gutter ${styles.empty}`} role="alert" data-testid="portfolio-error">
          <h2 className={`display-h2 ${styles.emptyTitle}`}>Couldn&apos;t read this portfolio.</h2>
          <p className="body">{q.error instanceof Error ? q.error.message : "Unexpected error"}</p>
          <p className="body">The public test-network RPCs are sometimes busy for a moment.</p>
          <div className={styles.emptyActions}>
            <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
              Try again
            </button>
          </div>
        </section>
      ) : (
        <Dashboard p={q.data} canAct={canAct} onExample={go} refetch={() => q.refetch()} typed={!!typed} />
      )}
    </>
  );
}

function AddressBar({
  current,
  connected,
  bad,
  onView,
}: {
  current: string | null;
  connected: string | null;
  bad: string | null;
  onView: (a: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (!isAddress(v, { strict: false })) return setErr("That is not an address: 0x and 40 hex characters.");
    setErr(null);
    onView(getAddress(v));
  }
  return (
    <form
      className={own.addressBar}
      onSubmit={submit}
      aria-label="Look up an address"
      data-testid="portfolio-lookup"
    >
      <label htmlFor="portfolio-address" className="sr-only">
        Address to view
      </label>
      <input
        id="portfolio-address"
        placeholder={current ?? "0x… any address, read-only"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        inputMode="text"
      />
      <button type="submit" className="pill pill-small">
        View
      </button>
      {connected && current && connected.toLowerCase() !== current.toLowerCase() ? (
        <button type="button" className="pill pill-small pill-ghost" onClick={() => onView(null)}>
          My wallet
        </button>
      ) : null}
      {err || bad ? (
        <p className={styles.hint} role="alert">
          {err ?? `"${bad}" is not an address.`}
        </p>
      ) : null}
    </form>
  );
}

function Loading() {
  return (
    <div data-testid="portfolio-loading" aria-busy="true">
      <MetaStripSkeleton
        labels={["Value now", "Deposited", "Withdrawn", "Net P&L", "Premium earned", "Realised"]}
      />
      <div className={styles.detailBody}>
        <Rail index="01" label="Performance" note="Reading every deployment's logs and today's state…">
          <Skeleton width="100%" />
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </Rail>
      </div>
    </div>
  );
}

function ExampleButtons({ onExample }: { onExample: (a: string) => void }) {
  return (
    <>
      {EXAMPLE_WALLETS.map((w) => (
        <button
          key={w.address}
          type="button"
          className="pill pill-small pill-ghost"
          onClick={() => onExample(w.address)}
          data-testid="portfolio-example"
        >
          View an example: {w.label}
        </button>
      ))}
    </>
  );
}

function WhatYouSee() {
  return (
    <ul className={own.steps}>
      <li>What your positions are worth now, what you put in and took out, and your profit or loss.</li>
      <li>A chart of your value over time, and the result of every week you were in.</li>
      <li>
        Each vault&apos;s live series: your part of what is at risk, the break-even and the model&apos;s odds.
      </li>
      <li>Options you bought, what they pay at expiry, and what is waiting to be claimed or redeemed.</li>
    </ul>
  );
}

function NoWallet({ onExample }: { onExample: (a: string) => void }) {
  return (
    <div className={`gutter ${styles.prompt} ${own.prompt}`} data-testid="portfolio-connect">
      <p className="h3">Connect a wallet, or look up any address above.</p>
      <p className="body">Once there is a wallet to read, this page shows:</p>
      <WhatYouSee />
      <p className="body">
        It reads the chain: each vault&apos;s events and <code className="mono">balanceOf</code>,{" "}
        <code className="mono">pendingPremium</code> and queued requests, and the option token&apos;s
        balances. It sends nothing.
      </p>
      <div className={styles.emptyActions}>
        <ExampleButtons onExample={onExample} />
      </div>
    </div>
  );
}

function Dashboard({
  p,
  canAct,
  onExample,
  refetch,
  typed,
}: {
  p: PortfolioJson;
  canAct: boolean;
  onExample: (a: string) => void;
  refetch: () => void;
  typed: boolean;
}) {
  const t = p.totals;
  const team = isTeamWallet(p.address)
    ? TEAM_WALLETS.find((w) => w.address.toLowerCase() === p.address.toLowerCase())
    : null;
  const failed = p.chains.filter((c) => !c.ok);
  let n = 0;
  const idx = () => String(++n).padStart(2, "0");
  return (
    <div data-testid="portfolio" data-empty={p.empty || undefined}>
      <div className={`gutter ${own.viewing}`} data-testid="portfolio-viewing">
        <span>{canAct ? "Your wallet" : typed ? "Viewing, read-only" : "Viewing"}</span>
        <strong>{p.address}</strong>
        {team ? (
          <span className={own.badge} data-testid="team-wallet">
            Team test wallet: {team.short}
          </span>
        ) : null}
        <a
          className="pill pill-small pill-ghost"
          href={`/api/statement?address=${p.address}&format=csv`}
          download
          data-testid="statement-csv"
        >
          Download statement (CSV)
        </a>
        <a
          className="text-link"
          href={`/api/statement?address=${p.address}&format=json`}
          target="_blank"
          rel="noreferrer"
        >
          JSON
        </a>
      </div>
      {failed.length ? (
        <p className={`gutter ${styles.hint}`} role="alert" data-testid="portfolio-partial">
          Not read this time: {failed.map((c) => `${c.label} ${c.key.split("-")[1]} (${c.error})`).join("; ")}
          . The figures below leave it out.
        </p>
      ) : null}
      {p.empty ? (
        <EmptyState p={p} onExample={onExample} />
      ) : (
        <>
          <div className={own.figures}>
            <MetaStrip
              cells={[
                {
                  label: "Value now",
                  value: money(t.valueUsd),
                  sub: `${t.vaults} vault${t.vaults === 1 ? "" : "s"}, at oracle prices`,
                },
                { label: "Deposited", value: money(t.depositedUsd), sub: "USD at each deposit's price" },
                {
                  label: "Withdrawn",
                  value: money(t.withdrawnUsd),
                  sub: `plus ${money(t.premiumClaimed)} premium claimed`,
                },
                {
                  label: "Net P&L",
                  value: <span className={tone(t.pnlUsd)}>{signed(t.pnlUsd)}</span>,
                  sub: `${t.pnlPct === null ? "—" : `${t.pnlPct >= 0 ? "+" : ""}${pct(t.pnlPct, 2)}`} of deposits`,
                },
                {
                  label: "Premium earned",
                  term: "premium",
                  value: `${amt(t.premiumEarned, 4)} USDG`,
                  sub: `${amt(t.premiumPending, 4)} to claim`,
                },
                {
                  label: "Realised",
                  value: <span className={tone(t.realisedUsd)}>{signed(t.realisedUsd)}</span>,
                  sub: (
                    <>
                      unrealised <span className={tone(t.unrealisedUsd)}>{signed(t.unrealisedUsd)}</span>
                    </>
                  ),
                },
              ]}
            />
          </div>
          <div className={styles.detailBody}>
            {p.actions.length ? (
              <Rail
                index={idx()}
                id="actions"
                label="Needs your action"
                note="Derived from the wallet's state on every read, so it is never stale. Buttons send the transaction from the connected wallet."
              >
                <Actions items={p.actions} canAct={canAct} address={p.address} refetch={refetch} />
              </Rail>
            ) : null}
            <Rail
              index={idx()}
              id="performance"
              label="Performance"
              note="Net P&L = value now + withdrawn + premium claimed − deposited. Realised: withdrawals' gains over their cost and all premium credited; unrealised: what is still held over its cost."
            >
              {p.chart.length > 1 ? (
                <ValueChart points={p.chart} markers={p.markers} now={p.now} />
              ) : (
                <p className={styles.hint}>Not enough history for a chart yet.</p>
              )}
              <Allocation p={p} />
            </Rail>
            <Rail
              index={idx()}
              id="positions"
              label="Positions"
              note="Per vault: shares, value at the oracle spot, cost, P&L and premium; the live series' exposure for your share; queued requests."
            >
              <Positions positions={p.positions} now={p.now} />
            </Rail>
            <Rail
              index={idx()}
              id="epochs"
              label="Epoch by epoch"
              note="Each epoch the wallet was in: premium credited to it, its part of the settlement payout, and the net, with the transactions."
            >
              <EpochBars epochs={p.epochs} />
              <Epochs epochs={p.epochs} />
            </Rail>
            {p.opportunities.length ? (
              <Rail
                index={idx()}
                id="what-you-can-do"
                label="What you can do with what you hold"
                note="The wallet's idle stock tokens and USDG next to the vaults that take them, with this week's series numbers."
              >
                <Opportunities items={p.opportunities} />
              </Rail>
            ) : null}
            <Rail
              index={idx()}
              id="options"
              label="Options"
              note="Strike options (ERC-1155) this wallet holds or traded: what they pay at expiry, how they settled, what is left to redeem."
            >
              <Options options={p.options} totals={p.optionTotals} />
            </Rail>
            {p.agents.length ? (
              <Rail
                index={idx()}
                id="agent"
                label="Agent operator"
                note="This wallet owns, signs for or is paid by a registered agent."
              >
                <Agents agents={p.agents} />
              </Rail>
            ) : null}
            <Rail
              index={idx()}
              id="activity"
              label="Activity"
              note="Every action of the wallet, newest first, each with its transaction."
            >
              <Activity rows={p.activity} />
            </Rail>
            <Rail index={idx()} id="method" label="How this is computed">
              <Method p={p} />
            </Rail>
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================ empty state */

function EmptyState({ p, onExample }: { p: PortfolioJson; onExample: (a: string) => void }) {
  return (
    <>
      <section className={`gutter ${styles.prompt} ${own.prompt}`} data-testid="portfolio-empty">
        <p className="h3">Nothing in Strike for this wallet yet.</p>
        <p className="body">
          No vault shares, premium, queued requests, options or agent on any of the three deployments. With a
          position, this page shows:
        </p>
        <WhatYouSee />
        <p className="body">Get started in two steps:</p>
        <ol className={own.steps}>
          <li>
            <Link href="/app/faucet" className="text-link">
              Get test tokens
            </Link>{" "}
            (gas, USDG and test stock tokens).
          </li>
          <li>
            <Link href="/app" className="text-link">
              Pick a vault and deposit
            </Link>
            : a covered call for stock tokens, a cash-secured put for USDG.
          </li>
        </ol>
        <div className={styles.emptyActions}>
          <Link href="/app/faucet" className="pill pill-small">
            Get started
          </Link>
          <ExampleButtons onExample={onExample} />
        </div>
      </section>
      {p.opportunities.length ? (
        <div className={styles.detailBody}>
          <Rail
            index="01"
            id="what-you-can-do"
            label="What you can do with what you hold"
            note="This wallet's stock tokens and USDG next to the vaults that take them, with this week's series numbers."
          >
            <Opportunities items={p.opportunities} />
          </Rail>
        </div>
      ) : null}
    </>
  );
}

/* ================================================================ actions */

function Actions({
  items,
  canAct,
  address,
  refetch,
}: {
  items: ActionItem[];
  canAct: boolean;
  address: string;
  refetch: () => void;
}) {
  return (
    <ul className={own.actions} data-testid="portfolio-actions">
      {items.map((a) => (
        <li
          key={a.id}
          className={own.action}
          data-tx={a.tx}
          data-kind={a.kind}
          data-testid="portfolio-action"
        >
          <div>
            <div className={own.actionTitle}>{a.title}</div>
            <div className={own.actionDetail}>
              {a.detail} <span className={styles.cellMuted}>{where(a)}</span>
            </div>
          </div>
          <div className={own.actionCtl}>
            {a.tx ? (
              canAct ? (
                <ActionButton item={a} account={address as Address} onDone={refetch} />
              ) : (
                <span className={styles.cellMuted}>Connect this wallet to act</span>
              )
            ) : a.link ? (
              <TxLink chainId={a.chainId} hash={a.link}>
                Transaction
              </TxLink>
            ) : (
              <Link href={vaultHref(a)} className="text-link">
                Vault
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "claim-premium": "Claim premium",
  "claim-deposit": "Claim shares",
  "claim-redeem": "Claim withdrawal",
  "redeem-option": "Redeem",
};

function ActionButton({ item, account, onDone }: { item: ActionItem; account: Address; onDone: () => void }) {
  const { chainId, setChainId } = useStrike();
  const tx = useTx();
  if (item.chainId !== chainId)
    return (
      <button
        type="button"
        className="pill pill-small"
        onClick={() => setChainId(item.chainId as AppChainId)}
      >
        Switch to {chainLabel(item.chainId)}
      </button>
    );
  const v = { address: getAddress(item.vault), abi: strikeVaultAbi } as const;
  const label = ACTION_LABEL[item.kind] ?? "Send";
  const run = () =>
    tx
      .exec(label, (w) => {
        if (item.kind === "claim-premium") return w({ ...v, functionName: "claimPremium" });
        if (item.kind === "claim-deposit") return w({ ...v, functionName: "claimDeposit", args: [account] });
        if (item.kind === "claim-redeem") return w({ ...v, functionName: "claimRedeem", args: [account] });
        return w({
          address: getAddress(item.manager!),
          abi: epochManagerAbi,
          functionName: "redeem",
          args: [BigInt(item.seriesId!), BigInt(item.amountRaw!), account],
        });
      })
      .then((ok) => {
        if (ok) setTimeout(onDone, 2_000);
      });
  return (
    <>
      <button type="button" className="pill pill-small" disabled={tx.busy} onClick={run}>
        {tx.busy ? (tx.phase === "wallet" ? "Confirm in wallet…" : "Sending…") : label}
      </button>
      {tx.phase === "done" && tx.hash ? (
        <TxLink chainId={item.chainId} hash={tx.hash}>
          Done: transaction
        </TxLink>
      ) : null}
      {tx.phase === "error" ? <span role="alert">{tx.error}</span> : null}
    </>
  );
}

/* ================================================================ allocation */

function Allocation({ p }: { p: PortfolioJson }) {
  const { byUnderlying, byChain } = p.allocation;
  if (!byUnderlying.length) return null;
  const total = byUnderlying.reduce((s, x) => s + x.usd, 0);
  const list = (title: string, rows: { key: string; usd: number }[]) => (
    <div>
      <h3 className="micro">{title}</h3>
      <ul className={own.allocList}>
        {rows.map((r) => (
          <li key={r.key} className={own.allocRow}>
            <span>{r.key}</span>
            <span className="mono">
              {money(r.usd)} · {pct(total > 0 ? r.usd / total : null, 0)}
            </span>
            <span className={own.allocBar} aria-hidden>
              <span style={{ width: `${total > 0 ? (r.usd / total) * 100 : 0}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className={own.alloc} data-testid="allocation">
      {list("By underlying and strategy", byUnderlying)}
      {list("By network and deployment", byChain)}
    </div>
  );
}

/* ================================================================ positions */

function ExposureCell({ p, now }: { p: VaultPosition; now: number }) {
  const e = p.exposure;
  if (!e) return <span className={styles.cellMuted}>no live series</span>;
  if (e.phase === "expired")
    return (
      <span data-testid="exposure-settling">
        Expired, settling: expired {utc(e.expiry)}, settles at the first price print at or after expiry.
        Strike {money(e.strike)}
        {e.optionsSold > 0 ? `; ${amt(e.optionsSold)} options of your share sold` : "; nothing sold"}.
      </span>
    );
  if (e.optionsSold === 0)
    return (
      <span>
        Selling at {money(e.strike)} until {utc(e.expiry)}; none sold yet, so nothing at risk.
      </span>
    );
  return (
    <span data-testid="exposure-live">
      Strike {money(e.strike)}, expires {utc(e.expiry)} ({Math.max(0, Math.round((e.expiry - now) / 3600))}{" "}
      h). Your {pct(e.shareOfVault)} of the vault: {amt(e.optionsSold)} options sold, {amt(e.premiumShare, 4)}{" "}
      USDG premium. Most it can pay out: {money(e.collateralAtRiskUsd)} ({amt(e.collateralAtRisk)}{" "}
      {p.assetSymbol}
      {p.isCall ? " at the strike" : ""}). Break-even {e.breakEven === null ? "—" : money(e.breakEven)}, spot{" "}
      {money(e.spot)}.{" "}
      <span className={styles.cellMuted}>
        Model odds: {pct(e.modelProbItm)} it ends in the money, {pct(e.modelProbLoss)} past break-even.
      </span>
    </span>
  );
}

function Positions({ positions, now }: { positions: VaultPosition[]; now: number }) {
  if (!positions.length) return <p className={styles.hint}>No vault positions.</p>;
  return (
    <TableWrap stack>
      <table className={styles.table} aria-label="Vault positions">
        <thead>
          <tr>
            <th scope="col">Vault</th>
            <th scope="col" className={styles.num}>
              Shares
            </th>
            <th scope="col" className={styles.num}>
              Value
            </th>
            <th scope="col" className={styles.num}>
              Cost basis
            </th>
            <th scope="col" className={styles.num}>
              P&amp;L
            </th>
            <th scope="col" className={styles.num}>
              Premium
            </th>
            <th scope="col">This epoch</th>
            <th scope="col">Queued or claimable</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={`${p.deployment}-${p.vault}`} data-testid="portfolio-position">
              <th scope="row">
                <Link href={vaultHref(p)} className="text-link">
                  {p.symbol} ({p.version})
                </Link>
                <span className={styles.cellMuted}>
                  {p.underlying} {p.isCall ? "covered call" : "cash-secured put"}, {chainLabel(p.chainId)}
                </span>
              </th>
              <td className={`mono ${styles.num}`}>{amt(p.shares)}</td>
              <td className={`mono ${styles.num}`}>
                <span className={own.nowrap}>{money(p.valueUsd)}</span>
                <span className={styles.cellMuted}>
                  {amt(p.valueAssets)} {p.assetSymbol}
                </span>
              </td>
              <td className={`mono ${styles.num}`}>
                <span className={own.nowrap}>{money(p.costBasisUsd)}</span>
                <span className={styles.cellMuted}>
                  in {money(p.depositedUsd)}, out {money(p.withdrawnUsd)}
                </span>
              </td>
              <td className={`mono ${styles.num}`}>
                <span className={`${own.nowrap} ${tone(p.pnlUsd) ?? ""}`}>{signed(p.pnlUsd)}</span>
                <span className={styles.cellMuted}>
                  {p.pnlAssets >= 0 ? "+" : ""}
                  {amt(p.pnlAssets)} {p.assetSymbol} before premium
                </span>
              </td>
              <td className={`mono ${styles.num}`}>
                <span className={own.nowrap}>{amt(p.premiumEarned, 4)} USDG</span>
                <span className={styles.cellMuted}>{amt(p.pendingPremium, 4)} to claim</span>
              </td>
              <td>
                <ExposureCell p={p} now={now} />
              </td>
              <td>
                <Requests p={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Requests({ p }: { p: VaultPosition }) {
  const parts: string[] = [];
  if (p.queuedDeposit > 0) parts.push(`deposit of ${amt(p.queuedDeposit)} ${p.assetSymbol} queued`);
  if (p.queuedRedeemShares > 0) parts.push(`${amt(p.queuedRedeemShares)} shares queued to withdraw`);
  if (p.claimableDepositShares > 0) parts.push(`${amt(p.claimableDepositShares)} shares to claim`);
  if (p.claimableRedeemAssets > 0) parts.push(`${amt(p.claimableRedeemAssets)} ${p.assetSymbol} to claim`);
  return parts.length ? <>{parts.join(" · ")}</> : <span className={styles.cellMuted}>none</span>;
}

/* ================================================================ epochs */

const STATUS: Record<EpochResult["status"], string> = {
  settled: "Settled",
  "settled-unsold": "Closed, nothing sold",
  aborted: "Aborted: slashed bond paid in",
  cancelled: "Cancelled, premium refunded to buyers",
  running: "Running",
  open: "Open, waiting for a proposal",
  "expired-settling": "Expired, settling",
};

function Epochs({ epochs }: { epochs: EpochResult[] }) {
  if (!epochs.length) return <p className={styles.hint}>This wallet has not been in an epoch yet.</p>;
  return (
    <TableWrap stack>
      <table className={styles.table} aria-label="Epoch results">
        <thead>
          <tr>
            <th scope="col">Vault and epoch</th>
            <th scope="col">Status</th>
            <th scope="col" className={styles.num}>
              Strike, settlement
            </th>
            <th scope="col" className={styles.num}>
              Your share
            </th>
            <th scope="col" className={styles.num}>
              Premium
            </th>
            <th scope="col" className={styles.num}>
              Payout
            </th>
            <th scope="col" className={styles.num}>
              Net
            </th>
            <th scope="col">Transactions</th>
          </tr>
        </thead>
        <tbody>
          {epochs.map((e) => (
            <tr
              key={`${e.deployment}-${e.vault}-${e.epoch}`}
              data-testid="portfolio-epoch"
              data-status={e.status}
            >
              <th scope="row">
                <Link href={vaultHref(e)} className="text-link">
                  {e.symbol} ({e.version}) #{e.epoch}
                </Link>
                <span className={styles.cellMuted}>
                  {chainLabel(e.chainId)},{" "}
                  {e.closedAt ? `closed ${utc(e.closedAt)}` : `opened ${utc(e.openedAt)}`}
                </span>
              </th>
              <td>{STATUS[e.status]}</td>
              <td className={`mono ${styles.num}`}>
                <span className={own.nowrap}>{e.strike === null ? "—" : money(e.strike)}</span>
                <span className={styles.cellMuted}>
                  {e.settlementPrice !== null
                    ? `settled ${money(e.settlementPrice)}`
                    : e.expiry
                      ? `expiry ${utc(e.expiry)}`
                      : ""}
                </span>
              </td>
              <td className={`mono ${styles.num}`}>{pct(e.shareOfVault, 2)}</td>
              <td className={`mono ${styles.num}`}>
                {e.premium === null ? "pending" : `${amt(e.premium, 6)} USDG`}
              </td>
              <td className={`mono ${styles.num}`}>
                {e.payoutAssets === null ? "pending" : `${amt(e.payoutAssets, 6)} ${e.assetSymbol}`}
                {e.payoutUsd !== null && e.isCall ? (
                  <span className={styles.cellMuted}>{money(e.payoutUsd)}</span>
                ) : null}
              </td>
              <td className={`mono ${styles.num}`}>
                {e.net === null ? (
                  "—"
                ) : (
                  <span className={`${own.nowrap} ${tone(e.net) ?? ""}`}>{signed(e.net)}</span>
                )}
                {e.holdUsd !== null ? (
                  <span className={styles.cellMuted}>holding the tokens: {signed(e.holdUsd)}</span>
                ) : null}
              </td>
              <td>
                <TxLink chainId={e.chainId} hash={e.txOpened}>
                  open
                </TxLink>{" "}
                <TxLink chainId={e.chainId} hash={e.txProposed}>
                  proposal
                </TxLink>{" "}
                <TxLink chainId={e.chainId} hash={e.txClosed}>
                  close
                </TxLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/* ================================================================ what you can do */

function Opportunities({ items }: { items: Opportunity[] }) {
  return (
    <>
      <div className={own.cards} data-testid="portfolio-opportunities">
        {items.map((o) => (
          <article
            key={`${o.deployment}-${o.vault}-${o.asset}`}
            className={own.card}
            data-testid="portfolio-opportunity"
          >
            <h3>
              {amt(o.amount)} {o.asset} → {o.symbol} ({o.version})
            </h3>
            <span className={styles.cellMuted}>
              {o.underlying} {o.isCall ? "covered call" : "cash-secured put"}, {chainLabel(o.chainId)}
              {o.asset !== "USDG" ? `, ${money(o.usd)} at the oracle spot` : ""}
            </span>
            {o.strike !== null ? (
              <dl>
                <dt>This week</dt>
                <dd>{o.status === "expired" ? "expired, settling" : "selling"}</dd>
                <dt>Strike</dt>
                <dd>{money(o.strike)}</dd>
                <dt>Delta</dt>
                <dd>{o.delta === null ? "—" : o.delta.toFixed(2)}</dd>
                <dt>Expiry</dt>
                <dd>{o.expiry ? utc(o.expiry) : "—"}</dd>
                <dt>Premium per option</dt>
                <dd>{o.premiumPerOption === null ? "—" : money(o.premiumPerOption, 4)}</dd>
                <dt>On your size, sold out</dt>
                <dd>{o.premiumIfSoldOut === null ? "—" : `${amt(o.premiumIfSoldOut, 4)} USDG`}</dd>
                <dt>At sales so far</dt>
                <dd>{o.premiumAtSales === null ? "—" : `${amt(o.premiumAtSales, 4)} USDG`}</dd>
                <dt>Break-even</dt>
                <dd>{o.breakEven === null ? "—" : money(o.breakEven)}</dd>
              </dl>
            ) : (
              <p className={own.cardNote}>
                No live series
                {o.status === "open" ? ": the epoch is open and waiting for the agent's proposal" : ""}.
                {o.nextOpen
                  ? ` Epochs open and series sell in NYSE hours; the next session opens ${dayUtc(o.nextOpen)}.`
                  : " Epochs open and series sell in NYSE hours."}
              </p>
            )}
            <p className={own.cardNote}>
              {o.queued
                ? "The vault is locked: a deposit now is queued and joins when this epoch settles."
                : "The vault is unlocked: a deposit goes in now and is locked from the next epoch's open until it settles."}{" "}
              {o.maxDeltaBps !== null
                ? `Worst case under the mandate: the contract never sells above ${(o.maxDeltaBps / 10_000).toFixed(2)} delta or more than ${pct((o.maxShareSoldBps ?? 0) / 10_000, 0)} of the vault; ${o.isCall ? "above the strike your tokens' gain is paid to buyers" : "below the strike your USDG pays the strike minus the settlement price per option"}.`
                : ""}
            </p>
            <Link href={vaultHref(o)} className="text-link">
              Open the vault
            </Link>
          </article>
        ))}
      </div>
      <p className={styles.hint}>
        Premium figures use this week&apos;s series: what buyers paid per option sold (else the proposed
        price), on your size in options, scaled by how much of the vault the series sells. This week&apos;s
        price, not a promise for the next.
      </p>
    </>
  );
}

/* ================================================================ options */

const OPTION_STATE: Record<OptionPosition["state"], string> = {
  live: "Live",
  expired: "Expired, settling",
  paid: "Settled in the money",
  worthless: "Settled out of the money",
  cancelled: "Cancelled, premium refunded",
};

function Options({ options, totals }: { options: OptionPosition[]; totals: PortfolioJson["optionTotals"] }) {
  if (!options.length)
    return (
      <p className={styles.hint} data-testid="portfolio-no-options">
        This wallet holds no Strike options and has not traded any.
      </p>
    );
  return (
    <>
      <p className="body" data-testid="option-totals">
        {totals.series} series: {money(totals.premiumPaid)} premium paid, {money(totals.redeemedUsd)}{" "}
        redeemed, {money(totals.redeemableUsd)} to redeem.{" "}
        {options.some((o) => o.netUsd !== null)
          ? `Settled series net ${signed(totals.netSettledUsd)}.`
          : "None has settled yet."}
      </p>
      <TableWrap stack>
        <table className={styles.table} aria-label="Options">
          <thead>
            <tr>
              <th scope="col">Series</th>
              <th scope="col" className={styles.num}>
                Held
              </th>
              <th scope="col" className={styles.num}>
                Bought, paid
              </th>
              <th scope="col">State</th>
              <th scope="col">Payoff at expiry</th>
              <th scope="col" className={styles.num}>
                Redeemed, to redeem
              </th>
              <th scope="col" className={styles.num}>
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <tr key={`${o.deployment}-${o.seriesId}`} data-testid="portfolio-option" data-state={o.state}>
                <th scope="row">
                  <Link href={vaultHref(o)} className="text-link">
                    {o.underlying} {o.isCall ? "call" : "put"} {money(o.strike)}
                  </Link>
                  <span className={styles.cellMuted} title={`Series ${o.seriesId}`}>
                    {o.symbol} ({o.version}), expiry {utc(o.expiry)}
                  </span>
                </th>
                <td className={`mono ${styles.num}`}>{amt(o.held)}</td>
                <td className={`mono ${styles.num}`}>
                  {amt(o.bought)}
                  <span className={styles.cellMuted}>{money(o.premiumPaid, 4)}</span>
                </td>
                <td>{OPTION_STATE[o.state]}</td>
                <td>
                  {o.state === "live" || o.state === "expired" ? (
                    <>
                      Pays{" "}
                      {o.isCall
                        ? `the settlement price − ${money(o.strike)}`
                        : `${money(o.strike)} − the settlement price`}{" "}
                      per option when positive
                      {o.breakEven !== null ? `; break-even ${money(o.breakEven)}` : ""}.{" "}
                      <span className={styles.cellMuted}>
                        At today&apos;s spot {money(o.spot)}: {money(o.intrinsicNowUsd ?? 0)} (not a price).
                      </span>
                    </>
                  ) : o.state === "cancelled" ? (
                    `Refund ${money(o.payoutPerOptionUsd ?? 0, 4)} per option`
                  ) : (
                    `Settled at ${money(o.settlementPrice ?? 0)}: ${money(o.payoutPerOptionUsd ?? 0, 4)} per option`
                  )}
                </td>
                <td className={`mono ${styles.num}`}>
                  <span className={own.nowrap}>{money(o.redeemedUsd)}</span>
                  <span className={styles.cellMuted}>
                    {o.redeemable > 0
                      ? `${amt(o.redeemable, 6)} ${o.redeemableUnit} to redeem`
                      : "nothing to redeem"}
                  </span>
                </td>
                <td className={`mono ${styles.num}`}>
                  {o.netUsd === null ? "—" : <span className={tone(o.netUsd)}>{signed(o.netUsd)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}

/* ================================================================ agents */

function Agents({ agents }: { agents: AgentView[] }) {
  return (
    <div className={own.cards} data-testid="portfolio-agents">
      {agents.map((a) => (
        <article
          key={`${a.deployment}-${a.id}`}
          className={`${own.card} ${own.agentCard}`}
          data-testid="portfolio-agent"
        >
          <h3>
            Agent #{a.id} ({a.version}, {chainLabel(a.chainId)})
          </h3>
          <span className={styles.cellMuted}>This wallet is its {a.roles.join(", ")}.</span>
          <dl>
            <dt>Bond</dt>
            <dd>{amt(a.bond, 2)} USDG</dd>
            <dt>Unbonding</dt>
            <dd>{amt(a.unbonding, 2)} USDG</dd>
            <dt>Bond posted, all time</dt>
            <dd>{amt(a.bondPosted, 2)} USDG</dd>
            <dt>Slashes</dt>
            <dd>
              {a.slashes} ({amt(a.slashedUsdg, 2)} USDG)
            </dd>
            <dt>Proposals accepted / rejected</dt>
            <dd>
              {a.accepted} / {a.rejected}
            </dd>
            <dt>Settled epochs</dt>
            <dd>{a.settledEpochs}</dd>
            <dt>Depositors&apos; result</dt>
            <dd>{signed(a.cumulativePnl)}</dd>
            <dt>Fees credited</dt>
            <dd>{amt(a.feesCredited, 4)} USDG</dd>
            <dt>Fees to claim</dt>
            <dd>{amt(a.feesClaimable, 4)} USDG</dd>
          </dl>
          <Link href={`/app/agents?chain=${a.chainId}#performance`} className="text-link">
            The agent&apos;s full record
          </Link>
        </article>
      ))}
    </div>
  );
}

/* ================================================================ activity */

function Activity({ rows }: { rows: ActivityRow[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className={styles.hint}>No activity.</p>;
  const shown = all ? rows : rows.slice(0, 25);
  return (
    <>
      <TableWrap stack>
        <table className={styles.table} aria-label="Activity">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Where</th>
              <th scope="col">What</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={`${r.chainId}-${r.tx}-${r.logIndex}-${r.kind}`}
                data-testid="portfolio-activity"
                data-kind={r.kind}
              >
                <td className="mono">{utc(r.t)}</td>
                <td>
                  {r.symbol ? `${r.symbol}, ` : ""}
                  {where(r)}
                </td>
                <td>{r.text}</td>
                <td>
                  <TxLink chainId={r.chainId} hash={r.tx} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {rows.length > shown.length ? (
        <button type="button" className="pill pill-small pill-ghost" onClick={() => setAll(true)}>
          Show all {rows.length}
        </button>
      ) : null}
    </>
  );
}

/* ================================================================ method */

function Method({ p }: { p: PortfolioJson }) {
  const checked = p.positions.filter((x) => x.check.ok).length;
  return (
    <div className={own.method} data-testid="portfolio-method">
      <p>
        <strong>Source.</strong>{" "}
        {p.source === "indexer"
          ? "The Strike indexer's events"
          : "The chains' event logs over their public RPCs"}{" "}
        for every deployment ({p.chains.map((c) => `${c.label} ${c.key.split("-")[1]}`).join(", ")}), and
        today&apos;s state read through Multicall3. Read {utc(Math.floor(Date.parse(p.generatedAt) / 1000))};
        cached for 30 seconds.
      </p>
      <p>
        <strong>History without archive reads.</strong> The public RPCs keep no historical state, so the share
        price at an old block cannot be read. A vault&apos;s share price only changes at settlement, and each
        settlement emits the vault&apos;s assets and supply (EpochSettled), so the wallet&apos;s holding and
        premium are replayed from its own events with the contract&apos;s formulas.
      </p>
      <p data-testid="portfolio-reconciliation">
        <strong>Checked against today&apos;s reads.</strong> {checked} of {p.positions.length} positions
        rebuilt from events match <code className="mono">balanceOf</code> plus queued shares and{" "}
        <code className="mono">pendingPremium</code>
        {checked < p.positions.length ? "; the others differ and their history is approximate" : ""}.
      </p>
      <p>
        <strong>Prices.</strong> USD values use the StockOracle&apos;s feed: on these testnets, Robinhood
        Chain mainnet Chainlink prints mirrored by a keeper. Deposits and withdrawals are valued at the round
        of their time, the value now at today&apos;s spot. USDG counts as $1.
      </p>
      <p>
        <strong>Model numbers.</strong> The odds in the positions table are the pricing model&apos;s
        (Black-Scholes with the on-chain volatility), not a forecast.
      </p>
      <p className={styles.cellMuted}>
        Testnet wallets hold small, test amounts; the numbers are real reads of them.
      </p>
    </div>
  );
}
