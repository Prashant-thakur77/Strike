"use client";

import { CircleCheck, CircleX } from "lucide-react";
import { PRESETS, type Preset, type PresetId } from "@/lib/playground";
import styles from "./playground.module.css";

interface PresetsProps {
  active: PresetId | null;
  disabled: boolean;
  onPick: (preset: Preset) => void;
}

/** Four one-click proposals: one the contract accepts, three it rejects for different rules. */
export function Presets({ active, disabled, onPick }: PresetsProps) {
  return (
    <div className={styles.presets} role="group" aria-label="Preset proposals">
      {PRESETS.map((p) => {
        const ok = p.expect === "None";
        return (
          <button
            key={p.id}
            type="button"
            className={styles.preset}
            aria-pressed={active === p.id}
            disabled={disabled}
            onClick={() => onPick(p)}
            data-preset={p.id}
          >
            <span className="micro micro-muted">{p.who}</span>
            <span className={styles.presetTitle}>{p.title}</span>
            <span className={styles.presetNote}>{p.note}</span>
            <span className={styles.expect} data-tone={ok ? "ok" : "bad"}>
              {ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
              Expect {ok ? "Accepted" : p.expect}
            </span>
          </button>
        );
      })}
    </div>
  );
}
