"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection } from "wagmi";
import { DEFAULT_CHAIN_ID, isAppChainId, type AppChainId } from "@/lib/chains";

interface ChainState {
  chainId: AppChainId;
  /** False until the saved or linked network has been read (avoids flashing the default network). */
  ready: boolean;
  setChainId: (id: AppChainId) => void;
}

const ChainContext = createContext<ChainState | null>(null);
const KEY = "strike.chain";

function load(): AppChainId | null {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get("chain");
    const id = Number(fromUrl ?? window.localStorage.getItem(KEY));
    return isAppChainId(id) ? id : null;
  } catch {
    return null;
  }
}

function save(id: AppChainId) {
  try {
    window.localStorage.setItem(KEY, String(id));
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
}

/** The network the app reads from. Follows the wallet when it is connected to a supported network. */
export function ChainProvider({ children }: { children: ReactNode }) {
  const [chainId, setState] = useState<AppChainId>(DEFAULT_CHAIN_ID);
  const [ready, setReady] = useState(false);
  const { chainId: walletChainId, isConnected } = useConnection();

  useEffect(() => {
    const saved = load();
    if (saved) {
      setState(saved);
      save(saved);
    }
    setReady(true);
  }, []);

  const setChainId = useCallback((id: AppChainId) => {
    setState(id);
    save(id);
  }, []);

  useEffect(() => {
    if (isConnected && isAppChainId(walletChainId)) setChainId(walletChainId);
  }, [isConnected, walletChainId, setChainId]);

  const value = useMemo(() => ({ chainId, ready, setChainId }), [chainId, ready, setChainId]);
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChainState(): ChainState {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("useChainState outside ChainProvider");
  return ctx;
}
