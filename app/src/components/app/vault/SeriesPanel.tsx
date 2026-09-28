"use client";

import { useMarket } from "@/hooks/queries";
import { fmtAmount, fmtBps, fmtDuration, fmtNy, fmtWadUsd, toNumber } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { hasMultiplier } from "@/lib/shares";
import { PerShare } from "../PerShare";
import { BuyPanel } from "./BuyPanel";
import styles from "../app.module.css";

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
      <BuyPanel vault={vault} series={s} />
    </div>
  );
}
