// Every number the videos say, read from README.md at render time (and a few from the live app), so a stale number
// fails the render instead of being spoken. A missing pattern throws: fix the pattern or the README, never hardcode.
import { spawnSync } from "node:child_process";
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
  const tsla = md.match(/^\|\s*TSLA\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%\s*\|/m);
  if (!tsla) throw new Error("README.md: backtest TSLA row not found");
  const gasRow = md.match(
    /^\| `strikeForDelta`, 0\.20-delta call \(48 steps\)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|/m,
  );
  if (!gasRow) throw new Error("README.md: gas row for strikeForDelta not found");
  const gasProp = md.match(
    /^\| `EpochManager\.proposeByDelta` \(whole transaction\)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|/m,
  );
  if (!gasProp) throw new Error("README.md: gas row for proposeByDelta not found");
  // the README's total must be the canonical one in docs/evidence/facts.json (scripts/check-numbers.mjs writes it)
  const canonical = JSON.parse(readFileSync(join(root, "docs/evidence/facts.json"), "utf8")).totals
    .testsAndProofs;
  if (Number(evidence[1].replace(/,/g, "")) !== canonical)
    throw new Error(`README.md says ${evidence[1]} tests and proofs, docs/evidence/facts.json ${canonical}`);
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
    identity: pick(
      md,
      "ERC-8004 identity",
      /Agent #1 linked to ERC-8004 identity #(\d+) on the official testnet Identity Registry/,
    ),
    feePct: pick(
      md,
      "performance fee",
      /(\d+)% performance fee on positive epoch PnL, half to the proposing agent/,
    ),
    contractsVerified: pick(md, "verified contracts", /(\d+) contracts verified on Blockscout/),
    mcpUrl: pick(md, "remote MCP", /read-only MCP endpoint at `(https:\/\/[^`]+)`/),
    skillUrl: pick(md, "skill file", /the skill file at \[`\/skill\.md`\]\((https:\/\/[^)]+)\)/),
    tslaCcCagr: tsla[1],
    tslaHeldCagr: tsla[2],
    minBond: pick(md, "minimum bond", /Bond at least `minBond` USDG \((\d+) on the current deployments\)/),
    solverSteps: pick(md, "solver steps", /takes (\d+) Black-Scholes evaluations/),
    gasSolverSol: gasRow[1].replace(/,/g, ""),
    gasSolverStylus: gasRow[2].replace(/,/g, ""),
    gasProposeSol: gasProp[1].replace(/,/g, ""),
    gasProposeStylus: gasProp[2].replace(/,/g, ""),
    arbIdentity: pick(md, "Arbitrum ERC-8004 identity", /Agent #1 is ERC-8004 identity #(\d+) there/),
    arbCandidatesWord: pick(md, "Claude's candidates", /dry-ran (\w+) candidates with `risk_check`/),
    arbTx: pick(
      md,
      "Arbitrum accepted tx",
      /dry-ran \w+ candidates[^\n]*?\[tx\]\(https:\/\/sepolia\.arbiscan\.io\/tx\/(0x[0-9a-f]{64})\)/,
    ),
    arbSlash: pick(
      md,
      "Arbitrum slash",
      /reckless at-the-money put was rejected with (\d+) USDG slashed \(\[tx\]\(https:\/\/sepolia/,
    ),
    arbBought: pick(md, "Arbitrum buyer", /a buyer bought all (\d+) calls \(\[tx\]\(https:\/\/sepolia/),
    expiryDay: pick(
      md,
      "expiry day",
      /The Arbitrum Sepolia and 29 September epochs expired? on (Friday \d+ \w+); neither has settled yet/,
    ),
    reviewIssues: pick(
      md,
      "internal review issues",
      /The internal review found (\d+) issues and all are fixed/,
    ),
  };
}

/** Run the live claims test (scripts/check-claims.mjs: every transaction the docs and the app cite, fetched from its
 *  chain) and return its count. Throws unless every cited transaction verified. */
export function claimsCheck(root) {
  const r = spawnSync(process.execPath, [join(root, "scripts/check-claims.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const m = `${r.stdout}`.match(/(\d+) of (\d+) cited transactions verified \(([^)]*)\)/);
  if (r.status !== 0 || !m || m[1] !== m[2])
    throw new Error(
      `check-claims.mjs: exit ${r.status}, ${m ? m[0] : "no summary line"}\n${r.stdout}\n${r.stderr}`,
    );
  return { verified: m[1], cited: m[2], line: m[0] };
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The Arbitrum Sepolia epoch of 30 September: the epoch log and the Claude-planned decision record. */
export function arbFacts(root, readme) {
  const doc = readFileSync(join(root, "docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md"), "utf8");
  const rec = JSON.parse(
    readFileSync(join(root, "docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json"), "utf8"),
  );
  const tx = rec.transactions.find((t) => t.label === "proposeByDelta")?.hash;
  if (!tx || tx !== readme.arbTx) throw new Error(`Arbitrum tx: record ${tx}, README ${readme.arbTx}`);
  if (!doc.includes(`proposeByDelta\` accepted, 0.20-delta call at $${rec.result.strike}`))
    throw new Error("Arbitrum epoch log: the accepted call's strike does not match the decision record");
  const calls = pick(
    doc,
    "Claude's tool calls",
    /Claude calls vault_state, then risk_check at ([^\n]+), then agent_stats/,
  );
  const candidates = calls.split(/,\s*/).map((c) => {
    const m = c.match(/^(0\.\d+)\/(\d+)%$/);
    if (!m) throw new Error(`Arbitrum epoch log: candidate "${c}"`);
    return { delta: m[1], pct: m[2] };
  });
  if (WORDS[candidates.length] !== readme.arbCandidatesWord)
    throw new Error(`README says ${readme.arbCandidatesWord} candidates, the log lists ${candidates.length}`);
  const grid = pick(doc, "stress grid", /losses on the 13-shock grid \| 0 from −30% to 0%; ([^|]+?) USD \|/);
  const ups = grid.split(/,\s*/).map((x) => {
    const m = x.match(/^\+(\d+)% ([\d.]+)$/);
    if (!m) throw new Error(`stress grid item "${x}"`);
    return { shock: Number(m[1]), loss: m[2] };
  });
  const shocks = [-30, -25, -20, -15, -10, -5, 0].map((s) => ({ shock: s, loss: "0" })).concat(ups);
  if (shocks.length !== 13) throw new Error(`stress grid: ${shocks.length} shocks`);
  const buy = doc.match(/Bought (\d+) TSLA calls of series [^\n]*? for ([\d.]+) USDG, ([\d.]+) per option/);
  if (!buy) throw new Error("Arbitrum epoch log: buyer line not found");
  const m = rec.vault.mandate;
  const pct = (bps) => String(bps / 100);
  return {
    strike: rec.result.strike,
    spot: rec.market.spot,
    sigmaPct: String(Math.round(rec.market.sigma * 100)),
    delta: (rec.decision.targetDeltaBps / 1e4).toFixed(2),
    premiumPct: pct(rec.decision.premiumBps),
    model: rec.decision.planner.model,
    planner: rec.decision.planner.label,
    reasoning: rec.decision.reasoning,
    tx,
    candidates,
    expiryIso: rec.result.expiryIso,
    tenorDays: pick(doc, "tenor", /\| spot, sigma, tenor\s*\| [\d.]+, [\d.]+, [\d,]+ s \(([\d.]+) days\)/),
    shocks,
    worstLoss: ups.at(-1).loss,
    bought: buy[1],
    buyTotal: buy[2],
    buyPerOption: buy[3],
    spotBufferPct: pick(doc, "spot buffer", /at the oracle spot moved ([\d.]+)% against the buyer/),
    mandate: {
      deltaLo: (m.minDeltaBps / 1e4).toFixed(2),
      deltaHi: (m.maxDeltaBps / 1e4).toFixed(2),
      minPremiumPct: pct(m.minPremiumBps),
      minYieldPct: (m.minYieldBps / 100).toFixed(2),
      maxSoldPct: pct(m.maxShareSoldBps),
      tenorMin: String(m.minTenor / 86400),
      tenorMax: String(m.maxTenor / 86400),
    },
    maxStrikes: String(rec.trackRecord.maxStrikes),
    anchor: rec.anchor,
    agentId: rec.agent.agentId,
    vault: rec.vault.address,
    record: rec,
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
