"use client";

import { useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { errorMessage } from "@/hooks/useTx";
import { shortAddr } from "@/lib/format";
import styles from "./site.module.css";

/** Injected-wallet connect (EIP-6963 wallets are listed when several are installed). */
export function ConnectButton({ block = false }: { block?: boolean }) {
  const { address, isConnected, connector } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending, error, reset } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Prefer wallets announced through EIP-6963; fall back to the generic injected connector.
  const discovered = connectors.filter((c) => c.id !== "injected");
  const options = discovered.length > 0 ? discovered : connectors;

  const onConnect = () => {
    reset();
    if (options.length === 1 && options[0]) connect({ connector: options[0] });
    else setOpen((o) => !o);
  };

  const cls = `pill pill-small ${block ? styles.block : ""}`;

  return (
    <div className={styles.wallet} ref={root}>
      {isConnected ? (
        <button
          type="button"
          className={`${cls} pill-ghost`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={styles.liveDot} aria-hidden />
          <span className="mono">{shortAddr(address)}</span>
        </button>
      ) : (
        <button type="button" className={cls} onClick={onConnect} disabled={isPending} aria-expanded={open}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {open ? (
        <div className={`theme-ink ${styles.popover}`} role="menu">
          {isConnected ? (
            <>
              <span className="micro micro-muted">Connected with {connector?.name ?? "wallet"}</span>
              <span className="mono">{shortAddr(address)}</span>
              <button
                type="button"
                role="menuitem"
                className="pill pill-small pill-ghost"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            options.map((c) => (
              <button
                key={c.uid}
                type="button"
                role="menuitem"
                className="pill pill-small pill-ghost"
                onClick={() => {
                  connect({ connector: c });
                  setOpen(false);
                }}
              >
                {c.name}
              </button>
            ))
          )}
        </div>
      ) : null}
      {error ? (
        <p className={`micro ${styles.walletError}`} role="alert">
          {/ProviderNotFound|Provider not found/i.test(error.name + error.message)
            ? "No browser wallet found"
            : errorMessage(error)}
        </p>
      ) : null}
    </div>
  );
}
