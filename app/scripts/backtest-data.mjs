#!/usr/bin/env node
// Turns the committed backtest (research/results/*) into the compact JSON the /app/backtest page imports.
// Nothing is recomputed: every figure is copied (rounded) from the CSVs and tables.md that research/backtest.py wrote.
// A few cross-checks fail the run if the sources disagree with each other.
//
//   node app/scripts/backtest-data.mjs
//
// Writes app/src/data/backtest/summary.json (grid, stress, periods) and weekly.json (0.20-delta week-by-week series).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = join(ROOT, "research", "results");
const OUT = join(ROOT, "app", "src", "data", "backtest");

const TICKERS = ["TSLA", "NVDA", "AMZN", "SPY"];
const VAULTS = { call: "covered call", put: "cash-secured put" };
const VRPS = [
  ["1.00", "vrp100"],
  ["1.15", "vrp115"],
];

/** Minimal CSV reader (handles quoted fields). */
function readCsv(file) {
  const text = readFileSync(join(RESULTS, file), "utf8").trim();
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") (cells.push(cur), (cur = ""));
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${s}`);
  return n;
};
const round = (n, dp) => Number(n.toFixed(dp));
function check(ok, msg) {
  if (!ok) throw new Error(`cross-check failed: ${msg}`);
}

// ------------------------------------------------------------------ weekly series (delta 0.20, premiumBps 1.00)

let dates = null;
const series = {};
for (const [vrp, tag] of VRPS) {
  const rows = readCsv(`weekly_delta020_${tag}.csv`);
  for (const t of TICKERS) {
    series[t] ??= { bh: null };
    for (const v of Object.keys(VAULTS)) {
      const r = rows.filter((x) => x.ticker === t && x.vault === v);
      check(r.length === 403, `${t} ${v} ${vrp}: ${r.length} weeks`);
      check(num(r[0].nav_open) === 1, `${t} ${v} ${vrp} starts at 1.0`);
      // One calendar for every series: the first open, then each expiry close.
      const d = [r[0].open, ...r.map((x) => x.expiry)];
      if (!dates) dates = d;
      else check(d.join() === dates.join(), `${t} ${v} ${vrp}: same dates`);
      // Buy-and-hold is the same stock whatever the vault or VRP.
      const bh = [1, ...r.map((x) => round(num(x.bh_nav), 4))].join(",");
      if (!series[t].bh) series[t].bh = bh;
      else check(bh === series[t].bh, `${t}: same buy-and-hold`);
      series[t][v] ??= {};
      series[t][v][vrp] = {
        /** Vault value per unit deposited at each settlement close (index 0 = the first open). */
        nav: [1, ...r.map((x) => round(num(x.nav), 4))].join(","),
        /** Premium per option ÷ collateral per option, in % (tables.md "Avg premium/wk"). */
        premium: r.map((x) => round(num(x.premium_yield) * 100, 4)).join(","),
        /** 1 where the week finished in the money. */
        itm: r.map((x) => (x.itm === "True" ? "1" : "0")).join(""),
        _rows: r,
      };
    }
  }
}

// ------------------------------------------------------------------ grid summary (premiumBps 1.00, premium held)

const gridRows = readCsv("grid.csv").filter(
  (x) => x.premium_bps === "1.0" && x.reinvest === "False" && x.vol_source === "realized",
);
check(gridRows.length === 48, `48 grid rows at premiumBps 1.00, got ${gridRows.length}`);
const vaultKey = (name) => Object.keys(VAULTS).find((k) => VAULTS[k] === name);
const grid = gridRows.map((x) => ({
  ticker: x.ticker,
  vault: vaultKey(x.vault),
  delta: num(x.delta),
  vrp: num(x.vrp).toFixed(2),
  weeks: num(x.weeks),
  cagr: round(num(x.cagr), 6),
  vol: round(num(x.vol), 6),
  sharpe: round(num(x.sharpe), 4),
  maxDd: round(num(x.max_dd), 6),
  worstWeek: round(num(x.worst_week), 6),
  assigned: round(num(x.assigned), 6),
  avgPremium: round(num(x.avg_premium_yield), 8),
  bhCagr: round(num(x.bh_cagr), 6),
  bhVol: round(num(x.bh_vol), 6),
  bhSharpe: round(num(x.bh_sharpe), 4),
  bhMaxDd: round(num(x.bh_max_dd), 6),
  bhWorstWeek: round(num(x.bh_worst_week), 6),
}));

// The 0.20 grid rows describe exactly the weekly series above.
for (const g of gridRows.filter((x) => x.delta === "0.2")) {
  const s = series[g.ticker][vaultKey(g.vault)][num(g.vrp).toFixed(2)];
  const r = s._rows;
  const last = num(r[r.length - 1].nav);
  check(Math.abs(last - 1 - num(g.total)) < 1e-9, `${g.ticker} ${g.vault} ${g.vrp}: total return`);
  const meanPy = r.reduce((a, x) => a + num(x.premium_yield), 0) / r.length;
  check(Math.abs(meanPy - num(g.avg_premium_yield)) < 1e-12, `${g.ticker} ${g.vault} ${g.vrp}: avg premium`);
  const itm = r.filter((x) => x.itm === "True").length / r.length;
  check(Math.abs(itm - num(g.assigned)) < 1e-12, `${g.ticker} ${g.vault} ${g.vrp}: assigned`);
}
for (const t of TICKERS)
  for (const v of Object.keys(VAULTS)) for (const [vrp] of VRPS) delete series[t][v][vrp]._rows;

// ------------------------------------------------------------------ stress periods (tables.md)

const tables = readFileSync(join(RESULTS, "tables.md"), "utf8");
const stress = [];
for (const [vrp] of VRPS) {
  const head = `#### Stress periods, VRP ${vrp}`;
  const at = tables.indexOf(head);
  check(at >= 0, `tables.md has "${head}"`);
  const block = tables.slice(at).split(/\n\n/)[1];
  const lines = block.split("\n").filter((l) => l.startsWith("|"));
  const cols = lines[0].split("|").map((c) => c.trim());
  const idx = (name) => cols.indexOf(name);
  for (const line of lines.slice(2)) {
    const c = line.split("|").map((x) => x.trim());
    const pair = (cell) => {
      const m = cell.match(/^(-?[\d.]+)% \((-?[\d.]+)%\)$/);
      check(m, `stress cell "${cell}"`);
      return [num(m[1]), num(m[2])];
    };
    stress.push({
      ticker: c[idx("Ticker")],
      vault: vaultKey(c[idx("Vault")]),
      vrp,
      crash: pair(c[idx("2020 crash")]),
      rebound: pair(c[idx("2020 rebound")]),
      bear: pair(c[idx("2022 bear")]),
    });
  }
}
check(stress.length === 16, `16 stress rows, got ${stress.length}`);
// tables.md agrees with the full-precision grid.
for (const s of stress) {
  const g = gridRows.find(
    (x) =>
      x.ticker === s.ticker &&
      vaultKey(x.vault) === s.vault &&
      x.delta === "0.2" &&
      num(x.vrp).toFixed(2) === s.vrp,
  );
  for (const [k, col] of [
    ["crash", "2020 crash"],
    ["rebound", "2020 rebound"],
    ["bear", "2022 bear"],
  ]) {
    check(Math.abs(s[k][0] - num(g[col]) * 100) < 0.051, `${s.ticker} ${s.vault} ${s.vrp} ${k} vault`);
    check(Math.abs(s[k][1] - num(g[`${col} bh`]) * 100) < 0.051, `${s.ticker} ${s.vault} ${s.vrp} ${k} B&H`);
  }
}

// Stress windows, from research/backtest.py.
const py = readFileSync(join(ROOT, "research", "backtest.py"), "utf8");
const periods = ["2020 crash", "2020 rebound", "2022 bear"].map((label) => {
  const m = py.match(new RegExp(`"${label}": \\("(\\d{4}-\\d\\d-\\d\\d)", "(\\d{4}-\\d\\d-\\d\\d)"\\)`));
  check(m, `backtest.py defines ${label}`);
  return { label, from: m[1], to: m[2] };
});

// ------------------------------------------------------------------ write

mkdirSync(OUT, { recursive: true });
const meta = {
  source: "research/results (research/backtest.py)",
  weeks: 403,
  start: dates[0],
  end: dates[dates.length - 1],
  premiumBps: 1,
  premiumHeld: true,
};
// Written already formatted, so the repository's `prettier --check .` passes. The weekly arrays are comma-joined
// strings (split in src/lib/backtest.ts): as JSON arrays, prettier would put every number on its own line.
async function write(file, data) {
  const path = join(OUT, file);
  let text = JSON.stringify(data, null, 2) + "\n";
  try {
    const prettier = await import("prettier");
    text = await prettier.format(text, { ...(await prettier.resolveConfig(path)), filepath: path });
  } catch {
    // prettier not installed: the 2-space JSON is still valid, just maybe not byte-identical to its output
  }
  writeFileSync(path, text);
}
await write("summary.json", { meta, periods, grid, stress });
await write("weekly.json", { delta: 0.2, dates: dates.join(","), series });
console.log(
  `wrote ${grid.length} grid rows, ${stress.length} stress rows, ${TICKERS.length * 4} weekly series`,
);
