import { expiryLabel, optionStatus, strikeLabel, type OptionMeta } from "./optionMeta";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A 600×600 SVG card for an option token: ink paper, the ticker huge, a payoff line, the terms in micro type. */
export function optionSvg(o: OptionMeta): string {
  const kind = o.isCall ? "CALL" : "PUT";
  const tone = o.isCall ? "#96c7d9" : "#d59f8e";
  const status = optionStatus(o).toUpperCase();
  // Payoff to the holder: flat then rising past the strike (call) or falling below it (put).
  const payoff = o.isCall ? "M40 470 L330 470 L560 250" : "M40 250 L270 470 L560 470";
  const font = "'Inter Tight', 'Helvetica Neue', Arial, sans-serif";
  const settled =
    o.settlementPrice === null ? "" : `SETTLED AT $${strikeLabel(Math.round(o.settlementPrice * 100) / 100)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="#0d0d0d"/>
  <circle cx="470" cy="140" r="260" fill="${tone}" opacity="0.12"/>
  <g font-family="${font}" fill="#e9e9e7">
    <text x="40" y="58" font-size="13" font-weight="600" letter-spacing="1.3">STRIKE · OPTION</text>
    <text x="560" y="58" font-size="13" font-weight="600" letter-spacing="1.3" text-anchor="end" fill="#75d0cb">${esc(status)}</text>
    <line x1="40" y1="76" x2="560" y2="76" stroke="#e9e9e7" stroke-opacity="0.25"/>
    <text x="34" y="220" font-size="150" font-weight="850" letter-spacing="-10">${esc(o.symbol)}</text>
    <text x="40" y="300" font-size="72" font-weight="800" letter-spacing="-4" fill="none" stroke="#e9e9e7" stroke-width="1.4">${kind}</text>
    <text x="560" y="300" font-size="72" font-weight="800" letter-spacing="-4" text-anchor="end">$${esc(strikeLabel(o.strike))}</text>
  </g>
  <line x1="${o.isCall ? 330 : 270}" y1="330" x2="${o.isCall ? 330 : 270}" y2="490" stroke="#e9e9e7" stroke-opacity="0.3" stroke-dasharray="4 6"/>
  <path d="${payoff}" fill="none" stroke="${tone}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${o.isCall ? 330 : 270}" cy="470" r="9" fill="#75d0cb"/>
  <g font-family="${font}" fill="#e9e9e7" font-size="13" font-weight="600" letter-spacing="1.3">
    <line x1="40" y1="524" x2="560" y2="524" stroke="#e9e9e7" stroke-opacity="0.25"/>
    <text x="40" y="556">EXPIRES ${esc(expiryLabel(o.expiry).toUpperCase())} · 16:00 ET</text>
    <text x="560" y="556" text-anchor="end" fill="#9a9a96">${esc(settled || `CHAIN ${o.chainId}`)}</text>
  </g>
</svg>`;
}
