"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useStrike } from "@/hooks/useStrike";
import { errorMessage } from "@/hooks/useTx";
import type { EpochTraceJson, TraceEpochJson, TraceStepJson } from "@/lib/epochTrace";
import { decisionPathFromUri } from "@/lib/decision";
import { isMirrorChain } from "@/lib/mirrorAudit";
import type { VaultSummary } from "@/lib/reads";
import { settlementLine, type SettlementAuditJson } from "@/lib/settlementAudit";
import { Skeleton } from "../Skeleton";
import styles from "./trace.module.css";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;

const STATUS: Record<TraceEpochJson["status"], string> = {
  open: "Open",
  selling: "Selling",
  settled: "Settled",
  aborted: "Aborted",
};

function Ext({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={styles.link} data-testid={testId}>
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

/**
 * Every step of the vault's current and last epoch, from /api/epoch-trace: the opening snapshot, the anchored
 * decision record, each proposal (accepted, or rejected with its slash), each buy, the settlement with its price round
 * checked against mainnet Chainlink (/api/settlement-audit), and redemptions and claims, each with its transaction.
 */
export function EpochTrace({ vault }: { vault: VaultSummary }) {
  const { chainId } = useStrike();
  const trace = useQuery({
    queryKey: ["epoch-trace", chainId, vault.address, vault.currentEpoch.toString(), vault.state],
    queryFn: () => getJson<EpochTraceJson>(`/api/epoch-trace?chain=${chainId}&vault=${vault.address}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const t = trace.data;
  // The settlement check reads mainnet: only once a shown series has expired or settled.
  const needsAudit =
    isMirrorChain(chainId) &&
    !!t?.epochs.some((e) => e.status === "settled" || (e.expiry !== null && t.now >= e.expiry));
  const audit = useQuery({
    queryKey: ["settlement-audit", chainId, vault.address, t?.epochs.map((e) => e.status).join(",")],
    queryFn: () =>
      getJson<SettlementAuditJson>(`/api/settlement-audit?chain=${chainId}&vault=${vault.address}`),
    enabled: needsAudit,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!t) {
    if (trace.isError) {
      return (
        <div className={styles.error} role="alert" data-testid="trace-error">
          <p>Couldn&apos;t read the epoch trace: {errorMessage(trace.error)}</p>
          <button type="button" className="pill pill-small" onClick={() => trace.refetch()}>
            Try again <RotateCw aria-hidden />
          </button>
        </div>
      );
    }
    return (
      <div className={styles.trace} aria-busy="true">
        <Skeleton width="40%" />
        <Skeleton width="70%" />
        <Skeleton width="60%" />
      </div>
    );
  }
  if (t.epochs.length === 0) {
    return <p className={styles.empty}>No epoch has run yet, so there is nothing to trace.</p>;
  }
  return (
    <div className={styles.trace} data-testid="epoch-trace">
      {t.epochs.map((e) => (
        <EpochBlock
          key={e.epoch}
          epoch={e}
          trace={t}
          audit={audit.data}
          auditState={audit}
          needsAudit={needsAudit}
        />
      ))}
    </div>
  );
}

function EpochBlock({
  epoch: e,
  trace,
  audit,
  auditState,
  needsAudit,
}: {
  epoch: TraceEpochJson;
  trace: EpochTraceJson;
  audit: SettlementAuditJson | undefined;
  auditState: { isError: boolean; error: unknown };
  needsAudit: boolean;
}) {
  const check = audit?.series.find((s) => s.seriesId === e.seriesId) ?? null;
  const tx = (h: string) => (trace.explorer ? `${trace.explorer}/tx/${h}` : null);
  // The epoch's decision page, from the anchored record's published URL (the last record anchored for the epoch).
  const decision =
    e.steps
      .filter((s) => s.kind === "record")
      .map((s) => decisionPathFromUri(trace.chainId, s.record?.uri))
      .filter((p): p is string => p !== null)
      .pop() ?? null;
  return (
    <section
      className={styles.epoch}
      data-testid="trace-epoch"
      data-epoch={e.epoch}
      data-status={e.status}
      aria-label={`Epoch ${e.epoch}`}
    >
      <header className={styles.head}>
        <h3 className={styles.title}>
          Epoch {e.epoch} <span className="micro micro-muted">{e.current ? "current" : "previous"}</span>
        </h3>
        <span className={styles.status} data-status={e.status}>
          {STATUS[e.status]}
        </span>
      </header>
      <ol className={styles.steps}>
        {e.steps.map((s, i) => (
          <Step
            key={`${s.kind}-${s.tx ?? "pending"}-${i}`}
            step={s}
            txUrl={s.tx ? tx(s.tx) : null}
            current={e.current}
            decision={decision}
            audit={
              (s.kind === "settle" || s.kind === "pending") && needsAudit ? (
                <AuditLine check={check} state={auditState} loaded={!!audit} />
              ) : null
            }
          />
        ))}
      </ol>
    </section>
  );
}

function Step({
  step: s,
  txUrl,
  current,
  decision,
  audit,
}: {
  step: TraceStepJson;
  txUrl: string | null;
  current: boolean;
  decision: string | null;
  audit: ReactNode;
}) {
  const decisionText =
    s.kind === "record"
      ? "Open the decision"
      : s.kind === "accepted" || s.kind === "rejected"
        ? "Why this strike, and why not the others"
        : s.kind === "settle"
          ? "Graded the ladder: open the decision"
          : null;
  return (
    <li className={styles.step} data-kind={s.kind} data-tone={s.tone} data-testid="trace-step">
      <span className={styles.dot} aria-hidden />
      <div className={styles.body}>
        <div className={styles.stepHead}>
          <strong className={styles.stepTitle}>{s.title}</strong>
          {s.time ? <span className={styles.time}>{utc(s.time)}</span> : null}
        </div>
        {s.facts.map((f) => (
          <p key={f} className={styles.fact}>
            {f}
          </p>
        ))}
        {s.round ? (
          <p className={styles.fact} data-testid="trace-round">
            Recorded by the StockOracle: round {s.round.roundId} at {s.round.price}
          </p>
        ) : null}
        {audit}
        <p className={styles.links}>
          {s.tx ? (
            txUrl ? (
              <Ext href={txUrl} testId="trace-tx">
                tx {shortHash(s.tx)}
              </Ext>
            ) : (
              <span className="mono">tx {shortHash(s.tx)}</span>
            )
          ) : null}
          {s.record?.uri ? <Ext href={s.record.uri}>the record</Ext> : null}
          {s.kind === "record" && current ? (
            <a href="#why" className={styles.link} data-testid="trace-why">
              Check its hash in Why this strike
            </a>
          ) : null}
          {decision && decisionText ? (
            <Link href={decision} className={styles.link} data-testid="trace-decision">
              {decisionText}
            </Link>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function AuditLine({
  check,
  state,
  loaded,
}: {
  check: SettlementAuditJson["series"][number] | null;
  state: { isError: boolean; error: unknown };
  loaded: boolean;
}) {
  if (check) {
    const line = settlementLine(check);
    return (
      <p className={styles.audit} data-tone={line.tone} data-testid="trace-audit" data-status={check.status}>
        {line.tone === "good" ? "✓ " : line.tone === "bad" ? "✗ " : ""}
        {line.text}
      </p>
    );
  }
  if (state.isError) {
    return (
      <p className={styles.audit} data-testid="trace-audit" data-status="error">
        Couldn&apos;t check the round against mainnet Chainlink: {errorMessage(state.error)}
      </p>
    );
  }
  if (loaded) return null;
  return (
    <p className={styles.audit} data-testid="trace-audit" data-status="loading">
      Checking the round against Robinhood Chain mainnet Chainlink…
    </p>
  );
}
