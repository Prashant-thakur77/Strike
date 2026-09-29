"use client";

import { useId } from "react";
import { fmtAmount } from "@/lib/format";
import styles from "./app.module.css";

interface AmountFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  decimals: number;
  max?: bigint;
  maxLabel?: string;
  disabled?: boolean;
  /** Smaller figures, for secondary forms. */
  compact?: boolean;
}

export function AmountField({
  label,
  value,
  onChange,
  unit,
  decimals,
  max,
  maxLabel = "Max",
  disabled,
  compact,
}: AmountFieldProps) {
  const id = useId();
  return (
    <div className={compact ? `field ${styles.fieldCompact}` : "field"}>
      <div className={styles.fieldTop}>
        <label htmlFor={id} className="micro micro-muted">
          {label}
        </label>
        {max !== undefined ? (
          <button
            type="button"
            className={`micro ${styles.maxBtn}`}
            disabled={disabled}
            onClick={() => onChange(trimZeros(max, decimals))}
          >
            {maxLabel} {fmtAmount(max, decimals, 4)}
          </button>
        ) : null}
      </div>
      <div className="input-row">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
        />
        <span className="unit">{unit}</span>
      </div>
    </div>
  );
}

function trimZeros(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
