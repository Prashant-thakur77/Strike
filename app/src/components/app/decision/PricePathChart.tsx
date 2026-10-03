"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { oneSigmaRange, priceAt, pricePath, type AuditRound } from "@/lib/pricePath";
import { Skeleton } from "../Skeleton";
import appStyles from "../app.module.css";
import styles from "./decision.module.css";
import { TableWrap } from "../TableWrap";

const M = { top: 30, right: 18, bottom: 46, left: 64 };
const HEIGHT = 300;
const usd = (n: number, frac = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

interface AuditJson {
  feeds?: { symbol: string; rounds: AuditRound[] }[];
  error?: string;
}

async function getAudit(chainId: number): Promise<AuditJson> {
  const res = await fetch(`/api/mirror-audit?chain=${chainId}`);
  const body = (await res.json().catch(() => null)) as AuditJson | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** The underlying's price around the epoch, with the strike, the break-even and the model's one-sigma range. */
export function PricePathChart({
  chainId,
  symbol,
  openedAt,
  expiry,
  spot,
  sigma,
  strike,
  breakEven,
}: {
  chainId: number;
  symbol: string;
  openedAt: number;
  expiry: number;
  spot: number;
  sigma: number;
  strike: number;
  breakEven: number;
}) {
  const q = useQuery({
    queryKey: ["mirror-audit", chainId],
    queryFn: () => getAudit(chainId),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(280, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [q.isSuccess]);

  if (q.isPending) return <Skeleton width="60%" />;
  if (q.isError) {
    return (
      <p className={appStyles.hint} data-testid="price-path-error">
        The price rounds could not be read right now ({q.error instanceof Error ? q.error.message : "error"}).
      </p>
    );
  }
  const rounds = q.data.feeds?.find((f) => f.symbol === symbol)?.rounds ?? [];
  const path = pricePath(rounds, openedAt, expiry);
  if (path.points.length === 0) {
    return (
      <p className={appStyles.hint} data-testid="price-path-empty">
        No {symbol} round on this chain&apos;s feed between a day before the epoch opened and three days after
        expiry.
      </p>
    );
  }
  const band = oneSigmaRange(spot, sigma, expiry - openedAt);
  const pts = path.points;
  const tLo = Math.min(openedAt, pts[0]!.t);
  const tHi = Math.max(expiry, pts.at(-1)!.t);
  const values = [...pts.map((p) => p.price), strike, breakEven, band.low, band.high, spot];
  const vPad = (Math.max(...values) - Math.min(...values)) * 0.08;
  const yLo = Math.min(...values) - vPad;
  const yHi = Math.max(...values) + vPad;
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - tLo) / (tHi - tLo)) * w;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * h;
  // A feed holds its last price until the next round: draw steps, not slopes.
  const d = pts.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.price)}` : `H${x(p.t)}V${y(p.price)}`)).join("");
  const yStep = (yHi - yLo) / 5;
  const yTicks = Array.from({ length: 6 }, (_, i) => yLo + i * yStep);
  const xTicks: number[] = [];
  for (let t = Math.ceil(tLo / 86_400) * 86_400; t <= tHi; t += 86_400) xTicks.push(t);
  const xShown = xTicks.filter((_, i) => xTicks.length <= (width < 480 ? 4 : 9) || i % 2 === 0);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    if (px < M.left || px > M.left + w) return setHover(null);
    setHover(tLo + ((px - M.left) / w) * (tHi - tLo));
  }
  const hp = hover === null ? null : priceAt(pts, hover);
  const matched = pts.length - path.unmatched;

  return (
    <figure
      className={`${appStyles.payoff} ${styles.pathFigure}`}
      aria-labelledby={titleId}
      data-testid="price-path"
      data-rounds={pts.length}
    >
      <div className={appStyles.payoffHead}>
        <h3 id={titleId} className="micro">
          {symbol} on this chain&apos;s feed, around the epoch
        </h3>
      </div>
      <div ref={wrap} className={appStyles.payoffPlot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <rect
            x={x(openedAt)}
            width={Math.max(0, x(expiry) - x(openedAt))}
            y={y(band.high)}
            height={Math.max(0, y(band.low) - y(band.high))}
            className={styles.band}
          />
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={M.left + w} y1={y(t)} y2={y(t)} className={appStyles.pGrid} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={appStyles.pTick}>
                {usd(t, 0)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + w} y1={M.top + h} y2={M.top + h} className={appStyles.pAxis} />
          {xShown.map((t) => (
            <text key={`x${t}`} x={x(t)} y={M.top + h + 18} textAnchor="middle" className={appStyles.pTick}>
              {day(t)}
            </text>
          ))}
          <text x={M.left + w / 2} y={HEIGHT - 6} textAnchor="middle" className={appStyles.pAxisTitle}>
            Date (UTC)
          </text>
          <line x1={M.left} x2={M.left + w} y1={y(strike)} y2={y(strike)} className={appStyles.pStrike} />
          <text x={M.left + w - 4} y={y(strike) - 6} textAnchor="end" className={appStyles.pMark}>
            Strike {usd(strike)}
          </text>
          <line
            x1={M.left}
            x2={M.left + w}
            y1={y(breakEven)}
            y2={y(breakEven)}
            className={appStyles.pBreakeven}
          />
          <text x={M.left + 4} y={y(breakEven) + (breakEven < strike ? 14 : -6)} className={appStyles.pMark}>
            Break-even {usd(breakEven)}
          </text>
          <line x1={x(openedAt)} x2={x(openedAt)} y1={M.top} y2={M.top + h} className={appStyles.pSpot} />
          <line x1={x(expiry)} x2={x(expiry)} y1={M.top} y2={M.top + h} className={appStyles.pSpot} />
          <text x={x(expiry) - 4} y={M.top - 8} textAnchor="end" className={appStyles.pMarkMuted}>
            Expiry
          </text>
          <text x={x(openedAt) + 4} y={M.top - 8} className={appStyles.pMarkMuted}>
            Epoch open
          </text>
          <path d={d} className={appStyles.pBuyer} />
          {pts.map((p) => (
            <circle
              key={p.t}
              cx={x(p.t)}
              cy={y(p.price)}
              r={p.matched ? 2.5 : 4}
              className={p.matched ? styles.dotMatched : styles.dotUnmatched}
            />
          ))}
          {hover !== null && hp ? (
            <g className={appStyles.pHover} aria-hidden>
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + h} />
              <circle cx={x(hover)} cy={y(hp.price)} r={4} />
            </g>
          ) : null}
        </svg>
        {hover !== null && hp ? (
          <div
            className={appStyles.pTip}
            style={{ left: Math.min(Math.max(x(hover), 90), width - 90) }}
            aria-hidden
          >
            <strong>
              {symbol} {usd(hp.price)}
            </strong>
            <span>round of {utc(hp.t)}</span>
            <span>{hp.matched ? "matches mainnet Chainlink" : `audit: ${hp.status}`}</span>
          </div>
        ) : null}
      </div>
      <figcaption id={descId} className={appStyles.payoffCaption}>
        Every round the contracts could read, from a day before the epoch opened to three days after expiry:{" "}
        {pts.length} round{pts.length === 1 ? "" : "s"}, {matched} of them checked against the mainnet
        Chainlink round with the same timestamp by the price mirror audit
        {path.unmatched ? ` (${path.unmatched} not matched, drawn larger)` : ""}. The shaded box is the
        pricing model&apos;s one-sigma range at expiry, {usd(band.low)} to {usd(band.high)}, from the{" "}
        {usd(spot)} snapshot and σ {(sigma * 100).toFixed(0)}%: a model range, not a forecast. The feed copies
        prints when the keeper runs, so it can miss some; the settlement uses the first mainnet print at or
        after expiry.
      </figcaption>
      <details className={appStyles.payoffTable}>
        <summary className="micro">Show as a table</summary>
        <TableWrap stack>
          <table className={appStyles.table}>
            <thead>
              <tr>
                <th scope="col">Round time</th>
                <th scope="col" className={appStyles.num}>
                  {symbol}
                </th>
                <th scope="col">Audit</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.t} data-testid="price-path-row">
                  <td className="mono">{utc(p.t)}</td>
                  <td className={`mono ${appStyles.num}`}>{usd(p.price, 3)}</td>
                  <td>{p.matched ? "matches mainnet" : p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
    </figure>
  );
}
