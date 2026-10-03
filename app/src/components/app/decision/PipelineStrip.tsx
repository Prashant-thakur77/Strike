"use client";

import { ArrowUpRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { LogRecord } from "@/lib/agentLog";
import {
  BY_LABEL,
  STAGE_LABEL,
  notProvided,
  sourceUrl,
  stripStages,
  txUrl,
  verdictLabel,
  type Pipeline,
  type LlmUsage,
  type Stage,
  type UsageFigure,
} from "@/lib/pipeline";
import appStyles from "../app.module.css";
import styles from "./decision.module.css";

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.flatMap((x) => (obj(x) ? [obj(x)!] : [])) : [];
const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const pct = (x: number | null, frac = 1) => (x === null ? "n/a" : `${(x * 100).toFixed(frac)}%`);
const usd = (v: unknown, frac = 2) => {
  const x = n(v);
  return x === null
    ? "n/a"
    : `$${x.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
};
const delta = (bps: unknown) => {
  const x = n(bps);
  return x === null ? "n/a" : (x / 10_000).toFixed(2);
};
const ms = (x: number | null) => (x === null ? "n/a" : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(1)} s`);

/** The stage strip: one chip per stage in the order they ran, then a card per stage. */
export function PipelineStrip({
  pipeline: p,
  record: r,
  chainId,
}: {
  pipeline: Pipeline;
  record?: LogRecord;
  chainId: number;
}) {
  const stages = stripStages(p);
  const [open, setOpen] = useState<number>(() => {
    const stop = stages.findIndex((x) => x.verdict === "fail" || x.verdict === "modify");
    return stop >= 0 ? stop : 0;
  });
  return (
    <div className={styles.block} data-testid="pipeline" data-stages={stages.length}>
      {p.run?.ignoreSession ? (
        <p className={styles.banner} data-testid="pipeline-as-if-open">
          Evaluated as if the NYSE were open (dry run). {p.run.note}
        </p>
      ) : p.run?.dryRun ? (
        <p className={styles.banner} data-testid="pipeline-dry-run">
          {p.run.note || "Dry run: nothing was sent."}
        </p>
      ) : null}
      {p.noTrade ? (
        <div className={styles.noTrade} data-testid="pipeline-no-trade">
          <strong>
            No trade: stopped by the {STAGE_LABEL[p.noTrade.stage]?.toLowerCase() ?? p.noTrade.stage}.
          </strong>{" "}
          {p.noTrade.reasons.join("; ")}
          {p.noTrade.codes.length ? <span className="mono"> ({p.noTrade.codes.join(", ")})</span> : null}
        </div>
      ) : null}
      <ol className={styles.strip} aria-label="Pipeline stages, in the order they ran">
        {stages.map((st, i) => (
          <li key={`${st.stage}-${st.attempt}-${i}`}>
            <button
              type="button"
              className={styles.chip}
              data-verdict={st.verdict}
              aria-pressed={open === i}
              onClick={() => setOpen(i)}
              data-testid="pipeline-chip"
              data-stage={st.stage}
            >
              <span className="micro micro-muted">
                {String(i + 1).padStart(2, "0")} {STAGE_LABEL[st.stage] ?? st.stage}
                {st.attempt > 1 ? ` · attempt ${st.attempt}` : ""}
              </span>
              <span className={styles.chipVerdict}>{verdictLabel(st, p.noTrade)}</span>
            </button>
          </li>
        ))}
      </ol>
      <RunLine stages={p.stages} llm={p.llm} />
      {stages[open] ? <StageCard stage={stages[open]!} pipeline={p} record={r} chainId={chainId} /> : null}
    </div>
  );
}

function StageCard({
  stage: st,
  pipeline: p,
  record: r,
  chainId,
}: {
  stage: Stage & { missing?: boolean };
  pipeline: Pipeline;
  record?: LogRecord;
  chainId: number;
}) {
  const plannerTarget = n(p.stages.find((x) => x.stage === "planner")?.output.targetDeltaBps);
  let body: ReactNode = null;
  void r;
  if (st.stage === "market") body = <MarketBody st={st} />;
  else if (st.stage === "risk") body = <RiskBody st={st} chosen={plannerTarget} />;
  else if (st.stage === "planner") body = <PlannerBody st={st} />;
  else if (st.stage === "critic") body = <CriticBody st={st} pipeline={p} />;
  else if (st.stage === "contract") body = <ContractBody st={st} chainId={chainId} />;
  return (
    <article
      className={styles.stageCard}
      data-testid="pipeline-stage"
      data-stage={st.stage}
      data-verdict={st.verdict}
    >
      <header className={styles.stageHead}>
        <span className={styles.chipVerdict} data-verdict={st.verdict}>
          {verdictLabel(st, p.noTrade)}
        </span>
        <strong>
          {STAGE_LABEL[st.stage] ?? st.stage}
          {st.attempt > 1 ? `, attempt ${st.attempt}` : ""}
        </strong>
        <span className="micro micro-muted">
          {st.missing
            ? "not in this record"
            : `by ${BY_LABEL[st.by] ?? (st.by || "unknown")} · ${ms(st.durationMs)}`}
        </span>
      </header>
      <p className={styles.para} data-testid="pipeline-summary">
        {st.summary || "No summary in the record."}
      </p>
      {st.narration ? (
        <aside className={styles.context} data-testid="pipeline-narration">
          <p className="micro micro-muted">
            Narration by {st.narration.label} (Claude&apos;s words, not a computed number)
          </p>
          <p>{st.narration.text}</p>
        </aside>
      ) : null}
      {body}
      {st.sources.length ? (
        <div className={styles.sources}>
          <span className="micro micro-muted">Sources</span>
          <ul className={appStyles.factLinks} aria-label="Sources">
            {st.sources.map((src, i) => {
              const url = sourceUrl(src, chainId);
              const text = `${src.name}${src.kind && src.kind !== "contract" ? ` (${src.kind})` : ""}${
                src.chainId && src.chainId !== chainId ? `, chain ${src.chainId}` : ""
              }`;
              return (
                <li key={i}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="text-link">
                      {text} <ArrowUpRight size={11} aria-hidden />
                    </a>
                  ) : (
                    <span>{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {!st.missing && (Object.keys(st.inputs).length || Object.keys(st.output).length) ? (
        <details className={styles.raw}>
          <summary className="micro">Inputs and output, as recorded</summary>
          <Raw label="Inputs" value={st.inputs} />
          <Raw label="Output" value={st.output} />
        </details>
      ) : null}
    </article>
  );
}

function Raw({ label, value }: { label: string; value: Record<string, unknown> }) {
  if (Object.keys(value).length === 0) return null;
  return (
    <div className={styles.rawBlock}>
      <span className="micro micro-muted">{label}</span>
      <pre className={styles.pre} tabIndex={0}>
        {JSON.stringify(value, (_k, v) => (notProvided(v) ? `not provided: ${notProvided(v)}` : v), 2)}
      </pre>
    </div>
  );
}

function Ok({ ok, waived, applicable = true }: { ok: unknown; waived?: unknown; applicable?: unknown }) {
  if (applicable === false) return <span className={appStyles.cellMuted}>not applicable</span>;
  if (waived === true) return <span className={appStyles.cellMuted}>waived</span>;
  return (
    <span className={styles.rowVerdict} data-ok={ok === true}>
      {ok === true ? "ok" : "failed"}
    </span>
  );
}

function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className={appStyles.tableWrap}>
      <table className={`${appStyles.table} ${styles.ladder}`} aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const shown = (v: unknown) => (notProvided(v) ? `not provided: ${notProvided(v)}` : s(v));

function MarketBody({ st }: { st: Stage }) {
  const o = st.output;
  const checks = arr(o.checks);
  const sigma = obj(o.sigma);
  const realised = obj(sigma?.realised);
  const contradictions = arr(o.contradictions);
  return (
    <>
      {checks.length ? (
        <Table label="Market checks" head={["Check", "Code", "Measured", "Limit", "Result"]}>
          {checks.map((c, i) => (
            <tr key={i} data-testid="market-check">
              <th scope="row">{s(c.check)}</th>
              <td className="mono">{s(c.code)}</td>
              <td>{shown(c.measured)}</td>
              <td>{s(c.limit)}</td>
              <td>
                <Ok ok={c.ok} waived={c.waived} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {sigma ? (
        <p className={styles.para}>
          Pricer volatility {pct(n(sigma.value))} a year
          {realised
            ? ` against ${pct(n(realised.value))} realised over the last ${s(realised.returns)} daily mainnet closes`
            : notProvided(sigma.realised)
              ? `; realised volatility not provided: ${notProvided(sigma.realised)}`
              : ""}
          .
        </p>
      ) : null}
      {contradictions.length ? (
        <Table label="Inputs that should agree" head={["Compared", "Measured", "Limit", "Agree"]}>
          {contradictions.map((c, i) => (
            <tr key={i} data-testid="market-contradiction">
              <th scope="row">{(Array.isArray(c.between) ? c.between : []).map(s).join(" against ")}</th>
              <td>{shown(c.measured)}</td>
              <td>{s(c.limit)}</td>
              <td>
                <span className={styles.rowVerdict} data-ok={c.agree === true}>
                  {c.agree === true ? "agree" : c.agree === false ? "disagree" : "not checked"}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </>
  );
}

function RiskBody({ st, chosen }: { st: Stage; chosen: number | null }) {
  const o = st.output;
  const rows = arr(o.rows);
  const engine = obj(o.engine);
  const rej = obj(o.rejections);
  return (
    <>
      {rows.length ? (
        <Table
          label="Risk table"
          head={[
            "Δ",
            "Strike",
            "Contract",
            "Yield",
            "P(exercise), model odds",
            "Break-even",
            "Worst ±30%",
            "Greeks",
          ]}
        >
          {rows.map((row, i) => {
            const fr = obj(row.failedRule);
            const stress = obj(row.stress);
            const g = obj(row.greeks);
            const isChosen = chosen !== null && n(row.targetDeltaBps) === chosen;
            return (
              <tr key={i} data-sent={isChosen || undefined} data-testid="risk-row">
                <th scope="row" className="mono">
                  {delta(row.targetDeltaBps)}
                  {isChosen ? <span className={styles.sent}>chosen</span> : null}
                </th>
                <td className="mono">{usd(row.strike)}</td>
                <td>
                  <span className={styles.rowVerdict} data-ok={row.ok === true}>
                    {row.ok === true
                      ? "inside"
                      : fr
                        ? `${s(fr.rule)}: ${s(fr.measured)} against ${s(fr.limit)}`
                        : s(row.reason)}
                  </span>
                </td>
                <td className="mono">
                  {n(row.yieldBps) === null ? "n/a" : `${(n(row.yieldBps)! / 100).toFixed(2)}%`}
                </td>
                <td className="mono">{pct(n(row.exerciseProbability))}</td>
                <td className="mono">
                  {usd(row.breakEven)}
                  <span className={appStyles.cellMuted}>{pct(n(row.breakEvenDistance))} away</span>
                </td>
                <td className="mono">
                  {stress ? (
                    <>
                      {usd(stress.worstLossUsd)}
                      <span className={appStyles.cellMuted}>
                        {pct(n(stress.shareOfCollateral))} of collateral
                      </span>
                    </>
                  ) : (
                    shown(row.stress) || "n/a"
                  )}
                </td>
                <td className="mono">
                  {g
                    ? `Δ ${n(g.delta)?.toFixed(3) ?? "n/a"} Γ ${n(g.gamma)?.toFixed(4) ?? "n/a"} ν ${n(g.vega)?.toFixed(2) ?? "n/a"} θ ${n(g.theta)?.toFixed(3) ?? "n/a"}`
                    : shown(row.greeks) || "n/a"}
                </td>
              </tr>
            );
          })}
        </Table>
      ) : null}
      <p className={appStyles.hint}>
        {rej && Object.keys(rej).length
          ? `Rejected rungs: ${Object.entries(rej)
              .map(([k, v]) => `${s(v)} ${k}`)
              .join(", ")}. `
          : ""}
        {engine ? `Greeks and stress from the risk engine at ${s(engine.address)} (${s(engine.via)}). ` : ""}
        {s(o.shocks)}
      </p>
    </>
  );
}

function PlannerBody({ st }: { st: Stage }) {
  const o = st.output;
  const considered = arr(o.considered);
  if (o.targetDeltaBps === undefined && considered.length === 0) return null;
  return (
    <>
      <p className={styles.para} data-testid="planner-choice">
        Chose {delta(o.targetDeltaBps)} delta at{" "}
        {n(o.premiumBps) === null ? "n/a" : `${(n(o.premiumBps)! / 100).toFixed(0)}%`} of fair value: strike{" "}
        {usd(o.strike)}, {s(o.size) || "n/a"} options{o.from ? `, from the ${s(o.from)}` : ""}.
      </p>
      {considered.length ? (
        <Table label="Rungs considered" head={["Δ", "Contract", "Distance from the target", "Selected"]}>
          {considered.map((c, i) => (
            <tr key={i} data-sent={c.selected === true || undefined}>
              <th scope="row" className="mono">
                {delta(c.targetDeltaBps)}
              </th>
              <td>
                <span className={styles.rowVerdict} data-ok={c.ok === true}>
                  {c.ok === true ? "inside" : s(c.reason)}
                </span>
              </td>
              <td className="mono">{delta(c.distanceBps)}</td>
              <td>{c.selected === true ? <span className={styles.sent}>selected</span> : ""}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </>
  );
}

function CriticBody({ st, pipeline: p }: { st: Stage; pipeline: Pipeline }) {
  const o = st.output;
  const mods = arr(o.modifications);
  const rules = arr(o.rules);
  const veto = Array.isArray(o.veto) ? o.veto.map(s) : [];
  return (
    <>
      {mods.length ? (
        <Table label="Critic's changes" head={["Field", "Before", "After", "Why"]}>
          {mods.map((m, i) => (
            <tr key={i} data-testid="critic-modification">
              <th scope="row">{s(m.field)}</th>
              <td className="mono">{s(m.before)}</td>
              <td className="mono">{s(m.after)}</td>
              <td>{s(m.reason)}</td>
            </tr>
          ))}
        </Table>
      ) : st.verdict !== "not-run" ? (
        <p className={appStyles.hint}>No changes: the critic passed the plan as it was.</p>
      ) : null}
      {rules.length ? (
        <Table label="Critic's rules" head={["Priority", "Rule", "Code", "Measured", "Limit", "Result"]}>
          {[...rules]
            .sort((a, b) => s(a.priority).localeCompare(s(b.priority)))
            .map((ru, i) => (
              <tr key={i} data-testid="critic-rule">
                <th scope="row" className="mono">
                  {s(ru.priority)}
                </th>
                <td>{s(ru.rule)}</td>
                <td className="mono">{s(ru.code)}</td>
                <td>{shown(ru.measured)}</td>
                <td>{s(ru.limit)}</td>
                <td>
                  {ru.applicable === false ? (
                    <span className={appStyles.cellMuted}>not applicable</span>
                  ) : (
                    <span className={styles.rowVerdict} data-ok={ru.ok === true}>
                      {ru.ok === true ? "ok" : "VETO"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
        </Table>
      ) : null}
      {veto.length ? <p className={styles.para}>Vetoed: {veto.join("; ")}.</p> : null}
      {p.confidence ? (
        <p className={styles.para} data-testid="critic-confidence">
          Model odds it expires worthless:{" "}
          <strong className="mono">{pct(p.confidence.worthlessProbability)}</strong>.{" "}
          <span className={appStyles.cellMuted}>{p.confidence.basis}</span>
        </p>
      ) : null}
    </>
  );
}

function ContractBody({ st, chainId }: { st: Stage; chainId: number }) {
  const pre = obj(st.inputs.preflight);
  const checks = arr(pre?.checks);
  const o = st.output;
  const tx = s(o.txHash);
  const url = tx ? txUrl(tx, chainId) : null;
  return (
    <>
      {checks.length ? (
        <Table label="Preflight before sending" head={["Check", "Code", "Measured", "Limit", "Result"]}>
          {checks.map((c, i) => (
            <tr key={i} data-testid="contract-preflight">
              <th scope="row">{s(c.check)}</th>
              <td className="mono">{s(c.code)}</td>
              <td>{shown(c.measured)}</td>
              <td>{s(c.limit)}</td>
              <td>
                <Ok ok={c.ok} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {pre?.proposalDigest ? (
        <p className={appStyles.hint}>
          Proposal digest <span className="mono">{s(pre.proposalDigest)}</span>: the payload the critic
          passed, bound before sending.
        </p>
      ) : null}
      {o.submitted !== undefined ? (
        <p className={styles.para}>
          {o.accepted === true
            ? `Accepted: series ${s(o.seriesId)}, strike ${usd(o.strike)}, ${s(o.size)} options.`
            : o.submitted === true
              ? `Rejected on-chain (${s(o.reason)}); ${s(o.slashed)} USDG slashed from the bond.`
              : `Not submitted: ${s(o.reason)}.`}{" "}
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="text-link">
              Transaction <ArrowUpRight size={11} aria-hidden />
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

/** A count with thousands separators, or why the record has none. */
const figureText = (f: UsageFigure, unit: string) =>
  f.value !== null ? `${f.value.toLocaleString("en-US")} ${unit}` : `${unit} not provided (${f.reason})`;

/** The Claude call's usage as the record keeps it (decision.llm): tokens, calls, price where the source gave one. */
function usageText(u: LlmUsage): string {
  const parts = [
    figureText(u.calls, u.calls.value === 1 ? "call" : "calls"),
    figureText(u.inputTokens, "input tokens"),
    figureText(u.outputTokens, "output tokens"),
  ];
  if (u.cacheReadTokens.value !== null) parts.push(figureText(u.cacheReadTokens, "cache-read tokens"));
  if (u.cacheCreationTokens.value !== null)
    parts.push(figureText(u.cacheCreationTokens, "cache-creation tokens"));
  parts.push(
    u.costUsd.value !== null
      ? `$${u.costUsd.value.toFixed(u.costUsd.value < 1 ? 4 : 2)} (Claude Code's own list-price estimate, not a bill)`
      : "no price reported",
  );
  if (u.durationMs.value !== null) parts.push(ms(u.durationMs.value));
  return parts.join(", ");
}

/** How the run was spent, from the record's own timings and, when it has them, the Claude call's recorded usage. */
function RunLine({ stages, llm }: { stages: Stage[]; llm: LlmUsage | null }) {
  const ran = stages.filter((x) => x.verdict !== "not-run");
  const total = ran.reduce((t, x) => t + (x.durationMs ?? 0), 0);
  const by = (k: string) => ran.filter((x) => x.by === k).length;
  const claude = stages.find((x) => x.narration)?.narration?.label ?? null;
  return (
    <p className={appStyles.hint} data-testid="pipeline-run">
      {ran.length} of {stages.length} stage{stages.length === 1 ? "" : "s"} ran, {ms(total)} in all (
      {ran.map((x) => `${STAGE_LABEL[x.stage] ?? x.stage} ${ms(x.durationMs)}`).join(", ") || "none"}); agent
      code ran {by("rule")}, Claude {by("claude")}
      {claude ? ` (${claude})` : ""}, the contract {by("contract")}.{" "}
      {llm ? (
        <span data-testid="pipeline-usage" title={llm.source || undefined}>
          Claude used {usageText(llm)}.
        </span>
      ) : (
        <span data-testid="pipeline-usage-missing">
          The record does not carry token counts, so none are shown.
        </span>
      )}
    </p>
  );
}
