"use client";

import Link from "next/link";
import { testStockTokenAbi } from "@strike/sdk";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { parseAbi, parseUnits } from "viem";
import { useConnection } from "wagmi";
import { useFaucetTokens } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtNy } from "@/lib/format";
import { LINKS } from "@/lib/links";
import { ConnectButton } from "@/components/site/ConnectButton";
import { PageHero } from "../PageHero";
import { Skeleton } from "../Skeleton";
import { TxNote } from "../TxNote";
import styles from "../app.module.css";

// The local devnet's TestUSDG mints freely (it only exists on chain 31337).
const testUsdgAbi = parseAbi(["function faucet(uint256 amount)"]);

export function FaucetPage() {
  const { chainId, meta, deployment } = useStrike();
  const local = chainId === 31337;
  const gas =
    chainId === 421614
      ? { href: LINKS.arbSepoliaFaucet, text: "Arbitrum Sepolia faucet" }
      : { href: LINKS.robinhoodFaucet, text: "Robinhood Chain testnet faucet" };

  return (
    <>
      <PageHero
        index="03"
        label="Faucet"
        right={meta.label}
        title="Faucet"
        lead={
          <p className="lead">
            Everything here runs on test networks with test money. Three things get you going: gas, USDG and a
            stock token.
          </p>
        }
      />
      <ol className={`gutter ${styles.faucet}`}>
        <Step
          index="01"
          title="Gas"
          text={
            local
              ? "Anvil's default accounts start with 10,000 ETH. Import one into your wallet."
              : `Get testnet ETH for gas from the ${gas.text}.`
          }
        >
          {local ? null : <ExtLink href={gas.href}>{gas.text}</ExtLink>}
        </Step>
        <Step
          index="02"
          title="USDG"
          text={
            local
              ? "The local devnet uses a mintable stand-in for USDG."
              : "Paxos runs the USDG faucet. Pick the network you're on (Robinhood Chain testnet or Arbitrum Sepolia)."
          }
        >
          {local && deployment ? <MintUsdg /> : <ExtLink href={LINKS.paxosFaucet}>faucet.paxos.com</ExtLink>}
        </Step>
        <Step
          index="03"
          title="Stock tokens"
          text={
            chainId === 46630 || chainId === 4663
              ? "Robinhood's testnet faucet hands out TSLA, AMZN, PLTR, NFLX and AMD tokens along with gas."
              : "On this network Strike deploys test stock tokens with a public faucet: 10 tokens per address per day."
          }
        >
          {deployment ? (
            <StockFaucets />
          ) : (
            <p className="micro micro-muted">Not deployed on {meta.label} yet.</p>
          )}
        </Step>
        <Step
          index="04"
          title="Deposit"
          text="Put the tokens to work in a covered-call vault, or the USDG in a cash-secured-put vault."
        >
          <Link href="/app" className="pill">
            Open vaults <ArrowRight aria-hidden />
          </Link>
        </Step>
      </ol>
    </>
  );
}

function Step({
  index,
  title,
  text,
  children,
}: {
  index: string;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={styles.fStep}>
      <span className="rule" />
      <div className={styles.fGrid}>
        <span className="index">{index}</span>
        <h2 className="display-project">{title}</h2>
        <div className={styles.fBody}>
          <p className="lead">{text}</p>
          {children}
        </div>
      </div>
    </li>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="pill pill-ghost">
      {children} <ArrowUpRight aria-hidden />
    </a>
  );
}

function MintUsdg() {
  const { deployment, chainId } = useStrike();
  const { isConnected } = useConnection();
  const tx = useTx();
  if (!isConnected) return <ConnectButton />;
  return (
    <div className={styles.faucetRow}>
      <button
        type="button"
        className="pill"
        disabled={tx.busy}
        onClick={() =>
          tx.exec("Mint USDG", (w) =>
            w({
              address: deployment!.usdg,
              abi: testUsdgAbi,
              functionName: "faucet",
              args: [parseUnits("10000", 6)],
              chainId,
            }),
          )
        }
      >
        Mint 10,000 USDG
      </button>
      <TxNote tx={tx} />
    </div>
  );
}

function StockFaucets() {
  const tokens = useFaucetTokens();
  const { chainId } = useStrike();
  const { isConnected } = useConnection();
  const tx = useTx();
  if (tokens.isLoading) return <Skeleton width="12em" />;
  const list = tokens.data ?? [];
  const test = list.filter((t) => t.isTestToken);
  if (test.length === 0) {
    return <ExtLink href={LINKS.robinhoodFaucet}>Robinhood testnet faucet</ExtLink>;
  }
  if (!isConnected) return <ConnectButton />;
  return (
    <div className={styles.faucetRow}>
      <div className={styles.faucetTokens}>
        {test.map((t) => (
          <div key={t.token} className={styles.faucetToken}>
            <span className="micro micro-muted">
              {t.symbol} · you hold {fmtAmount(t.balance, t.decimals)}
            </span>
            <button
              type="button"
              className="pill"
              disabled={tx.busy || t.nextAt > 0}
              onClick={() =>
                tx.exec(`Get ${t.symbol}`, (w) =>
                  w({ address: t.token, abi: testStockTokenAbi, functionName: "faucet", chainId }),
                )
              }
            >
              {t.nextAt > 0
                ? `Again ${fmtNy(t.nextAt)}`
                : `Get ${fmtAmount(t.amount, t.decimals, 0)} ${t.symbol}`}
            </button>
          </div>
        ))}
      </div>
      <TxNote tx={tx} />
    </div>
  );
}
