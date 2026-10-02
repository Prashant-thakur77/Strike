import { EPOCH_STATES } from "@/lib/labels";
import styles from "./app.module.css";

/** The epoch state on chain; `expired` marks a Selling epoch whose series is past expiry and not settled yet. */
export function StateTag({
  state,
  expired = false,
  withText = false,
  large = false,
}: {
  state: number;
  expired?: boolean;
  withText?: boolean;
  large?: boolean;
}) {
  const s = EPOCH_STATES[state] ?? EPOCH_STATES[0];
  const past = expired && state === 2;
  return (
    <span
      className={styles.state}
      data-state={s.name}
      data-expired={past || undefined}
      data-large={large || undefined}
      title={past ? "Selling on chain, past expiry: waiting for the settlement price" : undefined}
    >
      <span className={styles.stateDot} aria-hidden />
      <span className="micro">{past ? "Expired, settling" : s.name}</span>
      {withText ? (
        <span className={styles.stateText}>
          {past ? "Locked · waiting for the settlement price" : s.text}
        </span>
      ) : null}
    </span>
  );
}
