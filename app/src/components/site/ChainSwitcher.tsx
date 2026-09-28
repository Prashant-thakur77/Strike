"use client";

import { ChevronDown } from "lucide-react";
import { useConnection, useSwitchChain } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { CHAIN_META, appChains, isAppChainId } from "@/lib/chains";
import { findDeployment } from "@/lib/deployment";
import styles from "./site.module.css";

/** Network picker. Reads work without a wallet; a connected wallet is asked to follow. */
export function ChainSwitcher() {
  const { chainId, setChainId, deployment } = useStrike();
  const { isConnected } = useConnection();
  const { mutate: switchChain } = useSwitchChain();

  return (
    <label className={styles.chain} data-deployed={!!deployment}>
      <span className="sr-only">Network</span>
      <span className={styles.chainDot} aria-hidden />
      <select
        value={chainId}
        onChange={(e) => {
          const id = Number(e.target.value);
          if (!isAppChainId(id)) return;
          setChainId(id);
          if (isConnected) switchChain({ chainId: id }, { onError: () => {} });
        }}
      >
        {appChains.map((c) => (
          <option key={c.id} value={c.id}>
            {CHAIN_META[c.id].label}
            {findDeployment(c.id) ? "" : " · not deployed"}
          </option>
        ))}
      </select>
      <span className={styles.chainShort} aria-hidden>
        {CHAIN_META[chainId].short}
      </span>
      <ChevronDown aria-hidden size={14} />
    </label>
  );
}
