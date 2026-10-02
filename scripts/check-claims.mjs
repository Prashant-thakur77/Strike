#!/usr/bin/env node
// Live claims test: every transaction the README, docs/ and the app cite is fetched from its chain and checked.
//
//   node scripts/check-claims.mjs              check everything, print failures and a summary
//   node scripts/check-claims.mjs --verbose    also list every transaction with the checks it passed
//   node scripts/check-claims.mjs --chain 421614
//
// What is collected: explorer links to a transaction in README.md, docs/**/*.md and app/src (the host names the chain:
// explorer.testnet.chain.robinhood.com is 46630, sepolia.arbiscan.io 421614, explorer.chain.robinhood.com 4663), bare
// hashes on app/src lines that name a tx, and every { tx, block } pair in the proven-week records (docs/evidence).
//
// What is checked, for each transaction:
//   - the receipt exists on that chain and succeeded (or reverted, for a transaction cited because it failed);
//   - in a Markdown table citing it: the Block, Time (UTC), Gas used, gasUsedForL1 and L2 gas columns, the address a
//     "Creation tx" row says it created, and a `recordHash` column against the DecisionLog event;
//   - in prose: "(block N" right after the link;
//   - the claims in check-claims.expect.json: the events the receipt must contain, with their amounts; and every
//     "N USDG" and "$N" figure in a sentence or table row citing one of those transactions must be one of the amounts
//     the receipt shows (or a listed context figure), at the precision written.
//
// RPCs: the public RPC of each chain in strike.config.json, or STRIKE_RPC_<chainId>. A chain whose RPC does not
// answer is skipped with a warning, not failed. Exit status: 0 when nothing mismatched, 1 on any mismatch.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CONFIG,
  ROOT,
  RpcUnreachable,
  decodeLog,
  formatUnits,
  isoSecond,
  mapLimit,
  parseEvent,
  parseUnits,
  roundUnits,
  rpcClient,
  rpcUrl,
} from "./lib/evm.mjs";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const ONLY_CHAIN = args.includes("--chain") ? Number(args[args.indexOf("--chain") + 1]) : null;

// Explorer host -> chain id: the explorers in strike.config.json, plus the other explorers the docs use.
const EXPLORERS = { "explorer.chain.robinhood.com": 4663, "arbitrum-sepolia.blockscout.com": 421614 };
for (const [id, c] of Object.entries(CONFIG.chains))
  if (c.explorer) EXPLORERS[new URL(c.explorer).host] = Number(id);

const EXPECT = JSON.parse(readFileSync(join(ROOT, "scripts/check-claims.expect.json"), "utf8"));
const EVENTS = Object.fromEntries(Object.entries(EXPECT.events).map(([k, v]) => [k, parseEvent(v)]));
const UNITS = EXPECT.units;
const expectations = Object.fromEntries(
  Object.entries(EXPECT.transactions).map(([h, e]) => [h.toLowerCase(), e]),
);

// ------------------------------------------------------------------------------------------------ collect

function walk(dir, ok, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && !name.startsWith(".")) walk(p, ok, out);
    } else if (ok(p)) out.push(p);
  }
  return out;
}

const TX_LINK = /https?:\/\/([a-z0-9.-]+)\/tx\/(0x[0-9a-fA-F]{64})/g;
const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Clauses of a prose line (sentences, then semicolons), keeping decimals ("10.01") and links intact. */
function clauses(line) {
  return line.split(/(?<=[^\d\s][.!?])\s+(?=[A-Z([*`])|;\s+/);
}

// The stated-figure check reads these files: the ones a judge reads first. The epoch logs cite the same transactions
// in long form; their events are still checked through check-claims.expect.json.
const FIGURE_FILES = new Set(["README.md", "docs/JUDGES.md", "docs/DEPLOYMENTS.md"]);

/** Every citation: { hash, chainId, file, line, header?, row?, cell?, text, after }. */
function collect() {
  const out = [];
  const mdFiles = [join(ROOT, "README.md"), ...walk(join(ROOT, "docs"), (p) => p.endsWith(".md"))];
  for (const path of mdFiles) {
    const file = relative(ROOT, path);
    const lines = readFileSync(path, "utf8").split("\n");
    let header = null;
    let inTable = false;
    lines.forEach((line, i) => {
      const isRow = line.trimStart().startsWith("|");
      if (!isRow) inTable = false;
      else if (!inTable) {
        inTable = true;
        header = cells(line);
        return;
      }
      if (isRow && /^\|[\s:|-]+\|$/.test(line.trim())) return; // the separator row
      for (const m of line.matchAll(TX_LINK)) {
        const chainId = EXPLORERS[m[1]];
        if (!chainId) continue;
        const c = {
          hash: m[2].toLowerCase(),
          chainId,
          file,
          line: i + 1,
          after: line.slice(m.index + m[0].length),
        };
        if (isRow) {
          const row = cells(line);
          const col = row.findIndex((cell) => cell.includes(m[0]));
          Object.assign(c, { header, row, col, text: line });
        } else {
          c.text = clauses(line).find((s) => s.includes(m[0])) ?? line;
        }
        out.push(c);
      }
    });
  }
  // The app: explorer links, and bare hashes on lines that name a transaction (`tx:`, `txHash`, `deployTx`, ...).
  for (const path of walk(join(ROOT, "app/src"), (p) => /\.(ts|tsx)$/.test(p))) {
    const file = relative(ROOT, path);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const linked = new Set();
        for (const m of line.matchAll(TX_LINK)) {
          if (!EXPLORERS[m[1]]) continue;
          linked.add(m[2].toLowerCase());
          out.push({ hash: m[2].toLowerCase(), chainId: EXPLORERS[m[1]], file, line: i + 1, text: line });
        }
        if (!/tx/i.test(line)) return;
        for (const m of line.matchAll(/["'`](0x[0-9a-fA-F]{64})["'`]/g))
          if (!linked.has(m[1].toLowerCase()))
            out.push({ hash: m[1].toLowerCase(), chainId: null, file, line: i + 1, text: line });
      });
  }
  // The proven-week records: every object with a tx and a block.
  const evidence = join(ROOT, "docs/evidence");
  if (existsSync(evidence)) {
    for (const path of walk(evidence, (p) => p.endsWith(".json") && !p.endsWith("facts.json"))) {
      const file = relative(ROOT, path);
      const record = JSON.parse(readFileSync(path, "utf8"));
      const visit = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n, k) => visit(n, `${where}[${k}]`));
        if (!node || typeof node !== "object") return;
        if (typeof node.tx === "string" && /^0x[0-9a-f]{64}$/i.test(node.tx) && Number.isInteger(node.block))
          out.push({ hash: node.tx.toLowerCase(), chainId: record.chainId, file, where, block: node.block });
        for (const [k, v] of Object.entries(node)) visit(v, where ? `${where}.${k}` : k);
      };
      visit(record, "");
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ check helpers

const num = (s) => s.replace(/[*,`\s]/g, "");
const addr = (s) => s.toLowerCase();

/** Does a decoded value match an expected value written in check-claims.expect.json? Returns null or a reason. */
function compare(actual, expected) {
  if (typeof expected === "boolean") return actual === expected ? null : `${actual}, expected ${expected}`;
  const text = String(expected).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(text))
    return addr(String(actual)) === addr(text) ? null : `${actual}, expected ${text}`;
  if (/^0x[0-9a-fA-F]+$/.test(text))
    return String(actual).toLowerCase() === text.toLowerCase() ? null : `${actual}, expected ${text}`;
  const enumeration = text.match(/^(-?\d+) \((\w+)\)$/);
  if (enumeration)
    return actual === BigInt(enumeration[1])
      ? null
      : `${actual}, expected ${enumeration[1]} (${enumeration[2]})`;
  const amount = text.match(/^(~?)(-?[\d.]+) ([A-Z]+)$/);
  if (amount && UNITS[amount[3]] !== undefined) {
    const decimals = UNITS[amount[3]];
    const shown = `${formatUnits(actual, decimals)} ${amount[3]}`;
    if (amount[1]) {
      const places = (amount[2].split(".")[1] ?? "").length;
      return roundUnits(actual, decimals, places) === amount[2] ? null : `${shown}, expected ${text}`;
    }
    return actual === parseUnits(amount[2], decimals) ? null : `${shown}, expected ${text}`;
  }
  if (/^-?\d+$/.test(text)) return actual === BigInt(text) ? null : `${actual}, expected ${text}`;
  return actual === text ? null : `"${actual}", expected "${text}"`;
}

/** The figures a claim text states: "N USDG" and "$N". */
function statedFigures(text) {
  const clean = text.replace(/\]\([^)]*\)/g, "]"); // drop link targets
  const figures = [];
  for (const m of clean.matchAll(/(?<![\w.$])(\d[\d,]*(?:\.\d+)?)\s*USDG\b/g))
    figures.push({ unit: "USDG", value: num(m[1]) });
  for (const m of clean.matchAll(/\$(\d[\d,]*(?:\.\d+)?)(?![\d,]*\s*(?:million|k|bn|,000))/g))
    figures.push({ unit: "USD", value: num(m[1]) });
  return figures;
}

/** Every amount a receipt shows in a unit, from the expected events' amount fields. */
function receiptAmounts(hash, decoded) {
  const exp = expectations[hash];
  const amounts = { USDG: new Set(), USD: new Set() };
  for (const [i, spec] of (exp?.events ?? []).entries()) {
    for (const [field, want] of Object.entries(spec.args ?? {})) {
      const unit = String(want).match(/ (USDG|USD)$/)?.[1];
      const got = decoded[i]?.[field];
      if (unit && typeof got === "bigint")
        amounts[unit].add({ raw: got < 0n ? -got : got, decimals: UNITS[unit] });
    }
  }
  return amounts;
}

function figureMatches(figure, amounts, context) {
  if (context?.[figure.unit]?.[figure.value] !== undefined) return true;
  const places = (figure.value.split(".")[1] ?? "").length;
  for (const a of amounts[figure.unit] ?? [])
    if (roundUnits(a.raw, a.decimals, places) === figure.value) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------ run

const citations = collect();
const byHash = new Map();
for (const c of citations) {
  if (!byHash.has(c.hash)) byHash.set(c.hash, []);
  byHash.get(c.hash).push(c);
}
for (const h of Object.keys(expectations))
  if (!byHash.has(h))
    byHash.set(h, [{ hash: h, chainId: expectations[h].chain, file: "scripts/check-claims.expect.json" }]);

const failures = new Map(); // hash -> [reasons]
const fail = (hash, reason) => {
  if (!failures.has(hash)) failures.set(hash, []);
  failures.get(hash).push(reason);
};
const passed = new Map(); // hash -> [checks]
const ok = (hash, check) => {
  if (!passed.has(hash)) passed.set(hash, []);
  passed.get(hash).push(check);
};

// Resolve the chain of each hash; a hash linked to two chains is itself a mismatch.
const txChain = new Map();
for (const [hash, cs] of byHash) {
  const chains = [...new Set(cs.map((c) => c.chainId).filter((x) => x))];
  if (expectations[hash]?.chain && !chains.includes(expectations[hash].chain))
    chains.push(expectations[hash].chain);
  if (chains.length > 1)
    fail(
      hash,
      `cited on more than one chain: ${chains.join(", ")} (${cs.map((c) => `${c.file}:${c.line}`).join(", ")})`,
    );
  txChain.set(hash, chains[0] ?? null);
}

const clients = new Map();
const unreachable = new Map(); // chainId -> reason
async function client(chainId) {
  if (clients.has(chainId)) return clients.get(chainId);
  const url = rpcUrl(chainId);
  const c = url ? rpcClient(url) : null;
  const p = (async () => {
    if (!c) throw new RpcUnreachable(`no RPC configured for chain ${chainId}`);
    const id = await c.chainId();
    if (id !== chainId) throw new RpcUnreachable(`${url} answered chain ${id}, not ${chainId}`);
    return c;
  })();
  clients.set(chainId, p);
  return p;
}

// Chains that answer, in the order tried for a hash with no chain of its own (a bare hash in app/src).
const candidateChains = [...new Set([...txChain.values()].filter(Boolean))];

const blockCache = new Map();
async function blockTime(c, chainId, n) {
  const key = `${chainId}:${n}`;
  if (!blockCache.has(key))
    blockCache.set(
      key,
      c.block(n).then((b) => BigInt(b.timestamp)),
    );
  return blockCache.get(key);
}

const skipped = new Map(); // hash -> reason
const decodedByHash = new Map(); // hash -> the matched args of each expected event
const hashes = [...byHash.keys()].filter(
  (h) => !ONLY_CHAIN || txChain.get(h) === ONLY_CHAIN || !txChain.get(h),
);

await mapLimit(hashes, 4, async (hash) => {
  const cs = byHash.get(hash);
  const exp = expectations[hash];
  let chainId = txChain.get(hash);
  let c;
  let receipt;
  try {
    if (chainId) {
      c = await client(chainId);
      receipt = await c.receipt(hash);
    } else {
      for (const id of candidateChains) {
        try {
          const cc = await client(id);
          const r = await cc.receipt(hash);
          if (r) {
            [chainId, c, receipt] = [id, cc, r];
            break;
          }
        } catch (e) {
          if (!(e instanceof RpcUnreachable)) throw e;
        }
      }
      if (!receipt) {
        fail(
          hash,
          `not found on any chain (${candidateChains.join(", ")}); cited at ${cs.map((x) => `${x.file}:${x.line}`).join(", ")}`,
        );
        return;
      }
    }
  } catch (e) {
    if (e instanceof RpcUnreachable) {
      unreachable.set(chainId, e.message);
      skipped.set(hash, `chain ${chainId} RPC unreachable`);
      return;
    }
    throw e;
  }
  if (!receipt) {
    fail(
      hash,
      `no receipt on chain ${chainId}; cited at ${cs.map((x) => `${x.file}:${x.line ?? x.where}`).join(", ")}`,
    );
    return;
  }

  try {
    // Status.
    const wantStatus = exp?.status ?? "success";
    const status = BigInt(receipt.status) === 1n ? "success" : "reverted";
    if (status !== wantStatus) fail(hash, `status ${status}, cited as ${wantStatus}`);
    else ok(hash, `status ${status}`);

    const block = Number(BigInt(receipt.blockNumber));
    const gasUsed = BigInt(receipt.gasUsed);
    const gasL1 = receipt.gasUsedForL1 !== undefined ? BigInt(receipt.gasUsedForL1) : null;

    for (const cite of cs) {
      const at = `${cite.file}:${cite.line ?? cite.where}`;
      // Proven-week records state the block.
      if (cite.block !== undefined) {
        if (cite.block !== block) fail(hash, `${at}: block ${cite.block}, receipt has ${block}`);
        else ok(hash, `${at} block`);
      }
      // Prose: "(block 314,364,181" right after the link.
      const prose = cite.after?.match(/^\)?\s*\(block ([\d,]+)/);
      if (prose) {
        if (Number(num(prose[1])) !== block)
          fail(hash, `${at}: says block ${prose[1]}, receipt has ${block}`);
        else ok(hash, `${at} block`);
      }
      if (!cite.row) continue;
      const linksInRow = [...cite.text.matchAll(TX_LINK)].length;
      for (const [k, name] of (cite.header ?? []).entries()) {
        const cell = cite.row[k] ?? "";
        const h = name.replace(/`/g, "").toLowerCase();
        // Creation tx: the row's address was created by this transaction (directly, or as a clone that logged).
        if (k === cite.col && /creation tx|^created$/.test(h)) {
          const target = cite.text.match(/\/address\/(0x[0-9a-fA-F]{40})/)?.[1];
          if (target) {
            const created =
              addr(receipt.contractAddress ?? "") === addr(target) ||
              receipt.logs.some((l) => addr(l.address) === addr(target));
            if (!created) fail(hash, `${at}: does not create ${target}`);
            else ok(hash, `${at} creates ${target.slice(0, 10)}`);
          }
          continue;
        }
        // The other columns of a row citing one transaction; the link's own cell only for a time ("17:31, spot ...").
        if (linksInRow !== 1 || !cell || /^pending$/i.test(cell)) continue;
        if (k === cite.col && !/\(utc\)/.test(h)) continue;
        if (h === "block") {
          const n = Number(num(cell));
          if (Number.isFinite(n) && n !== block) fail(hash, `${at}: block ${cell}, receipt has ${block}`);
          else ok(hash, `${at} block`);
        } else if (/\(utc\)/.test(h)) {
          // "2026-09-29 17:08", "14:54:00" or "17:31, spot ...": the block's time, floored to what is written.
          const t = cell.match(/^(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}(:\d{2})?/);
          if (!t) continue;
          const full = isoSecond(await blockTime(c, chainId, block));
          const want = (t[2] ? full : full.slice(0, 16)).slice(t[1] ? 0 : 11);
          if (t[0] !== want) fail(hash, `${at}: time ${t[0]}, block ${block} is ${full} UTC`);
          else ok(hash, `${at} time`);
        } else if (/^(gas used|gasused|gas)$/.test(h)) {
          if (BigInt(num(cell)) !== gasUsed) fail(hash, `${at}: gas ${cell}, receipt gasUsed ${gasUsed}`);
          else ok(hash, `${at} gasUsed`);
        } else if (h === "gasusedforl1" && gasL1 !== null) {
          if (BigInt(num(cell)) !== gasL1) fail(hash, `${at}: gasUsedForL1 ${cell}, receipt ${gasL1}`);
          else ok(hash, `${at} gasUsedForL1`);
        } else if (/^l2 (execution )?gas$/.test(h) && gasL1 !== null) {
          if (BigInt(num(cell)) !== gasUsed - gasL1)
            fail(hash, `${at}: L2 gas ${cell}, receipt ${gasUsed - gasL1}`);
          else ok(hash, `${at} L2 gas`);
        } else if (h === "recordhash on-chain") {
          const want = cell.match(/0x[0-9a-fA-F]{64}/)?.[0];
          const got = receipt.logs.map((l) => decodeLog(EVENTS.DecisionRecorded, l)).find(Boolean);
          if (want && (!got || got.recordHash.toLowerCase() !== want.toLowerCase()))
            fail(hash, `${at}: recordHash ${want}, the anchor recorded ${got?.recordHash ?? "nothing"}`);
          else if (want) ok(hash, `${at} recordHash`);
        }
      }
    }

    // The expected events.
    const decoded = [];
    for (const [i, spec] of (exp?.events ?? []).entries()) {
      const event = EVENTS[spec.event];
      if (!event) throw new Error(`check-claims.expect.json: unknown event ${spec.event}`);
      const candidates = receipt.logs
        .filter((l) => !spec.address || addr(l.address) === addr(spec.address))
        .map((l) => decodeLog(event, l))
        .filter(Boolean);
      const reasons = [];
      const match = candidates.find((args) => {
        const why = Object.entries(spec.args ?? {})
          .map(([f, want]) =>
            args[f] === undefined
              ? `${f} missing`
              : compare(args[f], want) && `${f} ${compare(args[f], want)}`,
          )
          .filter(Boolean);
        reasons.push(why.join("; "));
        return why.length === 0;
      });
      decoded[i] = match;
      if (!candidates.length)
        fail(hash, `${exp.claim}: no ${spec.event} event${spec.address ? ` from ${spec.address}` : ""}`);
      else if (!match) fail(hash, `${exp.claim}: ${spec.event} ${reasons.join(" | ")}`);
      else ok(hash, `${spec.event}`);
    }

    decodedByHash.set(hash, decoded);
  } catch (e) {
    if (e instanceof RpcUnreachable) {
      unreachable.set(chainId, e.message);
      skipped.set(hash, `chain ${chainId} RPC unreachable`);
      return;
    }
    throw e;
  }
});

// Figures stated next to a link must be amounts its receipt shows (or another receipt cited in the same sentence or
// row). Run after every receipt is decoded, so a text citing several transactions sees all their amounts.
for (const hash of hashes) {
  const exp = expectations[hash];
  if (!exp || !decodedByHash.has(hash)) continue;
  for (const cite of byHash.get(hash)) {
    if (!cite.text || !FIGURE_FILES.has(cite.file)) continue;
    const cited = [...new Set([...cite.text.matchAll(TX_LINK)].map((m) => m[2].toLowerCase()))];
    if (cited.some((h) => !expectations[h] || !decodedByHash.has(h))) continue; // a tx we have no amounts for
    const text = cite.row
      ? cite.row.filter((_, k) => !/^(time|block|gas|l2 gas)/i.test(cite.header?.[k] ?? "")).join(" | ")
      : cite.text;
    const figures = statedFigures(text);
    if (!figures.length) continue;
    const pool = { USDG: new Set(), USD: new Set() };
    const context = { USDG: {}, USD: {} };
    for (const h of cited) {
      const a = receiptAmounts(h, decodedByHash.get(h));
      for (const u of Object.keys(pool)) for (const x of a[u]) pool[u].add(x);
      for (const u of Object.keys(context)) Object.assign(context[u], expectations[h]?.context?.[u] ?? {});
    }
    for (const f of figures) {
      const shown = f.unit === "USD" ? `$${f.value}` : `${f.value} USDG`;
      if (figureMatches(f, pool, context)) ok(hash, `${cite.file}:${cite.line} states ${shown}`);
      else
        fail(
          hash,
          `${cite.file}:${cite.line} states ${shown}, which is not an amount in the receipt${cited.length > 1 ? "s it cites" : ""} (${[...pool[f.unit]].map((a) => formatUnits(a.raw, a.decimals)).join(", ") || "none"})`,
        );
    }
  }
}

// ------------------------------------------------------------------------------------------------ report

const total = hashes.length;
const failed = hashes.filter((h) => failures.has(h));
const skip = hashes.filter((h) => !failures.has(h) && skipped.has(h));
const verified = total - failed.length - skip.length;
const checks = [...passed.values()].reduce((n, v) => n + v.length, 0);

const GH = Boolean(process.env.GITHUB_ACTIONS);
for (const [id, why] of unreachable) {
  console.log(`warning: chain ${id} skipped, RPC unreachable (${why})`);
  if (GH) console.log(`::warning::Claims: chain ${id} skipped, its RPC did not answer`);
}
if (VERBOSE)
  for (const h of hashes)
    if (passed.has(h) && !failures.has(h))
      console.log(`ok   ${txChain.get(h) ?? "?"} ${h}  ${passed.get(h).join(", ")}`);
for (const h of failed) {
  console.log(`FAIL ${txChain.get(h) ?? "?"} ${h}`);
  for (const r of failures.get(h)) {
    console.log(`     ${r}`);
    if (GH) console.log(`::error::Claims: ${h.slice(0, 10)}… ${r}`);
  }
}
const chains = [...new Set(hashes.map((h) => txChain.get(h)).filter(Boolean))].sort();
console.log(
  `${verified} of ${total} cited transactions verified (${checks} checks on chains ${chains.join(", ")})` +
    (skip.length ? `; ${skip.length} skipped because an RPC did not answer` : "") +
    (failed.length ? `; ${failed.length} mismatched` : ""),
);
process.exit(failed.length ? 1 : 0);
