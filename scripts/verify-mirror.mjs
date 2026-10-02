#!/usr/bin/env node
// The price mirror audit: checks that every price Strike's testnet MirrorFeeds hold is a round the Robinhood Chain
// mainnet Chainlink feed actually printed (same updatedAt, same answer). Read-only: no key, no transaction.
//
//   node scripts/verify-mirror.mjs --chain 46630                      every feed, every round
//   node scripts/verify-mirror.mjs --chain 421614 --symbol TSLA --rounds 5
//   node scripts/verify-mirror.mjs --chain 46630 --since 2026-10-01   (or a unix time)
//   node scripts/verify-mirror.mjs --chain 46630 --settlement 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e
//
// --settlement <vault> checks the round each series of the vault settled at (StockOracle's SettlementPriceRecorded)
// or will settle at (the first MirrorFeed round at or after expiry), and whether it is mainnet's first print after
// expiry. --json prints the SDK's result instead of the table. Exit status: 0 when everything checked matches, 1 on
// any mismatch, 2 on a usage or RPC error.
//
// Runs the SDK's auditMirror / auditSettlement (sdk/src/mirror.ts) from sdk/dist, building it first when it is
// missing or older than the source (needs `pnpm install` once). RPC: the chains' public RPCs, or Alchemy when
// ALCHEMY_API_KEY is set; STRIKE_RPC_URL overrides the testnet's.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "sdk/dist/index.js");
// The chains whose MirrorFeeds copy mainnet Chainlink (strike.config.json: a mainnetFeedsChain and deployments).
const STRIKE_CONFIG = JSON.parse(readFileSync(join(ROOT, "strike.config.json"), "utf8"));
const CHAIN_NAMES = Object.fromEntries(
  Object.entries(STRIKE_CONFIG.chains)
    .filter(([, c]) => c.mainnetFeedsChain && !c.local && c.deployments.length)
    .map(([id, c]) => [id, c.name]),
);
const MATCH_LINE = "rounds match Robinhood Chain mainnet Chainlink";

function usage(message) {
  if (message) console.error(`verify-mirror: ${message}`);
  console.error(
    "usage: node scripts/verify-mirror.mjs --chain <46630|421614> [--symbol TSLA] [--rounds N | --since <unix|date>]\n" +
      "                                      [--from-round N] [--to-round N] [--settlement <vault>] [--json]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const o = { chain: 46630, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--chain") o.chain = Number(value());
    else if (a === "--symbol") o.symbol = value().toUpperCase();
    else if (a === "--rounds") o.rounds = Number(value());
    else if (a === "--since") o.since = value();
    else if (a === "--from-round") o.fromRound = BigInt(value());
    else if (a === "--to-round") o.toRound = BigInt(value());
    else if (a === "--settlement") o.settlement = value();
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument ${a}`);
  }
  if (!CHAIN_NAMES[o.chain]) usage(`--chain must be 46630 or 421614 (got ${o.chain})`);
  if (o.rounds !== undefined && !(Number.isInteger(o.rounds) && o.rounds > 0))
    usage("--rounds must be a positive integer");
  if (o.rounds !== undefined && o.since !== undefined) usage("--rounds and --since are exclusive");
  if (o.since !== undefined) {
    const t = /^\d+$/.test(o.since) ? Number(o.since) : Date.parse(o.since) / 1000;
    if (!Number.isFinite(t)) usage(`--since: not a unix time or a date: ${o.since}`);
    o.since = BigInt(Math.floor(t));
  }
  if (o.settlement !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(o.settlement))
    usage("--settlement needs a vault address");
  return o;
}

/** The newest modification time under a directory. */
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

/** The SDK from sdk/dist, built first when it is missing or older than sdk/src. */
async function loadSdk() {
  const stale = !existsSync(DIST) || statSync(DIST).mtimeMs < newest(join(ROOT, "sdk/src"));
  if (stale) {
    console.error("verify-mirror: building the SDK (sdk/dist is missing or older than sdk/src)...");
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    try {
      run("pnpm", ["--filter", "@strike/sdk", "build"]);
    } catch {
      run("corepack", ["pnpm", "--filter", "@strike/sdk", "build"]);
    }
  }
  const sdk = await import(`${pathToFileURL(DIST).href}?t=${statSync(DIST).mtimeMs}`);
  if (typeof sdk.auditMirror !== "function") throw new Error("sdk/dist has no auditMirror: run pnpm install");
  return sdk;
}

// ------------------------------------------------------------------ formatting

const utc = (t) => new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 19);
const n = (x) => Number(x).toLocaleString("en-US");
const short = (h) => (h ? `${h.slice(0, 10)}…` : "-");
function duration(s) {
  const x = Number(s);
  const d = Math.floor(x / 86400);
  const h = Math.floor((x % 86400) / 3600);
  const m = Math.floor((x % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}
const pad = (s, w) => String(s).padEnd(w);
const mainnetId = (m) => (m ? `${m.phase}:${m.aggregatorRound}` : "-");

function describe(r, fmt, decimals) {
  switch (r.status) {
    case "match":
      return "match";
    case "deploy-seed":
      return "deploy seed (Deploy.s.sol), not a mainnet price";
    case "unchecked":
      return "not checked";
    case "answer-differs":
      return `MISMATCH: mainnet round ${mainnetId(r.mainnet)} at this time printed ${fmt(r.mainnet.answer, decimals)}`;
    case "future-timestamp":
      return "MISMATCH: timestamp later than mainnet's head";
    default: {
      const b = r.nearest?.before;
      const a = r.nearest?.after;
      const near = [
        b && `${mainnetId(b)} at ${utc(b.updatedAt)}`,
        a && `${mainnetId(a)} at ${utc(a.updatedAt)}`,
      ]
        .filter(Boolean)
        .join(", ");
      return `MISMATCH: mainnet printed no round at this time${near ? ` (nearest: ${near})` : ""}`;
    }
  }
}

const jsonOut = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function printAudit(sdk, audit, chain) {
  const fmt = sdk.fmtAnswer;
  console.log(
    `Price mirror audit: ${CHAIN_NAMES[chain]} (${chain}) MirrorFeeds against Robinhood Chain mainnet (4663) Chainlink`,
  );
  console.log(
    `Testnet block ${n(audit.testnetBlock)} (${utc(audit.testnetTime)} UTC), mainnet block ${n(audit.mainnetBlock)} (${utc(audit.mainnetTime)} UTC).`,
  );
  console.log(
    "Mainnet round = phase:aggregator round (the proxy's round id is phase << 64 | aggregator round).\n",
  );
  const mismatches = [];
  for (const f of audit.feeds) {
    const dec = f.testnetDecimals;
    console.log(
      `${f.symbol}  MirrorFeed ${f.testnetFeed}` +
        (f.mainnetFeed
          ? ` copies ${f.mainnetDescription ?? "Chainlink"} ${f.mainnetFeed}`
          : " (no mainnet feed)"),
    );
    if (f.unverifiable) {
      console.log(`  ${f.rounds.length} round(s), not checked: ${f.unverifiable}.\n`);
      continue;
    }
    console.log(
      `  ${pad("Round", 6)} ${pad("Price", 14)} ${pad("updatedAt (UTC)", 20)} ${pad("Mainnet", 9)} ${pad("Push tx", 12)} Result`,
    );
    for (const r of f.rounds) {
      console.log(
        `  ${pad(r.roundId, 6)} ${pad(fmt(r.answer, dec), 14)} ${pad(utc(r.updatedAt), 20)} ${pad(mainnetId(r.mainnet), 9)} ${pad(short(r.pushTx), 12)} ${describe(r, fmt, dec)}`,
      );
      if (!["match", "deploy-seed", "unchecked"].includes(r.status)) mismatches.push({ f, r });
    }
    const keeper = f.rounds.filter((r) => r.status !== "deploy-seed").length;
    const parts = [`${f.counts.match} of ${keeper} keeper rounds match`];
    if (keeper > 1) {
      parts.push(
        `the keeper mirrored ${f.counts.match} of the ${f.mainnetRoundsInWindow} mainnet prints from its first push to its last, and ${f.mainnetRoundsAfterLastPush} printed since`,
      );
    }
    if (f.largestGap) {
      const g = f.largestGap;
      parts.push(
        `largest gap between pushes: round ${g.fromRound} to ${g.toRound}, ${duration(g.seconds)}, ${g.mainnetRoundsBetween} mainnet print(s) in between not mirrored`,
      );
    }
    console.log(`  ${parts.join("; ")}.\n`);
  }
  const s = audit.summary;
  for (const u of s.unverifiable)
    console.log(`Not checked: ${u.symbol} (${u.rounds} round(s)): ${u.reason}.`);
  const oracles = audit.oracleFeeds ?? [];
  const swapped = oracles.filter((o) => !o.same);
  if (oracles.length && !swapped.length) {
    const byOracle = [...new Set(oracles.map((o) => `${o.version ?? "?"} ${o.stockOracle}`))];
    console.log(
      `Oracle check: the StockOracle of each deployment (${byOracle.join(", ")}) reads the audited MirrorFeed for all ${oracles.length} listed token(s).`,
    );
  }
  const managers = audit.managerOracles ?? [];
  for (const m of managers.filter((x) => !x.same)) {
    console.log(
      `MISMATCH: the ${m.version ?? "?"} EpochManager ${m.epochManager} reads StockOracle ${m.oracle ?? "(unreadable)"}, not the deployment's ${m.expected}.`,
    );
  }
  if (managers.length && managers.every((x) => x.same)) {
    console.log(
      `EpochManager check: each deployment's EpochManager reads its recorded StockOracle (${managers.map((m) => m.version ?? "?").join(", ")}).`,
    );
  }
  for (const o of swapped) {
    console.log(
      `MISMATCH: the ${o.version ?? "?"} StockOracle ${o.stockOracle} reads ${o.symbol} from ${o.feed ?? "(unreadable)"}, not the audited MirrorFeed ${o.expected}.`,
    );
  }
  if (s.seeds.length) {
    console.log(
      `Deploy seeds, listed apart (round 1, pushed by contracts/script/Deploy.s.sol when it created the feed, before the keeper ran; not mainnet prints): ${s.seeds
        .map((x) => `${x.symbol} ${sdk.fmtAnswer(x.answer, 8)} at ${utc(x.updatedAt)}`)
        .join(", ")}.`,
    );
  }
  if (s.largestGap) {
    const g = s.largestGap;
    console.log(
      `Largest gap between pushes: ${g.symbol} round ${g.fromRound} to ${g.toRound}, ${duration(g.seconds)} (${utc(g.from)} to ${utc(g.to)} UTC), ${g.mainnetRoundsBetween} mainnet print(s) in between. The audit checks every value pushed; it cannot make the keeper push (withheld rounds show up only as gaps).`,
    );
  }
  if (mismatches.length) {
    console.log(`\n${mismatches.length} mismatch(es):`);
    for (const { f, r } of mismatches) {
      console.log(
        `  ${f.symbol} round ${r.roundId} (${sdk.fmtAnswer(r.answer, f.testnetDecimals)} at ${utc(r.updatedAt)} UTC, push ${r.pushTx ?? "tx unknown"}): ${describe(r, sdk.fmtAnswer, f.testnetDecimals)}`,
      );
    }
  }
  console.log(`\n${s.matched} of ${s.rounds} ${MATCH_LINE}`);
  return audit.ok ? 0 : 1;
}

function printSettlement(sdk, a, chain) {
  console.log(
    `Settlement audit: vault ${a.vault} (${a.version ?? "?"}, EpochManager ${a.epochManager}) on ${CHAIN_NAMES[chain]} (${chain})`,
  );
  console.log(`Testnet time ${utc(a.testnetTime)} UTC, mainnet time ${utc(a.mainnetTime)} UTC.`);
  console.log(
    a.stockOracle === a.expectedStockOracle
      ? `The EpochManager settles through StockOracle ${a.stockOracle}, the deployment's.\n`
      : `MISMATCH: the EpochManager settles through StockOracle ${a.stockOracle}, not the deployment's ${a.expectedStockOracle}.\n`,
  );
  if (!a.series.length) console.log("The vault has sold no series yet.");
  for (const s of a.series) {
    console.log(
      `Series ${s.seriesId}${s.epoch !== null ? ` (epoch ${s.epoch})` : ""}: ${s.symbol}, expiry ${utc(s.expiry)} UTC, ${sdk.formatWad ? sdk.formatWad(s.sold, 4) : s.sold} options sold`,
    );
    console.log(`  Feed read by the oracle: ${s.feed}${s.mainnetFeed ? `, copying ${s.mainnetFeed}` : ""}`);
    if (s.round) {
      const m = s.round.mainnet;
      console.log(
        `  ${s.roundSource === "recorded" ? "Recorded" : "Candidate"} round ${s.round.roundId}: ${sdk.fmtAnswer(s.round.answer, 8)} at ${utc(s.round.updatedAt)} UTC` +
          (s.round.pushTx ? `, pushed in ${s.round.pushTx}` : "") +
          (m
            ? `; mainnet round ${m.roundId} (${m.phase}:${m.aggregatorRound}), ${sdk.fmtAnswer(m.answer, 8)} at ${utc(m.updatedAt)} UTC`
            : ""),
      );
    }
    if (s.recordTx) console.log(`  SettlementPriceRecorded in ${s.recordTx}`);
    if (s.firstMainnetAtOrAfterExpiry) {
      const f = s.firstMainnetAtOrAfterExpiry;
      console.log(
        `  First mainnet print at or after expiry: round ${f.phase}:${f.aggregatorRound}, ${sdk.fmtAnswer(f.answer, 8)} at ${utc(f.updatedAt)} UTC`,
      );
    }
    console.log(`  ${s.status === "mismatch" ? "FAIL" : "Result"}: ${s.message}\n`);
  }
  const bad = a.series.filter((s) => s.status === "mismatch").length;
  if (a.stockOracle !== a.expectedStockOracle) {
    console.log("The EpochManager does not settle through the deployment's StockOracle: the check fails");
  } else {
    console.log(
      bad
        ? `${bad} series settled (or about to settle) at a round that does not match Robinhood Chain mainnet Chainlink`
        : `No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink`,
    );
  }
  return a.ok ? 0 : 1;
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
try {
  const sdk = await loadSdk();
  let code;
  if (opts.settlement) {
    const a = await sdk.auditSettlement({ chainId: opts.chain, vault: opts.settlement });
    if (opts.json) {
      console.log(jsonOut(a));
      code = a.ok ? 0 : 1;
    } else code = printSettlement(sdk, a, opts.chain);
  } else {
    const audit = await sdk.auditMirror({
      chainId: opts.chain,
      symbol: opts.symbol,
      lastRounds: opts.rounds,
      since: opts.since,
      fromRound: opts.fromRound,
      toRound: opts.toRound,
    });
    if (opts.json) {
      console.log(jsonOut(audit));
      code = audit.ok ? 0 : 1;
    } else code = printAudit(sdk, audit, opts.chain);
  }
  process.exit(code);
} catch (err) {
  console.error(`verify-mirror: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  process.exit(2);
}
