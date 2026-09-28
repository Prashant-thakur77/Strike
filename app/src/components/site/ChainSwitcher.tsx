"use client";

import { ChevronDown } from "lucide-react";
import { useConnection, useSwitchChain } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { CHAIN_META, appChains, isAppChainId } from "@/lib/chains";
import { findDeployment } from "@/lib/deployment";
import styles from "./site.module.css";

/**
 * Network picker. Reads work without a wallet; a connected wallet is asked to follow. `block` is the full-width
 * version for the mobile menu: full network name, 44px tall.
 */
export function ChainSwitcher({ block = false }: { block?: boolean }) {
  const { chainId, setChainId, deployment } = useStrike();
  const { isConnected } = useConnection();
  const { mutate: switchChain } = useSwitchChain();

  return (
    <label className={`${styles.chain} ${block ? styles.chainBlock : ""}`} data-deployed={!!deployment}>
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
        {block ? CHAIN_META[chainId].label : CHAIN_META[chainId].short}
      </span>
      <ChevronDown aria-hidden size={14} />
    </label>
  );
}
