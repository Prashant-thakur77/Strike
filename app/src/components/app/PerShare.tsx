import { fmtWadUsd } from "@/lib/format";
import { fmtMultiplier, hasMultiplier, perSharePrice } from "@/lib/shares";
import styles from "./app.module.css";

interface PerShareProps {
  /** Price per raw token, WAD (what the Chainlink feed and the contracts use). */
  price: bigint;
  /** The underlying's ERC-8056 `uiMultiplier` (1e18 = 1.0). */
  multiplier: bigint;
  /** Append "· multiplier 1.000775" (drop it where the multiplier is already stated nearby). */
  showMultiplier?: boolean;
}

/**
 * The per-share equivalent of a per-token price: "$380.21 per share · multiplier 1.000775". Renders nothing when
 * one token is one share, since the price shown is then already per share.
 */
export function PerShare({ price, multiplier, showMultiplier = true }: PerShareProps) {
  if (price <= 0n || !hasMultiplier(multiplier)) return null;
  return (
    <span className={styles.perShare}>
      <span className="mono">{fmtWadUsd(perSharePrice(price, multiplier))}</span>
      <span className="micro">
        per share{showMultiplier ? ` · multiplier ${fmtMultiplier(multiplier)}` : ""}
      </span>
    </span>
  );
}
