import { EPOCH_STATES } from "@/lib/labels";
import styles from "./app.module.css";

export function StateTag({
  state,
  withText = false,
  large = false,
}: {
  state: number;
  withText?: boolean;
  large?: boolean;
}) {
  const s = EPOCH_STATES[state] ?? EPOCH_STATES[0];
  return (
    <span className={styles.state} data-state={s.name} data-large={large || undefined}>
      <span className={styles.stateDot} aria-hidden />
      <span className="micro">{s.name}</span>
      {withText ? <span className={styles.stateText}>{s.text}</span> : null}
    </span>
  );
}
