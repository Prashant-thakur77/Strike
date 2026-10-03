"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, Minus } from "lucide-react";
import type { LogRecord } from "@/lib/agentLog";
import type { DecisionInputs, LadderRow, LossLine, Pricing } from "@/lib/decision";
import type { EpochTraceJson } from "@/lib/epochTrace";
import {
  WHAT_IF_CAVEAT,
  consistencyChecks,
  guardModifications,
  stressScenarios,
  whatIfBranches,
  type Branch,
} from "@/lib/whatIf";
import { Skeleton } from "../Skeleton";
import appStyles from "../app.module.css";
import styles from "./decision.module.css";

const usd = (x: number, frac = 2) =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const signed = (x: number, frac = 2) => `${x > 0 ? "+" : ""}${usd(x, frac)}`;
const pct = (x: number, frac = 1) => `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(frac)}%`;
const opts = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });

/** Where a section's figures come from. */
export type SourceKind = "record" | "chain" | "recomputed" | "model";
const SOURCE_TEXT: Record<SourceKind, string> = {
  record: "the anchored record",
  chain: "read from the chain",
  recomputed: "recomputed in your browser from the anchored inputs",
  model: "the pricing model, on the anchored inputs",
};

/** One line under a section's heading: where each of its figures comes from. */
export function SourceLine({ kinds }: { kinds: SourceKind[] }) {
  return (
    <p className={styles.source} data-testid="section-source" data-kinds={kinds.join(" ")}>
      <span className="micro micro-muted">Source</span> {kinds.map((k) => SOURCE_TEXT[k]).join("; ")}
    </p>
  );
}

/** Said in place of a figure the record does not carry: never a blank, never a guess. */
export function NotProvided({ what = "not in the record" }: { what?: string }) {
  return (
    <span className={appStyles.cellMuted} data-testid="not-provided">
      {what}
    </span>
  );
}

/* ================================================================ 02: the agent's changes before sending */

/** PASS / MODIFY / FAIL: what the agent itself changed before the contract saw the proposal. */
export function Modifications({ record: r }: { record: LogRecord }) {
  if (!r.decision) return null;
  const mods = guardModifications(r);
  return (
    <div className={styles.block} data-testid="decision-modifications" data-count={mods.length}>
      <h3 className="micro micro-muted">Changed by the agent before sending</h3>
      {mods.length === 0 ? (
        <p className={appStyles.hint}>
          None: the proposal went to the dry run as planned. The agent writes a note whenever its mandate
          guard or rule profile changes a plan, and this record has none.
        </p>
      ) : (
        <div className={appStyles.tableWrap}>
          <table className={`${appStyles.table} ${styles.ladder}`} aria-label="Changes before sending">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Result</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
                <th scope="col">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {mods.map((m, i) => (
                <tr key={i} data-testid="modification">
                  <th scope="row">{m.rule}</th>
                  <td>
                    <span className={styles.modify}>Modify</span>
                  </td>
                  <td className="mono">{m.before}</td>
                  <td className="mono">{m.after}</td>
                  <td>{m.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================ 04: stress scenarios */

export function StressView({
  inp,
  loss,
  pricing,
  underlying,
  sold,
}: {
  inp: DecisionInputs;
  loss: LossLine;
  pricing: Pick<Pricing, "normCdf">;
  underlying: string;
  sold: boolean;
}) {
  const rows = stressScenarios(inp, loss, pricing);
  return (
    <div className={styles.block} data-testid="decision-stress">
      <h3 className="micro micro-muted">
        Stress: if {underlying} settles {inp.isCall ? "above" : "below"} the snapshot spot
      </h3>
      <div className={appStyles.tableWrap}>
        <table className={`${appStyles.table} ${styles.ladder}`} aria-label="Stress scenarios">
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col">Settles at</th>
              <th scope="col">Payout per option</th>
              <th scope="col">Net per option</th>
              <th scope="col">Vault net, {opts(inp.dry.size)} options</th>
              <th scope="col">Of collateral</th>
              <th scope="col">Model odds, there or further</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.move} data-testid="stress-row">
                <th scope="row" className="mono">
                  {s.move > 0 ? "+" : "−"}
                  {Math.abs(s.move * 100).toFixed(0)}%
                </th>
                <td className="mono">{usd(s.settlement)}</td>
                <td className="mono">{usd(s.payoutPerOption, 4)}</td>
                <td className="mono" data-sign={s.netPerOption >= 0 ? "gain" : "loss"}>
                  {signed(s.netPerOption, 4)}
                </td>
                <td className="mono" data-sign={s.vaultNet >= 0 ? "gain" : "loss"}>
                  {signed(s.vaultNet)}
                </td>
                <td className="mono">{Number.isFinite(s.ofCollateral) ? pct(s.ofCollateral, 2) : "n/a"}</td>
                <td className="mono">{pct(s.odds, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={appStyles.hint}>
        Arithmetic on the record&apos;s {usd(loss.strike)} strike and {usd(loss.premium, 4)} premium per
        option
        {sold ? "" : ", had the proposal been accepted"}, before fees, as if every option offered was bought;
        collateral valued at the {usd(inp.spot)} snapshot. The odds column is the model&apos;s (lognormal at
        the snapshot&apos;s σ of {(inp.sigma * 100).toFixed(0)}% a year), not a forecast. The contract&apos;s
        own stress test of a live series, from the risk engine, is in the vault page&apos;s risk panel.
      </p>
    </div>
  );
}

/* ================================================================ 06: what if */

async function getTrace(url: string): Promise<EpochTraceJson> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (EpochTraceJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function WhatIfView({
  chainId,
  record: r,
  inp,
  rows,
  rowsSource,
}: {
  chainId: number;
  record: LogRecord;
  inp: DecisionInputs;
  rows: LadderRow[] | null;
  rowsSource: "recorded" | "recomputed";
}) {
  const sold = r.result.status === "accepted";
  const epoch = r.anchor?.epoch ?? null;
  // The same query as "In hindsight" (same key), so the page reads the trace once.
  const trace = useQuery({
    queryKey: ["epoch-trace", chainId, r.vault.address, "decision"],
    queryFn: () => getTrace(`/api/epoch-trace?chain=${chainId}&vault=${r.vault.address}`),
    enabled: sold && epoch !== null,
    staleTime: 60_000,
    retry: 1,
  });
  if (sold && epoch !== null && trace.isPending) return <Skeleton width="60%" />;
  const e = trace.data?.epochs.find((x) => x.epoch === String(epoch));
  const price = e?.settlementPrice ? Number(e.settlementPrice) : null;
  const settlement = sold && price !== null && price > 0 ? price : null;
  const w = whatIfBranches(r, inp, rows, settlement);
  const state = settlement !== null ? "graded" : sold ? "model" : "not-sold";
  return (
    <div className={styles.block} data-testid="decision-whatif" data-state={state}>
      <SourceLine
        kinds={
          settlement !== null
            ? ["record", "chain", ...(rowsSource === "recomputed" ? (["recomputed"] as const) : [])]
            : ["record", "model", ...(rowsSource === "recomputed" ? (["recomputed"] as const) : [])]
        }
      />
      <p className={styles.big} data-testid="whatif-takeaway">
        {w.takeaway}
      </p>
      {trace.isError ? (
        <p className={appStyles.hint}>
          The settlement could not be read from the epoch trace, so the branches show model numbers.
        </p>
      ) : null}
      <div className={appStyles.tableWrap}>
        <table className={`${appStyles.table} ${styles.ladder}`} aria-label="What-if branches">
          <thead>
            <tr>
              <th scope="col">What if</th>
              <th scope="col">Strike</th>
              <th scope="col">Options</th>
              <th scope="col">Premium</th>
              {settlement !== null ? (
                <>
                  <th scope="col">Payout at {usd(settlement)}</th>
                  <th scope="col">Net for the vault</th>
                </>
              ) : (
                <>
                  <th scope="col">Model value of the payout</th>
                  <th scope="col">Model net</th>
                </>
              )}
              <th scope="col">Mandate</th>
            </tr>
          </thead>
          <tbody>
            {w.branches.map((b) => (
              <BranchRow key={b.kind} b={b} graded={settlement !== null} />
            ))}
          </tbody>
        </table>
      </div>
      <p className={appStyles.hint} data-testid="whatif-caveat">
        {WHAT_IF_CAVEAT}
        {rows && rowsSource === "recomputed"
          ? " The rungs either side come from the ladder recomputed from the anchored inputs."
          : ""}
        {sold && settlement === null
          ? " The payout columns switch to the settlement price once the series settles."
          : ""}
      </p>
    </div>
  );
}

function BranchRow({ b, graded }: { b: Branch; graded: boolean }) {
  const payout = graded ? b.payout! : b.modelPayout;
  const net = graded ? b.net! : b.modelNet;
  return (
    <tr data-testid="whatif-row" data-kind={b.kind} data-sent={b.actual || undefined}>
      <th scope="row">
        {b.question}
        {b.actual ? <span className={styles.sent}>what happened</span> : null}
      </th>
      <td className="mono">{b.strike === null ? "none" : usd(b.strike)}</td>
      <td className="mono">{opts(b.options)}</td>
      <td className="mono">{usd(b.premium)}</td>
      <td className="mono">{usd(payout)}</td>
      <td className="mono" data-sign={net > 0 ? "gain" : net < 0 ? "loss" : undefined}>
        {signed(net)}
      </td>
      <td>
        {b.inside === null ? (
          <span className={appStyles.cellMuted}>nothing to check</span>
        ) : (
          <span className={styles.rowVerdict} data-ok={b.inside}>
            {b.inside ? "inside" : `outside: ${b.reason ?? "rejected"}`}
          </span>
        )}
      </td>
    </tr>
  );
}

/* ================================================================ 07: consistency */

export function ConsistencyView({
  record: r,
  anchor,
  ladderMatches,
}: {
  record: LogRecord;
  anchor: string;
  ladderMatches: boolean | null;
}) {
  const checks = consistencyChecks(r, { anchor, ladderMatches });
  const bad = checks.filter((c) => c.ok === false).length;
  return (
    <div className={styles.block} data-testid="decision-consistency" data-contradictions={bad}>
      <h3 className="micro micro-muted">
        Where this record could contradict itself or the chain ·{" "}
        {bad === 0 ? "no contradiction found" : `${bad} contradiction${bad === 1 ? "" : "s"}`}
      </h3>
      <ul className={styles.checks}>
        {checks.map((c) => (
          <li key={c.id} className={styles.check} data-ok={c.ok ?? "unknown"} data-testid="consistency-check">
            {c.ok === true ? (
              <Check size={13} aria-hidden />
            ) : c.ok === false ? (
              <CircleAlert size={13} aria-hidden />
            ) : (
              <Minus size={13} aria-hidden />
            )}
            <strong>{c.label}</strong>
            {c.ok === null ? " (not checked)" : ""}: {c.detail}.
          </li>
        ))}
      </ul>
    </div>
  );
}
