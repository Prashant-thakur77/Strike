"use client";

import Link from "next/link";
import { usdgDripAbi } from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { useConnection } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { DRIP_AMOUNT, dripErrorMessage, dripOf, dripState, fmtAgain } from "@/lib/drip";
import { fmtAmount } from "@/lib/format";
import { LINKS } from "@/lib/links";
import { AddressLink } from "../AddressLink";
import { Skeleton } from "../Skeleton";
import { TxNote } from "../TxNote";
import appStyles from "../app.module.css";
import styles from "./drip.module.css";

/** The chain's team USDG faucet: what is left, and when the connected wallet can drip next. */
export function useDrip() {
  const { client, chainId, ready } = useStrike();
  const { address } = useConnection();
  const has = !!dripOf(chainId);
  return useQuery({
    queryKey: ["strike", chainId, "drip", address],
    enabled: ready && !!client && has,
    queryFn: () => dripState(client!, chainId, address),
    refetchInterval: 30_000,
  });
}

/** Send drip(): simulated first, so TooSoon and Empty come back in plain words before the wallet opens. */
function useDripTx() {
  const { client, chainId } = useStrike();
  const { address } = useConnection();
  const tx = useTx();
  const f = dripOf(chainId);
  const send = () =>
    tx.exec("Get 10 test USDG", async (w) => {
      const call = { address: f!.drip, abi: usdgDripAbi, functionName: "drip" } as const;
      try {
        await client!.simulateContract({ ...call, account: address });
      } catch (err) {
        throw new Error(dripErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)));
      }
      return w({ ...call, chainId });
    });
  return { tx, send };
}

/** The faucet page's action for USDG: "Get 10 test USDG", or when this wallet can next. */
export function DripButton() {
  const { isConnected } = useConnection();
  const drip = useDrip();
  const { tx, send } = useDripTx();
  const s = drip.data;
  if (!isConnected) return <span className={appStyles.cellMuted}>Connect to get USDG</span>;
  const waiting = !!s && s.nextAt > 0;
  const empty = !!s && s.remaining < DRIP_AMOUNT;
  return (
    <div className={appStyles.faucetRow}>
      <button
        type="button"
        className="pill pill-small"
        disabled={!s || tx.busy || waiting || empty}
        onClick={send}
        aria-describedby={waiting ? "drip-next" : undefined}
      >
        {waiting ? `Again at ${fmtAgain(s.nextAt)}` : empty ? "Faucet empty" : "Get 10 test USDG"}
      </button>
      {waiting ? (
        <p id="drip-next" className={appStyles.cellMuted} role="status">
          Claimed. Next 10 USDG for this wallet: {fmtAgain(s.nextAt)}.
        </p>
      ) : null}
      <TxNote tx={tx} />
    </div>
  );
}

/** Below the balances: what the faucet is, what is left in it, and where gas comes from. */
export function DripSummary() {
  const { chainId } = useStrike();
  const drip = useDrip();
  const f = dripOf(chainId);
  if (!f) return null;
  const s = drip.data;
  return (
    <div className={styles.summary} aria-label="Strike USDG faucet">
      <p className={styles.remaining}>
        <span className="micro micro-muted">Strike faucet</span>
        <span className="mono" data-testid="drip-remaining">
          {s ? (
            `${fmtAmount(s.remaining, 6)} USDG left`
          ) : drip.isError ? (
            "unavailable"
          ) : (
            <Skeleton width="7em" />
          )}
        </span>
        <span className={appStyles.cellMuted}>10 USDG per wallet every 24 hours</span>
      </p>
      <p className={appStyles.hint}>
        Testnet USDG has no value. This faucet is ours: a contract the team refills (
        <AddressLink address={f.drip} />
        ), so you can try Strike even when the Paxos faucet is slow. The transaction needs a little gas: get
        testnet ETH from the{" "}
        <a href={LINKS.robinhoodFaucet} target="_blank" rel="noreferrer" className="text-link">
          Robinhood Chain faucet <ArrowUpRight size={12} aria-hidden />
        </a>{" "}
        first.
      </p>
    </div>
  );
}

/** Vault pages: a small "Get 10 test USDG" when the connected wallet holds less than 10 USDG. */
export function DripNudge() {
  const { isConnected } = useConnection();
  const drip = useDrip();
  const { tx, send } = useDripTx();
  const s = drip.data;
  if (!isConnected || !s || (s.balance >= DRIP_AMOUNT && tx.phase !== "done")) return null;
  const waiting = s.nextAt > 0;
  const empty = s.remaining < DRIP_AMOUNT;
  return (
    <div className={styles.nudge} role="group" aria-label="Test USDG">
      <p className={styles.nudgeText}>
        {waiting
          ? `Low on USDG. This wallet's next 10 test USDG: ${fmtAgain(s.nextAt)}.`
          : empty
            ? "Low on USDG, and Strike's faucet is empty for now."
            : `This wallet holds ${fmtAmount(s.balance, 6)} USDG. Testnet USDG has no value.`}{" "}
        <Link href="/app/faucet" className="text-link">
          Faucet <ArrowRight size={12} aria-hidden />
        </Link>
      </p>
      {!waiting && !empty ? (
        <button type="button" className="pill pill-small" disabled={tx.busy} onClick={send}>
          Get 10 test USDG
        </button>
      ) : null}
      <TxNote tx={tx} />
    </div>
  );
}
