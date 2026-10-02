"use client";

import { ArrowUpRight, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "@/hooks/useTx";
import { EPOCH_STATES } from "@/lib/labels";
import { headline } from "@/lib/mirrorAudit";
import {
  LAG_GRACE,
  SCHEDULES,
  STALE_AFTER,
  chainTone,
  feedVerdict,
  fmtAge,
  fmtUtc,
  newestRound,
  scheduleVerdict,
  type ChainStatusJson,
  type StatusJson,
  type Tone,
  type VaultStatusJson,
} from "@/lib/status";
import { useMirrorAudit } from "../mirror/useMirrorAudit";
import { Skeleton } from "../Skeleton";
import { StateTag } from "../StateTag";
import { useStatus } from "./useStatus";
import appStyles from "../app.module.css";
import styles from "./status.module.css";

const REPO = "https://github.com/Prashant-thakur77/Strike";

/** The viewer's clock (unix seconds), ticking every 30 s; null until mounted. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={styles.link}>
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

function Pill({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span className={appStyles.verdict} data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

/**
 * Is Strike running by itself? Per testnet: how old the newest mirrored price round is against mainnet's latest
 * print, each feed's verdict, each vault's epoch, next expiry and last settlement, and the price mirror audit's
 * verdict; then whether the keeper and the weekly agent are scheduled. From /api/status and /api/mirror-audit.
 */
export function LivenessCard() {
  const q = useStatus();
  const now = useNow();
  const s = q.data;
  const at = now ?? (s ? Math.floor(Date.parse(s.generatedAt) / 1000) : 0);
  return (
    <div className={styles.card} data-testid="liveness" aria-live="polite">
      <p className="micro micro-muted">
        Read on the server from both testnets, Robinhood Chain mainnet and GitHub · refreshed every 5 min
        {s ? ` · read ${fmtUtc(Date.parse(s.generatedAt) / 1000)}` : ""}
      </p>
      {s ? (
        <>
          <div className={styles.chains}>
            {s.chains.map((c) => (
              <ChainCard key={c.chainId} chain={c} now={at} />
            ))}
          </div>
          <Schedules status={s} now={at} />
          <p className={styles.small}>
            The labels are display judgment, not protocol claims: a feed is <em>stale</em> when its last
            mirrored round is older than {STALE_AFTER / 3600} h on an NYSE trading day, and <em>behind</em>{" "}
            when a mainnet print has waited more than {LAG_GRACE / 60} minutes to be mirrored. The
            contracts&apos; own limit is each token&apos;s <code className="mono">maxPriceAge</code> in{" "}
            <code className="mono">StockOracle.feedConfig</code>, 25 h here. Also as JSON:{" "}
            <code className="mono">/api/status</code>.
          </p>
        </>
      ) : q.isError ? (
        <div className={styles.error} role="alert">
          <p>Couldn&apos;t read the status: {errorMessage(q.error)}</p>
          <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
            Try again <RotateCw aria-hidden />
          </button>
        </div>
      ) : (
        <div className={styles.chains} aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className={styles.chain}>
              <Skeleton width="40%" />
              <Skeleton width="70%" />
              <Skeleton width="55%" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChainCard({ chain: c, now }: { chain: ChainStatusJson; now: number }) {
  const audit = useMirrorAudit(c.chainId);
  const newest = newestRound(c);
  const tone = chainTone(c, now);
  const tx = (h: string) => `${c.explorer}/tx/${h}`;
  return (
    <section className={styles.chain} data-testid="liveness-chain" data-chain={c.chainId} data-tone={tone}>
      <header className={styles.chainHead}>
        <h3 className={styles.chainName}>{c.chainName}</h3>
        <Pill tone={tone} testId="liveness-chain-tone">
          {tone === "good"
            ? "Prices in step"
            : tone === "warn"
              ? "Prices behind"
              : tone === "bad"
                ? "Stale"
                : "—"}
        </Pill>
      </header>

      {newest ? (
        <div className={styles.headline}>
          <span className="micro micro-muted">Newest mirrored round</span>
          <p className={styles.big} data-testid="liveness-age">
            {fmtAge(now - newest.updatedAt)} old
          </p>
          <p className={styles.sub}>
            {newest.symbol} round {newest.roundId}, {newest.price} at {fmtUtc(newest.updatedAt)}
            {newest.mainnet ? (
              <>
                {" "}
                · mainnet&apos;s latest {newest.symbol} print {fmtUtc(newest.mainnet.updatedAt)}
              </>
            ) : null}
            {c.marketOpen !== null ? (
              <>
                {" "}
                · NYSE {c.marketOpen ? "open" : "closed"}
                {c.tradingDay === false ? ", no session today" : ""}
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      <ul className={styles.feeds} aria-label={`${c.chainName} price feeds`}>
        {c.feeds.map((f) => {
          const v = feedVerdict(f, now, c.tradingDay);
          return (
            <li key={f.feed} data-symbol={f.symbol} data-tone={v.tone}>
              <span className={styles.feedSym}>{f.symbol}</span>
              <span className={`mono ${styles.feedPrice}`}>{f.price || "—"}</span>
              <span className={styles.feedAge}>{f.updatedAt ? `${fmtAge(now - f.updatedAt)} old` : ""}</span>
              <Pill tone={v.tone}>{v.label}</Pill>
              <span className={styles.feedDetail}>{v.detail}</span>
            </li>
          );
        })}
      </ul>

      <div
        className={styles.audit}
        data-testid="liveness-audit"
        data-state={audit.data ? (audit.data.ok ? "ok" : "mismatch") : audit.isError ? "error" : "loading"}
      >
        <span className="micro micro-muted">Price mirror audit</span>
        {audit.data ? (
          <a href="#mirror" className={styles.link}>
            {audit.data.ok ? "✓ " : "✗ "}
            {headline(audit.data)}
          </a>
        ) : audit.isError ? (
          <span>Couldn&apos;t run: {errorMessage(audit.error)}</span>
        ) : (
          <Skeleton width="16em" />
        )}
      </div>

      {c.deployments.map((d) => (
        <div key={d.epochManager} className={styles.deployment}>
          <span className="micro micro-muted">
            {d.version} · {d.vaults.length} vault{d.vaults.length === 1 ? "" : "s"}
          </span>
          <ul className={styles.vaults} aria-label={`${c.chainName} ${d.version} vaults`}>
            {d.vaults.map((v) => (
              <VaultRow key={v.address} vault={v} now={now} chainId={c.chainId} tx={tx} />
            ))}
          </ul>
        </div>
      ))}
      {c.errors.length ? (
        <p className={styles.warn} role="note">
          Not read: {c.errors.join("; ")}
        </p>
      ) : null}
    </section>
  );
}

function VaultRow({
  vault: v,
  now,
  chainId,
  tx,
}: {
  vault: VaultStatusJson;
  now: number;
  chainId: number;
  tx: (h: string) => string;
}) {
  const expired = v.expiry !== null && v.expiry <= now;
  const last = v.lastSettlement;
  return (
    <li data-vault={v.address} data-state={EPOCH_STATES[v.state]?.name}>
      <a href={`/app/vault/${v.address}?chain=${chainId}`} className={styles.vaultName}>
        {v.symbol}
      </a>
      <span className={styles.vaultState}>
        <StateTag state={v.state} />
        <span className="micro micro-muted">epoch {v.epoch}</span>
      </span>
      <span className={styles.vaultCell} data-testid="vault-expiry">
        {v.expiry !== null
          ? expired
            ? `Expired ${fmtUtc(v.expiry)}, waiting for settle`
            : `Expires ${fmtUtc(v.expiry)}`
          : v.state === 1
            ? "Waiting for the agent's proposal"
            : "No series"}
      </span>
      <span className={styles.vaultCell} data-testid="vault-last-settlement">
        {last ? (
          <>
            {last.kind === "settled"
              ? `Epoch ${last.epoch} settled${last.price ? ` at ${last.price}` : ""}`
              : `Epoch ${last.epoch} aborted`}
            {last.time ? `, ${fmtUtc(last.time)}` : ""} · <Ext href={tx(last.tx)}>tx</Ext>
          </>
        ) : (
          "Never settled yet"
        )}
      </span>
    </li>
  );
}

function Schedules({ status, now }: { status: StatusJson; now: number }) {
  return (
    <div className={styles.schedules}>
      {SCHEDULES.map((sch) => {
        const s = status.schedules.find((x) => x.workflow === sch.workflow);
        const v = s
          ? scheduleVerdict(s, sch, now)
          : { tone: "neutral" as Tone, label: "Unknown", detail: "" };
        return (
          <section
            key={sch.workflow}
            className={styles.schedule}
            data-testid="liveness-schedule"
            data-workflow={sch.workflow}
            data-state={s?.state ?? "unknown"}
          >
            <header className={styles.chainHead}>
              <h3 className={styles.scheduleName}>{sch.name}</h3>
              <Pill tone={v.tone}>{v.label}</Pill>
            </header>
            <p className={styles.sub}>
              <Ext href={`${REPO}/blob/main/.github/workflows/${sch.workflow}`}>{sch.workflow}</Ext>,{" "}
              {sch.crons.map((c) => c.text).join(" and ")}: {sch.does}.
            </p>
            <p className={styles.scheduleDetail}>{v.detail}</p>
            <p className={styles.sub}>
              {s?.lastScheduled?.url ? <Ext href={s.lastScheduled.url}>last scheduled run</Ext> : null}
              {s?.lastScheduled?.url && s.lastManual?.url ? " · " : null}
              {s?.lastManual?.url ? (
                <Ext href={s.lastManual.url}>
                  last run by hand, {fmtUtc(Date.parse(s.lastManual.createdAt) / 1000)}
                  {s.lastManual.conclusion ? `, ${s.lastManual.conclusion}` : ""}
                </Ext>
              ) : null}
            </p>
          </section>
        );
      })}
    </div>
  );
}
