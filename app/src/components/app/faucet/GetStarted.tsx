"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { useRef, useState } from "react";
import { formatEther } from "viem";
import { useConnection } from "wagmi";
import { useAllVaults, useWalletBalances } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { explorerUrl } from "@/lib/chains";
import { DRIP_AMOUNT, dripOf, gasDripOf } from "@/lib/drip";
import {
  GAS_DRIP_DAILY_CAP,
  GAS_DRIP_LIMITS,
  type GasDripResult,
  type GasDripStatus,
  gasDripMessage,
  solvePow,
} from "@/lib/gasDrip";
import { LINKS } from "@/lib/links";
import { ConnectButton } from "@/components/site/ConnectButton";
import { AddressLink } from "../AddressLink";
import { DripButton } from "./UsdgDrip";
import appStyles from "../app.module.css";
import styles from "./drip.module.css";

/** Below this the wallet counts as having no gas: about one transaction on Arbitrum Sepolia today. */
const GAS_ENOUGH = 20_000_000_000_000n;

/** GET /api/gas-drip for the connected wallet: the drip's numbers, whether it qualifies, and its challenge. */
export function useGasDripStatus() {
  const { chainId } = useStrike();
  const { address } = useConnection();
  const has = !!gasDripOf(chainId);
  return useQuery({
    queryKey: ["strike", chainId, "gas-drip", address],
    enabled: has,
    refetchInterval: 60_000,
    queryFn: async (): Promise<GasDripStatus> => {
      const q = new URLSearchParams({ chainId: String(chainId) });
      if (address) q.set("address", address);
      const res = await fetch(`/api/gas-drip?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`gas drip ${res.status}`);
      return (await res.json()) as GasDripStatus;
    },
  });
}

type Phase =
  | { k: "idle" }
  | { k: "work"; hashes: number }
  | { k: "send" }
  | { k: "done"; txHash: string }
  | { k: "error"; message: string };

/** The starter-gas step's button: solve the challenge in the browser, then ask the route to relay the drip. */
function StarterGasButton({ status, onDone }: { status: GasDripStatus; onDone: () => void }) {
  const { chainId } = useStrike();
  const { address } = useConnection();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const honeypot = useRef<HTMLInputElement>(null);
  const busy = phase.k === "work" || phase.k === "send";

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !status.challenge) return;
    setPhase({ k: "work", hashes: 0 });
    const nonce = await solvePow(status.challenge, status.difficulty, {
      onProgress: (hashes) => setPhase({ k: "work", hashes }),
    });
    if (nonce === null) return setPhase({ k: "idle" });
    setPhase({ k: "send" });
    try {
      const res = await fetch("/api/gas-drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId, address, nonce, website: honeypot.current?.value ?? "" }),
      });
      const r = (await res.json()) as GasDripResult;
      if (r.ok) {
        setPhase({ k: "done", txHash: r.txHash });
        onDone();
      } else setPhase({ k: "error", message: r.message });
    } catch {
      setPhase({ k: "error", message: gasDripMessage("Unavailable") });
    }
  }

  const link = phase.k === "done" ? explorerUrl(chainId, "tx", phase.txHash) : null;
  return (
    <form className={appStyles.faucetRow} onSubmit={go} aria-label="Starter gas">
      {/* Honeypot: hidden from people and from assistive tech; a bot that fills it is refused. */}
      <input
        ref={honeypot}
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        className={styles.honeypot}
        defaultValue=""
      />
      <button type="submit" className="pill pill-small" disabled={busy || phase.k === "done"}>
        {phase.k === "work"
          ? "Anti-bot check…"
          : phase.k === "send"
            ? "Sending…"
            : `Get ${formatEther(BigInt(status.amount))} test ETH`}
      </button>
      {phase.k === "work" ? (
        <p className={appStyles.txNote} role="status">
          Working in your browser so bots pay for their requests: {phase.hashes.toLocaleString("en-US")}{" "}
          hashes
        </p>
      ) : phase.k === "send" ? (
        <p className={appStyles.txNote} role="status">
          Strike&apos;s relayer is sending it: waiting for the block…
        </p>
      ) : phase.k === "done" ? (
        <p className={appStyles.txNote} data-phase="done" role="status">
          Starter gas sent.{" "}
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="text-link">
              View <ArrowUpRight size={12} aria-hidden />
            </a>
          ) : null}
        </p>
      ) : phase.k === "error" ? (
        <p className={appStyles.txNote} data-phase="error" role="alert">
          {phase.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The first-run path at the top of the faucet page: connect, starter gas (relayed, so a new wallet needs nothing
 * first), 10 test USDG, then a deposit. Each step reads the wallet and ticks itself off.
 */
export function GetStarted() {
  const { chainId, meta } = useStrike();
  const { isConnected } = useConnection();
  const qc = useQueryClient();
  const balances = useWalletBalances();
  const vaults = useAllVaults();
  const status = useGasDripStatus();
  const gasDrip = gasDripOf(chainId);
  const usdgDrip = dripOf(chainId);
  if (!gasDrip) return null;

  const b = balances.data;
  const s = status.data;
  const hasGas = !!b && b.gas >= GAS_ENOUGH;
  const hasUsdg = !!b && b.usdg.balance >= DRIP_AMOUNT;
  const putVault = (vaults.data ?? []).find((v) => !v.summary.isCall);
  const faucet = chainId === 421614 ? LINKS.arbSepoliaFaucet : LINKS.robinhoodFaucet;
  const refresh = () => {
    // The relayer waited for the block, so the new balance is readable now.
    void qc.invalidateQueries({ queryKey: ["strike", chainId] });
  };

  const steps: { id: string; title: string; done: boolean; body: React.ReactNode }[] = [
    {
      id: "connect",
      title: "Connect a wallet",
      done: isConnected,
      body: isConnected ? <span className={appStyles.cellMuted}>Connected.</span> : <ConnectButton />,
    },
    {
      id: "gas",
      title: "Get starter gas",
      done: hasGas,
      body: !isConnected ? (
        <span className={appStyles.cellMuted}>After you connect.</span>
      ) : hasGas ? (
        <span className={appStyles.cellMuted}>
          This wallet holds {formatEther(b!.gas).slice(0, 8)} ETH: enough to start.
        </span>
      ) : !s ? (
        <span className={appStyles.cellMuted}>
          {status.isError ? gasDripMessage("Unavailable") : "Checking…"}
        </span>
      ) : s.eligible && s.challenge ? (
        <StarterGasButton status={s} onDone={refresh} />
      ) : (
        <div className={appStyles.faucetRow}>
          <p className={appStyles.cellMuted} role="status">
            {s.message ?? gasDripMessage("Unavailable")}
          </p>
          <a href={faucet} target="_blank" rel="noreferrer" className={`text-link ${appStyles.faucetLink}`}>
            {meta.label} faucet <ArrowUpRight size={12} aria-hidden />
          </a>
        </div>
      ),
    },
    {
      id: "usdg",
      title: "Get 10 test USDG",
      done: hasUsdg,
      body: !isConnected ? (
        <span className={appStyles.cellMuted}>After you connect.</span>
      ) : hasUsdg ? (
        <span className={appStyles.cellMuted}>This wallet holds enough USDG for a first deposit.</span>
      ) : !hasGas ? (
        <span className={appStyles.cellMuted}>After the gas: claiming is a transaction you sign.</span>
      ) : usdgDrip ? (
        <DripButton />
      ) : (
        <a href={LINKS.paxosFaucet} target="_blank" rel="noreferrer" className="text-link">
          faucet.paxos.com <ArrowUpRight size={12} aria-hidden />
        </a>
      ),
    },
    {
      id: "deposit",
      title: "Deposit in a vault",
      done: false,
      body: (
        <Link
          href={putVault ? `/app/vault/${putVault.summary.address}` : "/app"}
          className={hasUsdg ? "pill pill-small" : "text-link"}
        >
          {putVault ? `Open the ${putVault.summary.underlying.symbol} put vault` : "Open vaults"}{" "}
          <ArrowRight size={12} aria-hidden />
        </Link>
      ),
    },
  ];
  const current = steps.findIndex((x) => !x.done);

  return (
    <section className={styles.start} aria-labelledby="get-started" id="start">
      <h2 id="get-started" className={styles.startHead}>
        Get started with no test ETH
      </h2>
      <ol className={styles.steps}>
        {steps.map((x, i) => (
          <li
            key={x.id}
            className={styles.step}
            data-testid={`start-${x.id}`}
            data-state={x.done ? "done" : i === current ? "current" : "next"}
            aria-current={i === current ? "step" : undefined}
          >
            <span className={styles.stepIndex} aria-hidden>
              {x.done ? <Check size={14} /> : String(i + 1).padStart(2, "0")}
            </span>
            <strong className={styles.stepTitle}>
              {x.title}
              {x.done ? <span className="sr-only"> (done)</span> : null}
            </strong>
            <span className={styles.stepBody}>{x.body}</span>
          </li>
        ))}
      </ol>
      <div className={styles.limits} data-testid="gas-drip-limits">
        <span className="micro micro-muted">Starter gas limits</span>
        <ul>
          <li>
            {formatEther(BigInt(s?.amount ?? "100000000000000"))} test ETH, once per wallet, only to wallets
            holding less than that
          </li>
          <li>
            {s ? `${s.dripsLeftToday} of ${s.dailyCap}` : `Up to ${GAS_DRIP_DAILY_CAP}`} drips left today for
            everyone (resets 00:00 UTC)
          </li>
          <li>
            {GAS_DRIP_LIMITS.perIpPerDay} per connection per day, and a few seconds of anti-bot work in your
            browser
          </li>
        </ul>
        <p className={appStyles.hint}>
          The contract enforces the first two, so they hold even if the relayer key leaked: at most{" "}
          {s ? s.dailyCap : GAS_DRIP_DAILY_CAP} drips a day. It is ours and team-funded (
          <AddressLink address={gasDrip.drip} />
          {s ? `, ${formatEther(BigInt(s.remaining)).slice(0, 7)} ETH left` : ""}); Strike&apos;s relayer
          sends it, because a wallet with no gas cannot. Testnet ETH has no value.
        </p>
      </div>
    </section>
  );
}

/** Vault pages: a one-line pointer to the starter gas when the connected wallet has (almost) no test ETH. */
export function GasNudge() {
  const { chainId } = useStrike();
  const { isConnected } = useConnection();
  const balances = useWalletBalances();
  const b = balances.data;
  if (!isConnected || !gasDripOf(chainId) || !b || b.gas >= GAS_ENOUGH) return null;
  return (
    <div className={styles.nudge} role="group" aria-label="Test ETH">
      <p className={styles.nudgeText}>
        This wallet has no test ETH for gas yet. Strike sends a new wallet its first gas, no faucet needed.{" "}
        <Link href="/app/faucet#start" className="text-link">
          Get started <ArrowRight size={12} aria-hidden />
        </Link>
      </p>
    </div>
  );
}
