"use client";

import { ArrowUpRight, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/hooks/useTx";
import { explorerUrl, type AppChainId } from "@/lib/chains";
import { shortAddr } from "@/lib/format";
import {
  MIRROR_CHAINS,
  MIRROR_CHAIN_NAMES,
  type MirrorAuditJson,
  type MirrorChainId,
  type MirrorRoundJson,
  fmtDuration,
  headline,
} from "@/lib/mirrorAudit";
import { Fold } from "../Fold";
import { Skeleton } from "../Skeleton";
import { useMirrorAudit } from "./useMirrorAudit";
import styles from "./mirror.module.css";

const REPO = "https://github.com/Prashant-thakur77/Strike/blob/main";

const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function Ext({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className ?? styles.link}>
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

const RESULT: Record<MirrorRoundJson["status"], string> = {
  match: "Match",
  "no-mainnet-round": "No mainnet round at this time",
  "answer-differs": "Answer differs",
  "future-timestamp": "Later than mainnet's head",
  "deploy-seed": "Deploy seed, not a mainnet price",
  unchecked: "Not checked",
};

/**
 * The price mirror audit on /app/proof: every testnet price round checked against the Robinhood Chain mainnet
 * Chainlink round it copies, from /api/mirror-audit, with what is trusted, what is verified and what the check
 * cannot catch.
 */
export function MirrorAuditPanel() {
  const [chain, setChain] = useState<MirrorChainId>(46630);
  const q = useMirrorAudit(chain);
  const a = q.data;
  return (
    <div className={styles.panel}>
      <div className={styles.chains} role="group" aria-label="Network">
        {MIRROR_CHAINS.map((id) => (
          <button
            key={id}
            type="button"
            className="chip"
            aria-pressed={chain === id}
            onClick={() => setChain(id)}
          >
            {MIRROR_CHAIN_NAMES[id]}
          </button>
        ))}
      </div>

      <div
        className={styles.verdict}
        aria-live="polite"
        data-testid="mirror-verdict"
        data-state={a ? (a.ok ? "ok" : "mismatch") : q.isError ? "error" : "loading"}
      >
        <span className="micro micro-muted">
          Checked on the server from both chains · refreshed every 10 min
        </span>
        {a ? (
          <>
            <p className={styles.headline} data-testid="mirror-headline">
              {a.ok ? "✓ " : "✗ "}
              {headline(a)}
            </p>
            <p className={styles.meta}>
              {a.chainName}, read {utc(Date.parse(a.checkedAt) / 1000)} · testnet block{" "}
              {Number(a.testnetBlock).toLocaleString("en-US")} · Robinhood Chain mainnet block{" "}
              {Number(a.mainnetBlock).toLocaleString("en-US")}
            </p>
          </>
        ) : q.isError ? (
          <>
            <p className={styles.headline}>Couldn&apos;t run the audit: {errorMessage(q.error)}</p>
            <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
              Try again <RotateCw aria-hidden />
            </button>
          </>
        ) : (
          <>
            <Skeleton width="min(26em, 100%)" />
            <Skeleton width="16em" />
          </>
        )}
      </div>

      <dl className={styles.trust} data-testid="mirror-trust">
        <div>
          <dt className="micro">Trusted</dt>
          <dd>
            When the keeper pushes. It is a scheduled job that copies the mainnet feed&apos;s latest round to
            the testnet MirrorFeed when it runs, so it decides which mainnet prints reach the testnet.
          </dd>
        </div>
        <div>
          <dt className="micro">Verified</dt>
          <dd>
            Every value it pushed. Each testnet round must equal a Robinhood Chain mainnet Chainlink round:
            same timestamp, same answer, to the last unit. An invented, edited or re-timed price fails the
            check.
          </dd>
        </div>
        <div>
          <dt className="micro">Not caught</dt>
          <dd>
            A keeper that withholds rounds: it could skip prints and push a later, real one.{" "}
            {a?.largestGap ? (
              <>
                The largest gap between pushes is <strong>{fmtDuration(a.largestGap.seconds)}</strong> (
                {a.largestGap.symbol} round {a.largestGap.fromRound} to {a.largestGap.toRound},{" "}
                {a.largestGap.mainnetRoundsBetween} mainnet print
                {a.largestGap.mainnetRoundsBetween === 1 ? "" : "s"} in between not mirrored).{" "}
              </>
            ) : null}
            For a settlement, <code className="mono">--settlement</code> also checks that the round used is
            mainnet&apos;s first print after expiry.
          </dd>
        </div>
      </dl>

      {a ? <FeedTable audit={a} /> : null}

      {a && a.mismatches.length ? (
        <div className={styles.mismatches} data-testid="mirror-mismatches">
          <h3 className={styles.title}>
            {a.mismatches.length === 1
              ? "1 round that does not match"
              : `${a.mismatches.length} rounds that do not match`}
          </h3>
          <ul>
            {a.mismatches.map((m) => (
              <li key={`${m.symbol}-${m.roundId}`}>
                {m.symbol} round {m.roundId}: {m.price} at {utc(m.updatedAt)}: {RESULT[m.status]}
                {m.mainnetPrice ? ` (mainnet ${m.mainnetRound} printed ${m.mainnetPrice})` : ""}
                {m.pushTx ? (
                  <>
                    {" "}
                    · <Ext href={explorerUrl(a.chainId as AppChainId, "tx", m.pushTx)}>push tx</Ext>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {a ? (
        <div className={styles.notes}>
          {a.seeds.length ? (
            <p className={styles.small} data-testid="mirror-seeds">
              Listed apart: round 1 of {a.seeds.map((s) => `${s.symbol} (${s.price})`).join(", ")} is the
              price <Ext href={`${REPO}/contracts/script/Deploy.s.sol`}>Deploy.s.sol</Ext> pushed when it
              created the feed, on {utc(a.seeds[0]!.updatedAt)}, before the keeper&apos;s first run. It is not
              a mainnet price and no vault opened an epoch at it; any other value in round 1 counts as a
              mismatch.
            </p>
          ) : null}
          {a.managerOracles
            .filter((m) => !m.same)
            .map((m) => (
              <p
                key={m.epochManager}
                className={`${styles.small} ${styles.bad}`}
                data-testid="mirror-manager-oracle"
              >
                The {m.version ?? ""} EpochManager reads StockOracle {m.oracle ?? "(unreadable)"}, not the
                deployment&apos;s {m.expected}: settlement does not go through the audited oracle.
              </p>
            ))}
          {a.oracleFeeds.length ? (
            <p className={styles.small} data-testid="mirror-oracles">
              {a.oracleFeeds.every((o) => o.same) ? (
                <>
                  The StockOracle of each deployment reads these MirrorFeeds for every listed token (
                  {a.oracleFeeds.length} checked with <code className="mono">feedConfig</code>), so these are
                  the prices sales and settlement use.
                </>
              ) : (
                a.oracleFeeds
                  .filter((o) => !o.same)
                  .map((o) => (
                    <span key={`${o.stockOracle}-${o.symbol}`} className={styles.bad}>
                      The {o.version ?? ""} StockOracle reads {o.symbol} from {o.feed ?? "an unreadable feed"}
                      , not the audited MirrorFeed {o.expected}.{" "}
                    </span>
                  ))
              )}
            </p>
          ) : null}
          {a.unverifiable.map((u) => (
            <p key={u.symbol} className={styles.small}>
              Not checked: {u.symbol} ({u.rounds} round{u.rounds === 1 ? "" : "s"}). {u.reason}, so no Strike
              vault settles on it.
            </p>
          ))}
        </div>
      ) : null}

      <div className={styles.run}>
        <span className="micro micro-muted">Run it yourself (no key, read-only)</span>
        <pre className={styles.cmd} tabIndex={0} aria-label="Audit command">
          <code>
            {`${a?.command ?? `node scripts/verify-mirror.mjs --chain ${chain}`}\nnode scripts/verify-mirror.mjs --chain ${chain} --settlement <vault>`}
          </code>
        </pre>
        <p className={styles.small}>
          <Ext href={`${REPO}/scripts/verify-mirror.mjs`}>verify-mirror.mjs</Ext> and this panel run the same
          check, the SDK&apos;s <Ext href={`${REPO}/sdk/src/mirror.ts`}>auditMirror</Ext>.{" "}
          <Ext href={`${REPO}/docs/trust-model.md`}>Trust model</Ext> ·{" "}
          <Ext href={`${REPO}/docs/testnet-epochs/2026-10-02-mirror-audit.md`}>first runs</Ext>
        </p>
      </div>
    </div>
  );
}

function FeedTable({ audit }: { audit: MirrorAuditJson }) {
  const chainId = audit.chainId as AppChainId;
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="mirror-feeds">
          <caption className="sr-only">Rounds checked per feed</caption>
          <thead>
            <tr>
              <th scope="col">Feed</th>
              <th scope="col" className={styles.num}>
                Rounds matching
              </th>
              <th scope="col" className={styles.num}>
                Mainnet prints mirrored
              </th>
              <th scope="col">Largest gap</th>
              <th scope="col">Contracts</th>
            </tr>
          </thead>
          <tbody>
            {audit.feeds.map((f) => (
              <tr
                key={f.testnetFeed}
                data-symbol={f.symbol}
                data-ok={f.unverifiable ? undefined : f.matched === f.checked}
              >
                <th scope="row">{f.symbol}</th>
                <td className={styles.num}>
                  {f.unverifiable ? "not checked" : `${f.matched} of ${f.checked}`}
                </td>
                <td className={styles.num}>
                  {f.unverifiable ? "–" : `${f.matched} of ${f.mainnetPrints}`}
                  {f.mainnetPrintsSince ? (
                    <span className={styles.since}> · {f.mainnetPrintsSince} since</span>
                  ) : null}
                </td>
                <td>{f.largestGap ? fmtDuration(f.largestGap.seconds) : "–"}</td>
                <td className={styles.addrs}>
                  <Ext
                    href={explorerUrl(chainId, "address", f.testnetFeed)}
                    className={`mono ${styles.addr}`}
                  >
                    <span title={f.testnetFeed}>{shortAddr(f.testnetFeed)}</span>
                  </Ext>
                  {f.mainnetFeed ? (
                    <>
                      {" ← "}
                      <Ext
                        href={explorerUrl(4663, "address", f.mainnetFeed)}
                        className={`mono ${styles.addr}`}
                      >
                        <span title={`${f.mainnetDescription ?? "Chainlink"} ${f.mainnetFeed}`}>
                          {shortAddr(f.mainnetFeed)}
                        </span>
                      </Ext>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.small}>
        &ldquo;Mainnet prints mirrored&rdquo; counts the mainnet Chainlink rounds from the keeper&apos;s first
        push to its last: the keeper runs on a schedule, so it copies some prints and not others. Every value
        it did copy is checked.
      </p>
      <Fold summary="Show every round" openSummary="Hide the rounds" closed>
        {audit.feeds
          .filter((f) => f.rounds.length)
          .map((f) => (
            <div key={f.testnetFeed} className={styles.tableWrap}>
              <table className={styles.table} aria-label={`${f.symbol} rounds`}>
                <thead>
                  <tr>
                    <th scope="col">{f.symbol} round</th>
                    <th scope="col" className={styles.num}>
                      Price
                    </th>
                    <th scope="col">Published</th>
                    <th scope="col">Mainnet round</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {f.rounds.map((r) => (
                    <tr key={r.roundId} data-status={r.status}>
                      <th scope="row">
                        {r.pushTx ? (
                          <Ext href={explorerUrl(chainId, "tx", r.pushTx)}>{r.roundId}</Ext>
                        ) : (
                          r.roundId
                        )}
                      </th>
                      <td className={`${styles.num} mono`}>{r.price}</td>
                      <td>{utc(r.updatedAt)}</td>
                      <td className="mono" title={r.mainnetRoundId ?? undefined}>
                        {r.mainnetRound ?? "–"}
                      </td>
                      <td>{RESULT[r.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        <p className={styles.small}>
          Mainnet round is phase:aggregator round; the proxy&apos;s round id is phase × 2⁶⁴ + aggregator
          round. A round number links to its push transaction.
        </p>
      </Fold>
    </>
  );
}
