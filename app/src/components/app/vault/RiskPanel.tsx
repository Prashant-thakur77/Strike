"use client";

import { type Greeks, type SeriesRisk, explainSeriesRisk } from "@strike/sdk";
import { ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import { useSeriesRisk } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { errorMessage } from "@/hooks/useTx";
import { CHAIN_META, explorerUrl, type AppChainId } from "@/lib/chains";
import type { Deployment } from "@/lib/deployment";
import { fmtAmount, fmtDuration, shortAddr, toNumber } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { Skeleton } from "../Skeleton";
import { RiskChart, type RiskPoint, shockLabel } from "./RiskChart";
import styles from "../app.module.css";
import { Term } from "@/components/ui/Term";

const money = (n: number, frac = 2) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const signed = (n: number, frac = 2) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const signedMoney = (n: number) => (Math.abs(n) < 0.005 ? money(0) : `${n > 0 ? "+" : "−"}${money(n)}`);
const pct = (wad: bigint, frac = 1) => `${(toNumber(wad, 18) * 100).toFixed(frac)}%`;
/** Drop the "Delta −0.50: " lead of an explanation: the value is shown next to it. */
const rest = (line: string) => line.slice(line.indexOf(": ") + 2);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const GREEKS = [
  { key: "delta", label: "Delta", frac: 2, unit: "" },
  { key: "gamma", label: "Gamma", frac: 4, unit: "" },
  { key: "vega", label: "Vega", frac: 2, unit: "" },
  { key: "theta", label: "Theta", frac: 2, unit: " /day" },
] as const;

export function RiskPanel({ vault }: { vault: VaultSummary }) {
  const { deployment } = useStrike();
  const risk = useSeriesRisk(vault);
  if (!deployment?.riskEngine && !deployment?.riskLens) {
    return (
      <p className={styles.hint}>
        No risk engine is deployed on this network. It runs on Robinhood Chain testnet and Arbitrum Sepolia.
      </p>
    );
  }
  if (!vault.series || vault.state !== 2) {
    return (
      <div className={styles.prompt}>
        <p className="h3">No live series.</p>
        <p className="body">
          Greeks and the stress test appear here while the vault is selling an option series.
        </p>
      </div>
    );
  }
  if (risk.error && !risk.data) {
    return (
      <div className={styles.riskState} role="alert" data-testid="risk-error">
        <p className="h3">The risk engine could not be read.</p>
        <p className={styles.hint}>{errorMessage(risk.error)}</p>
        <button type="button" className="pill pill-small pill-ghost" onClick={() => risk.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!risk.data) return <RiskSkeleton />;
  return <RiskBody vault={vault} r={risk.data} stale={risk.isFetching && risk.isPlaceholderData} />;
}

function RiskSkeleton() {
  return (
    <div className={styles.riskState} aria-busy="true" data-testid="risk-loading">
      <span className="micro micro-muted">Asking the Stylus risk engine…</span>
      <div className={styles.riskGreeks}>
        {GREEKS.map((g) => (
          <div key={g.key} className={styles.riskGreek}>
            <span className="micro micro-muted">
              <Term id={g.key}>{g.label}</Term>
            </span>
            <span className={styles.riskValue}>
              <Skeleton width="3.5em" />
            </span>
            <Skeleton width="90%" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskBody({ vault, r, stale }: { vault: VaultSummary; r: SeriesRisk; stale: boolean }) {
  const { chainId, deployment } = useStrike();
  const [view, setView] = useState<"chart" | "table">("chart");
  const titleId = useId();
  const sym = vault.underlying.symbol;
  const lines = explainSeriesRisk(r, sym);
  const premium = toNumber(r.premium, r.usdgDecimals);
  const points: RiskPoint[] = r.scenarios.map((s) => {
    const payout = toNumber(s.loss, 18);
    return { shock: toNumber(s.shock, 18), spot: toNumber(s.spot, 18), payout, net: premium - payout };
  });
  const worst = Math.max(
    0,
    r.scenarios.findIndex((s) => s.shock === r.worstShock),
  );
  const wp = points[worst];
  const collDec = r.isCall ? r.tokenDecimals : r.usdgDecimals;
  const collUnit = r.isCall ? sym : "USDG";
  const sold = fmtAmount(r.sold, r.tokenDecimals, 6);
  const kind = r.isCall ? "call" : "put";
  const iv = r.impliedVol;
  const share = (r.worstShareOfCollateralBps / 100).toFixed(1);

  return (
    <div className={styles.risk} data-testid="risk-panel" data-stale={stale || undefined}>
      <p className={styles.riskLead}>
        <span className="micro micro-muted">Depositors&apos; side, live</span>
        <span>
          {sold} {sym} {kind}
          {r.sold === 10n ** BigInt(r.tokenDecimals) ? "" : "s"} sold · {sym}{" "}
          <span className="mono">{money(toNumber(r.spot, 18))}</span> · σ{" "}
          <span className="mono">{pct(r.sigma, 0)}</span>{" "}
          {r.sigmaSource === "epoch-open" ? "(the epoch's opening volatility)" : "(current volatility)"} ·{" "}
          {r.tenor > 0n ? `${fmtDuration(Number(r.tenor))} to expiry` : "expired"}
        </span>
      </p>
      {r.spotStatus !== "Ok" ? (
        <p className={styles.riskWarn} role="status">
          The price feed reports {r.spotStatus}: these numbers use its last print, not a live price.
        </p>
      ) : null}

      <dl className={styles.riskGreeks} aria-label="Greeks for the depositors">
        {GREEKS.map((g) => {
          const exp = toNumber(r.exposure[g.key as keyof Greeks], 18);
          const per = toNumber(r.greeks[g.key as keyof Greeks], 18);
          return (
            <div key={g.key} className={styles.riskGreek} data-greek={g.key}>
              <dt className="micro micro-muted">
                <Term id={g.key}>{g.label}</Term>
              </dt>
              <dd className={styles.riskValue}>
                {signed(exp, g.frac)}
                {g.unit ? <span className={styles.riskUnit}>{g.unit}</span> : null}
              </dd>
              <dd className={styles.riskLine}>{cap(rest(lines[g.key]))}</dd>
              <dd className={styles.riskPer}>
                Per option, buyer&apos;s side: <span className="mono">{signed(per, g.frac + 2)}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      {r.atCurrentSigma ? (
        <p className={styles.hint}>
          At today&apos;s σ of {pct(r.currentSigma, 0)}: delta{" "}
          {signed(toNumber(r.atCurrentSigma.exposure.delta, 18), 2)}, vega{" "}
          {signed(toNumber(r.atCurrentSigma.exposure.vega, 18), 2)}, theta{" "}
          {signed(toNumber(r.atCurrentSigma.exposure.theta, 18), 2)} a day.
        </p>
      ) : null}

      <figure className={styles.payoff} aria-labelledby={titleId}>
        <div className={styles.payoffHead}>
          <h3 id={titleId} className="micro">
            Vault result at expiry by {sym} move
          </h3>
          <div className={styles.riskToggle} role="group" aria-label="View">
            <button
              type="button"
              className="chip"
              aria-pressed={view === "chart"}
              onClick={() => setView("chart")}
            >
              Chart
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={view === "table"}
              onClick={() => setView("table")}
            >
              Table
            </button>
          </div>
        </div>
        {view === "chart" ? (
          <>
            <ul className={styles.payoffLegend} aria-label="Legend">
              <li data-series="gain">Premium kept</li>
              <li data-series="loss">Net loss</li>
            </ul>
            <RiskChart symbol={sym} points={points} worst={worst} premium={premium} titleId={titleId} />
          </>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="risk-table">
              <caption className="sr-only">Vault result at expiry by {sym} move</caption>
              <thead>
                <tr>
                  <th scope="col">Move</th>
                  <th scope="col" className={styles.num}>
                    {sym} at expiry
                  </th>
                  <th scope="col" className={styles.num}>
                    Holders paid
                  </th>
                  <th scope="col" className={styles.num}>
                    Vault result
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={p.shock} data-worst={i === worst || undefined}>
                    <td className="mono">
                      {shockLabel(p.shock)}
                      {i === worst && p.payout > 0 ? <span className={styles.cellMuted}>worst</span> : null}
                      {Math.abs(p.shock) < 1e-9 ? <span className={styles.cellMuted}>now</span> : null}
                    </td>
                    <td className={`mono ${styles.num}`}>{money(p.spot)}</td>
                    <td className={`mono ${styles.num}`}>{money(p.payout)}</td>
                    <td className={`mono ${styles.num}`}>{signedMoney(p.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <figcaption className={styles.payoffCaption}>
          {wp && wp.payout > 0 ? (
            <>
              Worst case on this grid: {sym} {shockLabel(wp.shock)} to {money(wp.spot)} pays holders{" "}
              {money(wp.payout)}, {signedMoney(wp.net)} after the {money(premium)} premium. The vault has{" "}
              <strong>
                {fmtAmount(r.collateral, collDec, 6)} {collUnit}
              </strong>{" "}
              locked for these options; that payout is{" "}
              <strong>
                {fmtAmount(r.worstPayout, collDec, 6)} {collUnit}
              </strong>
              , {share}% of it
              {r.isCall ? `, paid in ${sym} rather than dollars, so it is not drawn on this axis` : ""}.
            </>
          ) : (
            <>
              No move on this grid makes the vault pay holders: it keeps the {money(premium)} premium. The
              collateral locked is {fmtAmount(r.collateral, collDec, 6)} {collUnit}.
            </>
          )}{" "}
          <span className={styles.payoffNote}>
            The option leg only:{" "}
            {r.isCall
              ? `the ${sym} the depositors hold moves with it too.`
              : "the USDG collateral does not move."}
          </span>
        </figcaption>
      </figure>

      <p className={styles.riskIv}>
        <span className="micro micro-muted">
          <Term id="impliedVol">Implied volatility</Term> of the last buy
        </span>
        {iv ? (
          <span>
            <strong className="mono">{pct(iv.sigma, 2)}</strong>: the σ at which the engine&apos;s own price
            equals the <span className="mono">{money(toNumber(iv.pricePaid, 18), 4)}</span> paid per option
            (at {sym} <span className="mono">{money(toNumber(iv.spot, 18))}</span> plus the{" "}
            {(iv.spotBufferBps / 100).toFixed(1)}% <Term id="spotBuffer">spot buffer</Term>,{" "}
            {fmtDuration(Number(iv.tenor))} out)
            {Math.abs(toNumber(iv.sigma - r.sigma, 18)) < 0.0005
              ? `, which recovers the ${pct(r.sigma, 0)} the contract priced it with.`
              : "."}
          </span>
        ) : (
          <span>Not available: {r.impliedVolNote}.</span>
        )}
      </p>

      <RiskSource r={r} chainId={chainId} deployment={deployment} />
    </div>
  );
}

/** An address linked to the chain's explorer, shortened, with the full address on hover. */
function AddressLink({ chainId, address }: { chainId: AppChainId; address: string }) {
  const url = explorerUrl(chainId, "address", address);
  const label = <span className="mono">{shortAddr(address)}</span>;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-link" title={address}>
      {label} <ArrowUpRight size={11} aria-hidden />
    </a>
  ) : (
    <span title={address}>{label}</span>
  );
}

const sameAddr = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * Which contracts computed the panel, on which chain, and which protocol version the series belongs to: all from
 * the SDK's result (the vault's EpochManager against the deployment map, and whether RiskLens answered).
 */
function RiskSource({
  r,
  chainId,
  deployment,
}: {
  r: SeriesRisk;
  chainId: AppChainId;
  deployment: Deployment | null;
}) {
  const chain = CHAIN_META[chainId]?.label ?? `chain ${r.chainId}`;
  const stylus =
    sameAddr(deployment?.stylusPricer, r.riskEngine) || sameAddr(deployment?.riskEngine, r.riskEngine);
  const engineName = stylus ? "the Stylus (Rust) risk engine" : "the risk engine";
  const iv = r.impliedVol;
  const fn = (name: string) => <code className="mono">{name}</code>;
  const em = <AddressLink chainId={chainId} address={r.epochManager} />;

  return (
    <p
      className={styles.riskFoot}
      data-testid="risk-source"
      data-source={r.source}
      data-version={r.version ?? "unknown"}
      data-chain={r.chainId}
    >
      {r.source === "riskLens" && r.riskLens ? (
        <>
          Computed live on {chain} through RiskLens (v3) at{" "}
          <AddressLink chainId={chainId} address={r.riskLens} /> ({fn(r.riskLensFunction ?? "seriesRisk")}),
          which called {engineName} at <AddressLink chainId={chainId} address={r.riskEngine} />, the
          EpochManager&apos;s pricer ({fn("greeks")}, {fn("scenarioLoss")})
          {iv ? <>; {fn("impliedVol")} is called on the engine directly</> : null}.
        </>
      ) : (
        <>
          Computed live on {chain} by {engineName} at <AddressLink chainId={chainId} address={r.riskEngine} />{" "}
          ({fn("greeks")}, {fn("scenarioLoss")}
          {iv ? <>, {fn("impliedVol")}</> : null}), called directly.
        </>
      )}{" "}
      {r.version === "v2" ? (
        <>
          A v2 series: the vault&apos;s EpochManager {em} is the v2 deployment. v2&apos;s pricer has no risk
          functions and v2 has no RiskLens, so this is the v3 engine, deployed next to v2.
        </>
      ) : r.version === "v3" ? (
        <>A v3 series: the vault&apos;s EpochManager {em} is the v3 deployment.</>
      ) : r.version ? (
        <>
          A {r.version} series: the vault&apos;s EpochManager is {em}.
        </>
      ) : (
        <>
          The vault&apos;s EpochManager {em} is not in the app&apos;s deployment map, so its version is not
          known.
        </>
      )}
    </p>
  );
}
