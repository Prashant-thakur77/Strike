"use client";

import { blackScholes } from "@strike/sdk";
import type { ReactNode } from "react";
import { useMarket, useQuoteBuy } from "@/hooks/queries";
import { fmtAmount, fmtBps, fmtDuration, fmtNy, fmtWadUsd, toNumber } from "@/lib/format";
import { buyPrice } from "@/lib/payoff";
import type { Series, VaultSummary } from "@/lib/reads";
import { hasMultiplier } from "@/lib/shares";
import { PerShare } from "../PerShare";
import { BuyPanel } from "./BuyPanel";
import { PayoffChart } from "./PayoffChart";
import styles from "../app.module.css";

const money = (n: number, frac = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;

export function SeriesPanel({ vault }: { vault: VaultSummary }) {
  const s = vault.series;
  const market = useMarket().data;

  if (!s || vault.state !== 2) {
    return (
      <div className={styles.prompt}>
        <p className="h3">{vault.state === 1 ? "Waiting for the agent." : "No option on sale."}</p>
        <p className="body">
          {vault.state === 1
            ? "The epoch is open and the vault is locked. The agent has a day to make a proposal the mandate accepts; if it doesn't, anyone can abort the epoch and the vault unlocks."
            : "The vault is between epochs. The next one opens during US market hours, once the price feed is fresh."}
        </p>
      </div>
    );
  }

  const dec = vault.underlying.decimals;
  const sold = toNumber(s.sold, dec);
  const size = toNumber(s.size, dec);
  const left = market ? Number(s.expiry) - market.now : null;
  const scaled = hasMultiplier(vault.multiplier);
  const strike = toNumber(s.strike, 18);
  const spot = toNumber(vault.spot.price, 18);
  // What buyers actually paid, on average; before the first sale, the live quote.
  const paid = sold > 0 ? toNumber(s.premium, vault.usdg.decimals) / sold : null;

  return (
    <div className={styles.panel}>
      <div className={styles.seriesCard} data-tone={s.isCall ? "call" : "put"}>
        <div className={styles.seriesTop}>
          <span className="micro">
            {vault.underlying.symbol} {s.isCall ? "call" : "put"} · European · cash-settled
          </span>
          <span className="micro">
            {left !== null && left > 0 ? `Expires in ${fmtDuration(left)}` : "Expired"}
          </span>
        </div>
        <div className={styles.seriesStrikeWrap}>
          <p className={styles.seriesStrike}>
            <span className="micro">{scaled ? "Strike per token" : "Strike"}</span>
            {fmtWadUsd(s.strike, 2)}
          </p>
          <PerShare price={s.strike} multiplier={vault.multiplier} />
        </div>
        <dl className={styles.seriesStats}>
          <div>
            <dt className="micro micro-muted">Expiry</dt>
            <dd>{fmtNy(s.expiry)}</dd>
          </div>
          <div>
            <dt className="micro micro-muted">{scaled ? "Spot per token" : "Spot"}</dt>
            <dd>{vault.spot.price > 0n ? fmtWadUsd(vault.spot.price) : "—"}</dd>
            {scaled ? (
              <dd>
                <PerShare price={vault.spot.price} multiplier={vault.multiplier} showMultiplier={false} />
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="micro micro-muted">Price</dt>
            <dd>{fmtBps(s.premiumBps)} of fair value</dd>
          </div>
          <div>
            <dt className="micro micro-muted">Premium collected</dt>
            <dd>{fmtAmount(s.premium, vault.usdg.decimals)} USDG</dd>
          </div>
        </dl>
        <div className={styles.soldBar} aria-label={`${sold} of ${size} options sold`}>
          <span style={{ width: `${size > 0 ? Math.min(100, (sold / size) * 100) : 0}%` }} />
        </div>
        <p className={`micro ${styles.soldText}`}>
          {fmtAmount(s.sold, dec)} of {fmtAmount(s.size, dec)} sold · {fmtAmount(s.size - s.sold, dec)} left
        </p>
      </div>
      <PriceNote vault={vault} series={s} now={market?.now}>
        {(quote) =>
          spot > 0 && (paid ?? quote) ? (
            <PayoffChart
              isCall={s.isCall}
              symbol={vault.underlying.symbol}
              strike={strike}
              spot={spot}
              premium={(paid ?? quote)!}
              premiumNote={
                paid !== null
                  ? `the average buyers paid in this series, ${money(paid)} (${fmtAmount(s.premium, vault.usdg.decimals)} USDG for ${fmtAmount(s.sold, dec)} options)`
                  : `today's live quote, ${money(quote!)}`
              }
            />
          ) : null
        }
      </PriceNote>
      {s.sold < s.size ? (
        <BuyPanel vault={vault} series={s} />
      ) : (
        <div className={styles.buy}>
          <h3 className="micro">Buy options</h3>
          <p className={styles.hint}>
            <strong>Sold out.</strong> All {fmtAmount(s.size, dec)} options in this series are sold. It
            settles at expiry, {fmtNy(s.expiry)}; holders redeem after that.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * How the displayed "% of fair" becomes the buy price: fair value at the oracle spot moved `spotBufferBps` against the
 * buyer, times the premium factor, never below intrinsic value. Next to it, the contract's own quote for one option.
 */
function PriceNote({
  vault,
  series,
  now,
  children,
}: {
  vault: VaultSummary;
  series: Series;
  now: number | undefined;
  children: (quotePerOption: number | null) => ReactNode;
}) {
  const dec = vault.underlying.decimals;
  const one = 10n ** BigInt(dec);
  const quote = useQuoteBuy(series.id, one);
  const live = quote.data !== undefined ? toNumber(quote.data, vault.usdg.decimals) : null;
  const p = vault.pricing;
  const spot = toNumber(vault.spot.price, 18);
  const tenor = now !== undefined ? Number(series.expiry) - now : null;
  const model =
    p && spot > 0 && tenor !== null && tenor > 0
      ? buyPrice(
          {
            spot,
            strike: toNumber(series.strike, 18),
            tenorSeconds: tenor,
            sigma: toNumber(p.sigma, 18),
            isCall: series.isCall,
            premiumBps: series.premiumBps,
            spotBufferBps: p.spotBufferBps,
          },
          (...args) => blackScholes(...args).price,
        )
      : null;
  const buf = p ? fmtBps(p.spotBufferBps, 2) : "";

  return (
    <>
      {model && p ? (
        <section className={styles.priceNote} aria-label="How the buy price is set">
          <h3 className="micro">How the buy price is set</h3>
          <ol className={styles.priceSteps}>
            <li>
              <span className="micro micro-muted">Priced spot</span>
              <strong className="mono">{money(model.pricedSpot)}</strong>
              <span>
                oracle {money(spot)} {series.isCall ? "+" : "−"} {buf}, against the buyer
              </span>
            </li>
            <li>
              <span className="micro micro-muted">Fair value</span>
              <strong className="mono">{money(model.fair)}</strong>
              <span>
                Black-Scholes, σ {fmtBps(Number((p.sigma * 10_000n) / 10n ** 18n))}, {fmtDuration(tenor!)}{" "}
                left
              </span>
            </li>
            <li>
              <span className="micro micro-muted">× {fmtBps(series.premiumBps)} of fair</span>
              <strong className="mono">{money(model.perOption)}</strong>
              <span>
                {model.floorBinds
                  ? `raised to intrinsic value, ${money(model.intrinsic)}`
                  : `never below intrinsic value (${money(model.intrinsic)} now)`}
              </span>
            </li>
            <li>
              <span className="micro micro-muted">Live quote</span>
              <strong className="mono">{live !== null ? money(live, 4) : quote.isError ? "—" : "…"}</strong>
              <span>
                <code className="mono">quoteBuy</code> for one option
              </span>
            </li>
          </ol>
        </section>
      ) : null}
      {children(live ?? model?.perOption ?? null)}
    </>
  );
}
