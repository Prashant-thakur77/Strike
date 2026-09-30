// Every number the videos say, read from README.md at render time (and a few from the live app), so a stale number
// fails the render instead of being spoken. A missing pattern throws: fix the pattern or the README, never hardcode.
import { readFileSync } from "node:fs";
import { join } from "node:path";

function pick(md, name, re, group = 1) {
  const m = md.match(re);
  if (!m) throw new Error(`README.md: no match for ${name} (${re})`);
  return m[group];
}

export function readmeFacts(root) {
  const md = readFileSync(join(root, "README.md"), "utf8");
  const evidence = md.match(
    /\|\s*\[(\d[\d,]*)\]\(#tests\)\s*\|\s*\[([\d.]+)%\]\(#coverage\)\s*\|\s*\[([\d.]+)× cheaper\]\(#gas\)/,
  );
  if (!evidence)
    throw new Error("README.md: the 'Evidence in numbers' row (tests, coverage, Stylus) was not found");
  const nvda = md.match(/^\|\s*NVDA\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%/m);
  if (!nvda) throw new Error("README.md: backtest NVDA row not found");
  const header = md.match(
    /^\| Ticker \| Covered call CAGR \| Held CAGR \| Covered call volatility \| Held volatility \|/m,
  );
  if (!header) throw new Error("README.md: backtest table columns changed");
  return {
    testsTotal: evidence[1].replace(/,/g, ""),
    coverage: evidence[2],
    stylusSolverX: evidence[3],
    foundry: pick(md, "Foundry main suite count", /Foundry main suite[^\n]*?\|\s*(\d+)\s*\|/),
    halmos: pick(md, "Halmos count", /Halmos proofs[^\n]*?\|\s*(\d+)\s*\|/),
    reviewFindings: pick(md, "review findings", /Internal review\s*\|\s*(\d+) findings[^|]*all fixed/),
    stylusTxX: pick(md, "proposeByDelta 3.3x", /whole `proposeByDelta` transaction ([\d.]+) times less/),
    backtestWeeks: pick(md, "backtest weeks", /(\d+) weekly epochs from January 2019/),
    volCut: pick(md, "volatility cut range", /cut volatility by (\d+ to \d+)%/),
    nvdaCcVol: nvda[3],
    nvdaHeldVol: nvda[4],
    strike: pick(md, "live strike", /accepted\]\([^)]*\) at a strike of \$(\d+\.\d+)/),
    premium: pick(md, "premium paid", /bought 4 calls\]\([^)]*\) for ([\d.]+) USDG/),
    slash: pick(md, "slash", /rejected on-chain with (\d+) USDG slashed/),
    bondBefore: pick(md, "bond before", /bonded with (\d+) USDG \((\d+) USDG after the live epoch's slash\)/),
    bondAfter: pick(
      md,
      "bond after",
      /bonded with (\d+) USDG \((\d+) USDG after the live epoch's slash\)/,
      2,
    ),
    identity: pick(md, "ERC-8004 identity", /ERC-8004 identity #(\d+)/),
    feePct: pick(
      md,
      "performance fee",
      /(\d+)% performance fee on positive epoch PnL, half to the proposing agent/,
    ),
    contractsVerified: pick(md, "verified contracts", /(\d+) contracts verified on Blockscout/),
    mcpUrl: pick(md, "remote MCP", /read-only MCP endpoint at `(https:\/\/[^`]+)`/),
  };
}

// ------------------------------------------------------------------------------------------ spoken numbers

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const DIGIT = ONES.slice(0, 10);

/** 864 -> "eight hundred sixty-four" (0 to 9999). */
export function sayInt(n) {
  n = Number(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${sayInt(n % 100)}` : ""}`;
  return `${sayInt(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${sayInt(n % 1000)}` : ""}`;
}

/** "99.3" -> "ninety-nine point three"; "1.000775" -> "one point zero zero zero seven seven five". */
export function sayDec(s) {
  const [i, f] = String(s).split(".");
  return f ? `${sayInt(i)} point ${[...f].map((d) => DIGIT[d]).join(" ")}` : sayInt(i);
}

/** "369.86" -> "three hundred sixty-nine dollars eighty-six". */
export function sayUsd(s) {
  const [i, f] = String(s).split(".");
  return `${sayInt(i)} dollars${f ? ` ${sayInt(Number(f))}` : ""}`;
}
