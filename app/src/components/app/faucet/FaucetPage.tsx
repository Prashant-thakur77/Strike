"use client";

import Link from "next/link";
import { testStockTokenAbi } from "@strike/sdk";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { parseAbi, parseUnits } from "viem";
import { useConnection } from "wagmi";
import { useVaults, useWalletBalances } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtNy } from "@/lib/format";
import { LINKS } from "@/lib/links";
import type { FaucetToken } from "@/lib/reads";
import { ConnectButton } from "@/components/site/ConnectButton";
import { NotDeployed } from "../NotDeployed";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import { TxNote } from "../TxNote";
import appStyles from "../app.module.css";

// The local devnet's TestUSDG mints freely (it only exists on chain 31337).
const testUsdgAbi = parseAbi(["function faucet(uint256 amount)"]);

export function FaucetPage() {
  const { chainId, meta, deployment } = useStrike();
  const { isConnected } = useConnection();
  const balances = useWalletBalances();
  const local = chainId === 31337;
  const robinhood = chainId === 46630 || chainId === 4663;
  const gas =
    chainId === 421614
      ? { href: LINKS.arbSepoliaFaucet, text: "Arbitrum Sepolia faucet" }
      : { href: LINKS.robinhoodFaucet, text: "Robinhood Chain faucet" };
  const b = balances.data;
  const vaultSymbols = new Set((useVaults().data ?? []).map((v) => v.summary.underlying.symbol));
  const stocks: { symbol: string; full: FaucetToken | null }[] = b
    ? b.stocks.map((t) => ({ symbol: t.symbol, full: t }))
    : Object.keys(deployment?.stocks ?? {}).map((symbol) => ({ symbol, full: null }));
  // Tokens with a Strike vault first.
  stocks.sort((x, y) => Number(vaultSymbols.has(y.symbol)) - Number(vaultSymbols.has(x.symbol)));

  return (
    <>
      <PageHero
        index="07"
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
      {!deployment ? (
        <NotDeployed />
      ) : (
        <div className={appStyles.detailBody}>
          <Rail
            index="01"
            label="Your test tokens"
            note={
              isConnected
                ? `Balances of the connected wallet on ${meta.label}. Top up from the faucet next to each one.`
                : "Connect a wallet to see what it holds. The faucets work without it."
            }
          >
            <div className={appStyles.panel}>
              {!isConnected ? (
                <div>
                  <ConnectButton />
                </div>
              ) : null}
              <ul
                className={appStyles.balances}
                aria-label="Test token balances"
                aria-busy={balances.isLoading}
              >
                <BalanceRow
                  name={chainId === 421614 || robinhood ? "ETH" : "Gas"}
                  what="Gas for every transaction"
                  balance={b ? fmtAmount(b.gas, 18, 4) : null}
                  connected={isConnected}
                >
                  {local ? (
                    <span className={appStyles.cellMuted}>Anvil accounts start with 10,000 ETH</span>
                  ) : (
                    <ExtLink href={gas.href}>{gas.text}</ExtLink>
                  )}
                </BalanceRow>
                <BalanceRow
                  name="USDG"
                  what="Premiums, put collateral and option purchases"
                  balance={b ? fmtAmount(b.usdg.balance, b.usdg.decimals) : null}
                  connected={isConnected}
                >
                  {local ? <MintUsdg /> : <ExtLink href={LINKS.paxosFaucet}>faucet.paxos.com</ExtLink>}
                </BalanceRow>
                {stocks.map(({ symbol, full }) => {
                  const t = { symbol };
                  return (
                    <BalanceRow
                      key={t.symbol}
                      name={t.symbol}
                      what={
                        vaultSymbols.has(t.symbol)
                          ? `Stock token for the ${t.symbol} covered-call vault`
                          : "Stock token · no Strike vault for it yet"
                      }
                      balance={full ? fmtAmount(full.balance, full.decimals) : null}
                      connected={isConnected}
                    >
                      {full?.isTestToken ? (
                        <StockFaucet token={full} />
                      ) : (
                        <ExtLink href={LINKS.robinhoodFaucet}>Robinhood faucet</ExtLink>
                      )}
                    </BalanceRow>
                  );
                })}
              </ul>
              <p className={appStyles.hint}>
                {robinhood
                  ? "Robinhood's testnet faucet hands out gas and TSLA, AMZN, PLTR, NFLX and AMD tokens. Paxos runs the USDG faucet: pick Robinhood Chain testnet there."
                  : local
                    ? "On the local devnet Strike deploys mintable test tokens: 10 stock tokens per address per day."
                    : "Paxos runs the USDG faucet: pick the network you're on there."}
              </p>
            </div>
          </Rail>
          <Rail index="02" label="Then deposit" note="Put the tokens to work.">
            <div className={appStyles.prompt}>
              <p className="body">
                A stock token goes in a covered-call vault; USDG goes in a cash-secured-put vault. Either way
                the vault pays you the weekly premium in USDG.
              </p>
              <Link href="/app" className="pill">
                Open vaults <ArrowRight aria-hidden />
              </Link>
            </div>
          </Rail>
        </div>
      )}
    </>
  );
}

function BalanceRow({
  name,
  what,
  balance,
  connected,
  children,
}: {
  name: string;
  what: string;
  balance: string | null;
  connected: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={appStyles.balance}>
      <span className={appStyles.balanceName}>
        <strong>{name}</strong>
        <span className={appStyles.cellMuted}>{what}</span>
      </span>
      <span className={`mono ${appStyles.balanceValue}`}>
        {!connected ? null : balance === null ? (
          <Skeleton width="4em" />
        ) : (
          <>
            {balance} <span className="sr-only">{name}</span>
          </>
        )}
      </span>
      <span className={appStyles.balanceAction}>{children}</span>
    </li>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`text-link ${appStyles.faucetLink}`}>
      {children} <ArrowUpRight size={12} aria-hidden />
    </a>
  );
}

function MintUsdg() {
  const { deployment, chainId } = useStrike();
  const { isConnected } = useConnection();
  const tx = useTx();
  if (!isConnected) return <span className={appStyles.cellMuted}>Connect to mint</span>;
  return (
    <div className={appStyles.faucetRow}>
      <button
        type="button"
        className="pill pill-small"
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

function StockFaucet({ token: t }: { token: FaucetToken }) {
  const { chainId } = useStrike();
  const { isConnected } = useConnection();
  const tx = useTx();
  if (!isConnected) return <span className={appStyles.cellMuted}>Connect to mint</span>;
  return (
    <div className={appStyles.faucetRow}>
      <button
        type="button"
        className="pill pill-small"
        disabled={tx.busy || t.nextAt > 0}
        onClick={() =>
          tx.exec(`Get ${t.symbol}`, (w) =>
            w({ address: t.token, abi: testStockTokenAbi, functionName: "faucet", chainId }),
          )
        }
      >
        {t.nextAt > 0 ? `Again ${fmtNy(t.nextAt)}` : `Get ${fmtAmount(t.amount, t.decimals, 0)} ${t.symbol}`}
      </button>
      <TxNote tx={tx} />
    </div>
  );
}
