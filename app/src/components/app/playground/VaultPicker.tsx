"use client";

import { Check } from "lucide-react";
import { fmtWadUsd } from "@/lib/format";
import {
  PLAYGROUND_VAULTS,
  explorerAddress,
  fmtTokens,
  nyTime,
  type PlaygroundSnapshot,
  type VaultContext,
  type VaultKey,
} from "@/lib/playground";
import { StateTag } from "../StateTag";
import { Skeleton } from "../Skeleton";
import styles from "./playground.module.css";

interface VaultPickerProps {
  value: VaultKey;
  snap: PlaygroundSnapshot | undefined;
  onChange: (key: VaultKey) => void;
}

export function VaultPicker({ value, snap, onChange }: VaultPickerProps) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className="micro micro-muted">Vault · Robinhood Chain testnet</legend>
      <div className={styles.vaults}>
        {PLAYGROUND_VAULTS.map((pv) => {
          const ctx = snap?.vaults[pv.key];
          return (
            <label key={pv.key} className={styles.vaultCard} data-tone={pv.key}>
              <input
                type="radio"
                name="playground-vault"
                value={pv.key}
                checked={value === pv.key}
                onChange={() => onChange(pv.key)}
              />
              <span className={styles.vaultTop}>
                <span className={styles.vaultName}>{pv.label}</span>
                <span className={styles.check} aria-hidden>
                  <Check />
                </span>
              </span>
              <span className={styles.vaultSub}>
                {ctx ? <StateTag state={ctx.epoch.stateCode} /> : <Skeleton width="4em" />}
                <span>
                  {ctx ? (
                    `${fmtTokens(ctx.vault.totalAssets, ctx.vault.assetDecimals)} ${ctx.vault.assetSymbol}`
                  ) : (
                    <Skeleton width="5em" />
                  )}
                </span>
              </span>
              <span className={styles.vaultSub}>
                <a
                  href={explorerAddress(pv.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono text-link"
                  title={pv.address}
                >
                  {pv.address.slice(0, 6)}…{pv.address.slice(-4)}
                </a>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Which spot the contract judges against for this vault right now, and what its epoch state means for a real proposal. */
export function EpochNote({ ctx, snap }: { ctx: VaultContext; snap: PlaygroundSnapshot }) {
  const { epoch } = ctx;
  const sigma = (w: bigint) => `${(Number(w) / 1e16).toFixed(0)}%`;
  const open = epoch.state === "Open";
  return (
    <div className={styles.epoch} aria-live="polite">
      <div className={styles.epochTop}>
        <StateTag state={epoch.stateCode} withText />
        <span className={styles.epochBasis}>
          {open ? "Judged at the opening snapshot" : "Judged at live spot"}
        </span>
      </div>
      {open ? (
        <p>
          The epoch opened {nyTime(epoch.openedAt)}. While it is Open, <code>previewProposal</code> and{" "}
          <code>proposeSeries</code> both price against the snapshot taken then:{" "}
          <strong>
            spot {fmtWadUsd(epoch.openSpot)}, σ {sigma(epoch.openSigma)}
          </strong>
          {ctx.liveSpot !== null ? ` (live spot is ${fmtWadUsd(ctx.liveSpot)})` : ""}. A price move after open
          cannot turn an honest dry run into a slash. A real proposal would get this verdict now, as long as
          the live feed is healthy (it is re-read) and, if accepted, spot has not crossed the strike since
          open (that reverts with <code>StrikeInTheMoney</code>, nobody slashed).
        </p>
      ) : (
        <p>
          Not Open, so <code>previewProposal</code> prices against{" "}
          <strong>
            live spot {ctx.liveSpot !== null ? fmtWadUsd(ctx.liveSpot) : "(unavailable: the feed reverts)"}{" "}
            and σ {sigma(ctx.vault.sigma)}
          </strong>{" "}
          from SafeStockFeed. The view has no state check, so it judges in any state; a real{" "}
          <code>proposeSeries</code> or <code>proposeByDelta</code> is only taken while the epoch is Open.
          Right now it would revert with <code>WrongState(Open, {epoch.state})</code> before the mandate is
          checked: no series, no slash.
        </p>
      )}
      {!snap.marketOpen ? (
        <p>
          <strong>NYSE is closed.</strong> The preview ignores market hours, but an Idle vault can only open
          an epoch in regular hours (<code>MarketClosed</code>), and off-hours the feed can go stale.
        </p>
      ) : null}
    </div>
  );
}
