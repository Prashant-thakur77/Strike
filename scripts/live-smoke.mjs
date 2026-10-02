#!/usr/bin/env node
// Live smoke test: read-only checks against the production app, the same ones GitHub Actions runs every hour
// (.github/workflows/live-smoke.yml). No key, no wallet, no transaction, no dependency beyond Node 22.
//
//   node scripts/live-smoke.mjs                       every check, a table on stdout
//   node scripts/live-smoke.mjs --only mcp,freshness  some groups: pages, api, mcp, freshness
//   node scripts/live-smoke.mjs --base http://localhost:3000 --markdown report.md --json result.json
//
// Groups:
//   pages      /, /app, a vault page, /app/proof and /app/faucet answer 200 with their title and one line of text
//   api        /api/stats, /api/mirror-audit for every mirrored chain (`ok` must be true), /api/option for the
//              series in the deployment files, /skill.md and /llms.txt
//   mcp        the remote MCP at /api/mcp: initialize, tools/list (every tool read-only), one list_vaults call
//   freshness  per mirrored chain, the last MirrorFeed round against Robinhood Chain mainnet's Chainlink feeds.
//              Only ever a warning: a mainnet print not mirrored after SMOKE_MIRROR_LAG_MINUTES (default 90), or,
//              on an NYSE trading day two hours after the open, no round mirrored since the open
// Addresses, series and RPCs come from strike.config.json and the deployment files it lists, so nothing here
// changes when a deployment does. STRIKE_APP_URL (or --base) overrides the app URL (services.app).
//
// Exit status: 0 when no check failed (warnings allowed), 1 when one did, 2 on a usage error.
// In GitHub Actions each warning and failure is also an annotation, and the table goes to the job summary.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, "strike.config.json"), "utf8"));
const GROUPS = ["pages", "api", "mcp", "freshness"];
const LAG_MINUTES = Number(process.env.SMOKE_MIRROR_LAG_MINUTES || 90);
// Robinhood Chain mainnet's second public RPC (viem's chain definition; ci.yml's fork job falls back to it too):
// the first one sometimes answers GitHub's runners with a Cloudflare 403.
const MAINNET_FALLBACK_RPC = "https://rpc.ordofi.network";

function usage(message) {
  if (message) console.error(`live-smoke: ${message}`);
  console.error(
    "usage: node scripts/live-smoke.mjs [--base <url>] [--only pages,api,mcp,freshness] [--markdown <file>] [--json <file>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const o = { base: process.env.STRIKE_APP_URL || CONFIG.services.app, only: GROUPS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--base") o.base = value();
    else if (a === "--only") o.only = value().split(",");
    else if (a === "--markdown") o.markdown = value();
    else if (a === "--json") o.json = value();
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument ${a}`);
  }
  for (const g of o.only) if (!GROUPS.includes(g)) usage(`unknown group ${g}`);
  o.base = o.base.replace(/\/+$/, "");
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));

// ---------------------------------------------------------------- deployments (the keeper's rule)

/** The chain's active deployment files, the primary first: listed in strike.config.json, not superseded. */
function deploymentsOf(chainId) {
  return (CONFIG.chains[chainId]?.deployments ?? [])
    .map((file) => {
      try {
        return { file, ...readJson(file) };
      } catch {
        return null;
      }
    })
    .filter((d) => d && !String(d.status ?? "").startsWith("superseded"));
}

/** Chains whose MirrorFeeds copy mainnet Chainlink rounds (the keeper's and the mirror audit's chains). */
const MIRRORED = Object.entries(CONFIG.chains)
  .filter(([id, c]) => c.mainnetFeedsChain && !c.local && deploymentsOf(id).length)
  .map(([id]) => id);

// ---------------------------------------------------------------- HTTP

/** One request, retried once after 5 s on a network error, a timeout or a 5xx. */
async function request(path, { method = "GET", headers = {}, body, timeoutMs = 30_000 } = {}) {
  const url = path.startsWith("http") ? path : opts.base + path;
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { "user-agent": "strike-live-smoke", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.status >= 500 && attempt < 2) {
        await sleep(5000);
        continue;
      }
      return {
        status: res.status,
        type: res.headers.get("content-type") ?? "",
        text,
        ms: Date.now() - started,
      };
    } catch (e) {
      if (attempt < 2) {
        await sleep(5000);
        continue;
      }
      throw new Error(`${method} ${url}: ${e.cause?.code ?? e.name ?? ""} ${e.message}`.trim());
    }
  }
}

function json(res, what) {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`${what}: not JSON (HTTP ${res.status}, ${res.type || "no content type"})`);
  }
}

// &amp; goes last: decoding it first would turn "&amp;quot;" into "&quot;" and then into a quote (double decoding).
const decode = (s) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// A table cell: the backslash is escaped first, so the one added before a pipe is not itself escaped again.
const mdCell = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

// ---------------------------------------------------------------- checks

const results = [];
const pass = (detail) => ({ status: "pass", detail });
const warn = (detail) => ({ status: "warn", detail });
const fail = (detail) => ({ status: "fail", detail });

async function check(group, name, fn) {
  const started = Date.now();
  let r;
  try {
    r = await fn();
  } catch (e) {
    // The freshness group reads public RPCs: a failed read there is a warning, never a failure.
    r = group === "freshness" ? warn(e.message) : fail(e.message);
  }
  results.push({ group, name, ...r, ms: Date.now() - started });
}

function pageChecks() {
  const primary = deploymentsOf(String(CONFIG.defaultChainId))[0];
  let vault;
  try {
    vault = readJson(primary.file.replace(/\.json$/, "-vaults.json")).TSLA_covered_call;
  } catch {
    vault = primary?.vaults?.TSLA_covered_call;
  }
  // [path, <title>, one line of server-rendered text]. The lines are the pages' own sentences (app/src/lib/tour.ts,
  // the landing hero); the vault page renders its data in the browser, so its shell is what a fetch can see.
  const pages = [
    ["/", "Strike · Weekly options vaults for stock tokens", "Open app"],
    ["/app", "Vaults · Strike", "Pick a vault"],
    [`/app/vault/${vault}`, "Vault · Strike", "Propose a strike for this vault"],
    ["/app/proof", "Proof · Strike", "Check every claim yourself"],
    ["/app/faucet", "Faucet · Strike", "Get free test tokens"],
  ];
  return pages.map(([path, title, text]) =>
    check(
      "pages",
      path.replace(/0x[0-9a-fA-F]{40}/, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`),
      async () => {
        const res = await request(path);
        if (res.status !== 200) return fail(`HTTP ${res.status}`);
        const got = decode(res.text.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "");
        if (got !== title) return fail(`title "${got}", expected "${title}"`);
        if (!decode(res.text).includes(text)) return fail(`"${text}" not in the page`);
        return pass(`200, "${title}", "${text}"`);
      },
    ),
  );
}

function apiChecks() {
  const checks = [];
  checks.push(
    check("api", "/api/stats", async () => {
      const res = await request("/api/stats", { timeoutMs: 60_000 });
      if (res.status !== 200) return fail(`HTTP ${res.status}: ${res.text.slice(0, 160)}`);
      const d = json(res, "/api/stats");
      if (!Array.isArray(d.deployments) || d.deployments.length === 0)
        return fail("no deployments in the answer");
      const vaults = d.deployments.reduce((n, x) => n + (x.vaults ?? 0), 0);
      const line = `${d.deployments.length} deployments (${d.deployments.map((x) => x.key).join(", ")}), ${vaults} vaults, generated ${d.generatedAt}`;
      if (d.errors?.length) return warn(`${line}; errors: ${JSON.stringify(d.errors).slice(0, 200)}`);
      return pass(line);
    }),
  );
  for (const chain of MIRRORED) {
    const path = `/api/mirror-audit?chain=${chain}`;
    checks.push(
      check("api", path, async () => {
        const res = await request(path, { timeoutMs: 120_000 });
        if (res.status !== 200) return fail(`HTTP ${res.status}: ${res.text.slice(0, 160)}`);
        const d = json(res, path);
        const line = `ok ${d.ok}: ${d.matched}/${d.rounds} rounds match mainnet, ${d.mismatched} mismatched (checked ${d.checkedAt})`;
        return d.ok === true ? pass(line) : fail(line);
      }),
    );
  }
  // The live series named in the deployment files (epoch1.callVaultSeries), without chainId: the route has to
  // find the deployment itself, which is how a wallet following OptionToken.uri() asks.
  for (const chain of MIRRORED) {
    for (const d of deploymentsOf(chain)) {
      const series = d.epoch1?.callVaultSeries;
      if (!series) continue;
      const hex = BigInt(series).toString(16).padStart(64, "0");
      const path = `/api/option/${hex}.json`;
      checks.push(
        check("api", `/api/option/${hex.slice(0, 8)}… (${d.file.split("/").pop()})`, async () => {
          const res = await request(path);
          if (res.status !== 200) return fail(`HTTP ${res.status}: ${res.text.slice(0, 160)}`);
          const m = json(res, path);
          const chainAttr = m.attributes?.find((a) => a.trait_type === "Chain id")?.value;
          if (String(chainAttr) !== chain) return fail(`chain id ${chainAttr}, expected ${chain}`);
          if (d.epoch1.strike && !m.name?.includes(d.epoch1.strike))
            return fail(`name "${m.name}" lacks the strike ${d.epoch1.strike}`);
          const status = m.attributes?.find((a) => a.trait_type === "Status")?.value;
          return pass(`"${m.name}", chain ${chainAttr}, ${status ?? "no status"}`);
        }),
      );
    }
  }
  checks.push(
    check("api", "/skill.md", async () => {
      const res = await request("/skill.md");
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      if (!res.type.includes("markdown")) return fail(`content type ${res.type}`);
      if (!/^---\s*\nname: strike\b/.test(res.text)) return fail("no `name: strike` front matter");
      return pass(`200, ${res.type}, ${res.text.length} bytes`);
    }),
    check("api", "/llms.txt", async () => {
      const res = await request("/llms.txt");
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      if (!res.type.startsWith("text/plain")) return fail(`content type ${res.type}`);
      if (!res.text.startsWith("# Strike")) return fail("does not start with '# Strike'");
      const missing = MIRRORED.filter((c) => !res.text.includes(c));
      if (missing.length) return fail(`chain ${missing.join(", ")} not mentioned`);
      return pass(`200, ${res.type}, ${res.text.length} bytes`);
    }),
  );
  return checks;
}

/** One MCP JSON-RPC call to the remote server (stateless: no session id), answered as JSON or as SSE. */
async function mcp(method, params, id) {
  const res = await request("/api/mcp", {
    method: "POST",
    timeoutMs: 60_000,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status}: ${res.text.slice(0, 160)}`);
  let body = res.text;
  if (res.type.includes("text/event-stream")) {
    body = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5))
      .join("");
  }
  const d = json({ ...res, text: body }, method);
  if (d.error) throw new Error(`${method}: error ${d.error.code} ${d.error.message}`);
  return d.result;
}

function mcpChecks() {
  // Sequential, the order a client uses them.
  return [
    (async () => {
      await check("mcp", "initialize", async () => {
        const r = await mcp(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "strike-live-smoke", version: "1" },
          },
          1,
        );
        if (!r?.serverInfo?.name) return fail("no serverInfo in the answer");
        return pass(`server ${r.serverInfo.name} ${r.serverInfo.version}, protocol ${r.protocolVersion}`);
      });
      await check("mcp", "tools/list", async () => {
        const r = await mcp("tools/list", {}, 2);
        const tools = r?.tools ?? [];
        if (!tools.some((t) => t.name === "list_vaults")) return fail("no list_vaults tool");
        const writable = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
        if (writable.length) return fail(`tools not marked read-only: ${writable.join(", ")}`);
        return pass(`${tools.length} tools, all read-only: ${tools.map((t) => t.name).join(", ")}`);
      });
      await check("mcp", "tools/call list_vaults", async () => {
        const r = await mcp("tools/call", { name: "list_vaults", arguments: {} }, 3);
        const text = r?.content?.find((c) => c.type === "text")?.text ?? "";
        if (r?.isError) return fail(`tool error: ${text.slice(0, 200)}`);
        const d = json({ text, status: 200, type: "tool text" }, "list_vaults");
        if (!d.vaults?.length) return fail("no vaults");
        const states = d.vaults.map((v) => `${v.symbol} ${v.epochState}`).join(", ");
        return pass(`chain ${d.chainId}, ${d.vaults.length} vaults: ${states}`);
      });
    })(),
  ];
}

// ---------------------------------------------------------------- freshness (eth_call over fetch)

function rpcUrls(chainId) {
  const urls = [CONFIG.chains[chainId]?.rpc?.public].filter(Boolean);
  if (chainId === "4663") urls.push(MAINNET_FALLBACK_RPC);
  // Last resort: the app's own read-only proxy (POST /api/rpc/<chainId>), which serves 46630, 421614 and 4663.
  urls.push(`${opts.base}/api/rpc/${chainId}`);
  return urls;
}

/** eth_calls as one JSON-RPC batch, trying each RPC in turn; a call that reverts comes back as null. */
async function ethCalls(chainId, calls) {
  const errors = [];
  const batch = calls.map(([to, data], id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  }));
  for (const url of rpcUrls(chainId)) {
    try {
      const res = await request(url, {
        method: "POST",
        timeoutMs: 20_000,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
      const answers = JSON.parse(res.text);
      if (!Array.isArray(answers)) throw new Error(answers.error?.message ?? `HTTP ${res.status}`);
      const byId = new Map(answers.map((a) => [a.id, a]));
      // A rate-limited RPC answers some calls with an error that is not a revert: try the next RPC.
      if (
        answers.length !== calls.length ||
        answers.some((a) => a.error && a.error.code !== 3 && !/revert/i.test(a.error.message))
      )
        throw new Error(
          `batch of ${calls.length}: ${answers.find((a) => a.error)?.error?.message ?? "incomplete"}`,
        );
      return calls.map((_, id) => {
        const r = byId.get(id)?.result;
        return typeof r === "string" && r.length > 2 ? r : null;
      });
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error(`eth_call on ${chainId} failed: ${errors.join("; ")}`);
}

async function ethCall(chainId, to, data) {
  const [r] = await ethCalls(chainId, [[to, data]]);
  if (!r) throw new Error(`eth_call ${to} on ${chainId} reverted`);
  return r;
}

const word = (hex, i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const uint = (n) => BigInt(n).toString(16).padStart(64, "0");
const SEL = {
  latestRoundData: "0xfeaf968c", // latestRoundData()
  getRoundData: "0x9a6fc8f5", // getRoundData(uint80)
  isTradingDay: "0xba5ec563", // isTradingDay(uint256)
  sessionOf: "0xbb2c9ef6", // sessionOf(uint256)
};
const hhmm = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const ago = (s) => (s >= 5400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
const WALK_BACK = 40; // mainnet rounds read back to find the first print the mirror has not caught up with

/** One mirrored feed: the mirror's last round, mainnet's last print and the first mainnet print after the mirror's
 *  (the keeper pushes mainnet's latest round each run, so that print is the one that has waited longest). */
async function feedState(chain, feedsChain, feed, source) {
  const mirrored = Number(word(await ethCall(chain, feed, SEL.latestRoundData), 3));
  const latest = await ethCall(feedsChain, source, SEL.latestRoundData);
  const round = word(latest, 0);
  const printed = Number(word(latest, 3));
  let firstUnmirrored = printed > mirrored ? printed : null;
  let atLeast = false;
  if (firstUnmirrored) {
    const ids = Array.from({ length: WALK_BACK }, (_, i) => round - BigInt(i + 1)).filter((r) => r > 0n);
    const answers = await ethCalls(
      feedsChain,
      ids.map((r) => [source, SEL.getRoundData + uint(r)]),
    );
    atLeast = true;
    for (const a of answers) {
      const at = a ? Number(word(a, 3)) : 0; // a revert (start of a Chainlink phase) ends the walk
      if (at <= mirrored) {
        atLeast = false;
        break;
      }
      firstUnmirrored = at;
    }
  }
  return { mirrored, printed, firstUnmirrored, atLeast };
}

function freshnessChecks() {
  return MIRRORED.map((chain) =>
    check("freshness", `mirror ${chain} (${CONFIG.chains[chain].shortName})`, async () => {
      const feedsChain = CONFIG.chains[chain].mainnetFeedsChain;
      const mainnet = CONFIG.chains[feedsChain]?.stocks ?? {};
      const deployments = deploymentsOf(chain);
      const feeds = new Map(); // testnet feed -> { symbol, source }
      for (const d of deployments)
        for (const [symbol, s] of Object.entries(d.stocks ?? {}))
          if (mainnet[symbol]?.feed && !feeds.has(s.feed.toLowerCase()))
            feeds.set(s.feed.toLowerCase(), { symbol, source: mainnet[symbol].feed });
      const now = Math.floor(Date.now() / 1000);
      const rows = await Promise.all(
        [...feeds].map(async ([feed, { symbol, source }]) => ({
          symbol,
          ...(await feedState(chain, feedsChain, feed, source)),
        })),
      );
      const newest = rows.reduce((a, b) => (b.mirrored > a.mirrored ? b : a));
      const behind = rows.filter((r) => r.firstUnmirrored && now - r.firstUnmirrored > LAG_MINUTES * 60);
      const problems = behind.map(
        (r) =>
          `${r.symbol}: mainnet printed at ${r.atLeast ? "or before " : ""}${hhmm(r.firstUnmirrored)}, ` +
          `last mirrored round ${hhmm(r.mirrored)}`,
      );
      if (problems.length) problems.unshift(`keeper behind by more than ${LAG_MINUTES} min`);
      // On an NYSE trading day, two hours after the open, expect at least one round since the open.
      const calendar = deployments[0].marketCalendar;
      const day = Math.floor(now / 86400);
      let session = "";
      if (calendar) {
        const trading = word(await ethCall(chain, calendar, SEL.isTradingDay + uint(day)), 0) === 1n;
        if (trading) {
          const s = await ethCall(chain, calendar, SEL.sessionOf + uint(day));
          const open = Number(word(s, 0));
          session = `; trading day, open ${hhmm(open)}`;
          const printedSinceOpen = rows.some((r) => r.printed >= open);
          if (now > open + 7200 && newest.mirrored < open)
            problems.push(
              `no round mirrored since the open (${hhmm(open)})` +
                (printedSinceOpen
                  ? ", although mainnet has printed since"
                  : "; mainnet has not printed since either"),
            );
        } else session = "; not a trading day";
      }
      const line =
        `${rows.length} feeds; newest round ${newest.symbol} ${hhmm(newest.mirrored)} (${ago(now - newest.mirrored)} ago)` +
        `; ${rows.filter((r) => r.printed > r.mirrored).length} with a newer mainnet print${session}`;
      return problems.length ? warn(`${problems.join("; ")} (${line})`) : pass(line);
    }),
  );
}

// ---------------------------------------------------------------- run and report

const startedAt = new Date();
const groups = { pages: pageChecks, api: apiChecks, mcp: mcpChecks, freshness: freshnessChecks };
await Promise.all(opts.only.flatMap((g) => groups[g]()));
results.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));

const count = (s) => results.filter((r) => r.status === s).length;
const totals = { pass: count("pass"), warn: count("warn"), fail: count("fail") };
const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL" };
const width = Math.max(...results.map((r) => r.group.length + r.name.length + 1));
console.log(`Live smoke: ${opts.base} at ${startedAt.toISOString()}`);
for (const r of results) {
  const secs = `${(r.ms / 1000).toFixed(1)} s`.padStart(7);
  console.log(`${LABEL[r.status]}  ${`${r.group} ${r.name}`.padEnd(width)}  ${secs}  ${r.detail}`);
}
console.log(`Result: ${totals.pass} passed, ${totals.warn} warnings, ${totals.fail} failed`);

const ICON = { pass: "pass", warn: "warning", fail: "**FAIL**" };
const md = [
  `### Live smoke: ${totals.fail ? `${totals.fail} failed` : "passed"}${totals.warn ? `, ${totals.warn} warnings` : ""}`,
  "",
  `${opts.base} at ${startedAt.toISOString()}: ${totals.pass} passed, ${totals.warn} warnings, ${totals.fail} failed.`,
  "",
  "| Result | Check | Detail |",
  "| ------ | ----- | ------ |",
  ...results.map((r) => `| ${ICON[r.status]} | ${r.group} \`${r.name}\` | ${mdCell(r.detail)} |`),
  "",
].join("\n");
if (opts.markdown) writeFileSync(opts.markdown, md);
if (opts.json)
  writeFileSync(
    opts.json,
    JSON.stringify({ base: opts.base, at: startedAt.toISOString(), totals, results }, null, 2),
  );
if (process.env.GITHUB_ACTIONS) {
  for (const r of results.filter((x) => x.status !== "pass"))
    console.log(`::${r.status === "fail" ? "error" : "warning"} title=${r.group} ${r.name}::${r.detail}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
process.exit(totals.fail ? 1 : 0);
