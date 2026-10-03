// The demo walkthrough, scene by scene, on the arc problem -> turn -> key features -> architecture -> one user's
// walkthrough of the live product -> challenges and solutions -> close. Each scene: what is said (`lines`, captioned
// word for word), what is on screen (`prepare` runs before the clock starts, `run` on the clock), its caption tag,
// and `chapter` where a chapter of the YouTube description starts. Durations come from the narration audio, so
// editing a line re-times its scene. Numbers come from README.md and the epoch logs (facts, facts.arb) or the live
// app and chain, read at render time. Plan and reasons: docs/submission/demo-script.md.
//
// Adding a scene is one entry in the list returned by scenes(). The settle scene shows the walkthrough vault's week as
// /api/status reports it at render time: while it waits for its settlement price, the vault page's "Expired, settling"
// state and the epoch trace; the render stops if the series has settled, so the video never shows a stale state.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { STRIKE_CONFIG, chainConfig } from "./lib/config.mjs";
import { L, ROOT } from "./lib/engine.mjs";
import { sayDec, sayInt, sayUsd } from "./lib/facts.mjs";
import { signingContext, signingPrepare, signingRun } from "./lib/wallet.mjs";

export const APP = (process.env.APP_URL ?? STRIKE_CONFIG.services.app).replace(/\/$/, "");
export const EXPLORER = chainConfig(46630).explorer;
const ARBISCAN = chainConfig(421614).explorer;
const ARB_RPC = chainConfig(421614).rpc.public;
const REJECT_TX = "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0";
// sTSLA-CC, v2 on 46630
const CC_VAULT = JSON.parse(
  readFileSync(join(ROOT, "contracts/deployments/46630-vaults.json"), "utf8"),
).TSLA_covered_call;
// sTSLA-CSP-A2, the vault agent #2 created on 1 October (v2 on 46630), selling its first week in the video
const A2_VAULT = JSON.parse(readFileSync(join(ROOT, "video/clips/agent2.json"), "utf8")).vault;
// decision pages: agent #2's accepted put of 2 October and agent #1's rejected put of 1 October
const DECISION_OK = "/app/decision/46630/2026-10-02-sTSLA-CSP-A2";
const DECISION_REJECTED = "/app/decision/46630/2026-10-01-sTSLA-CSP";
// dry runs of the specialist pipeline on 3 October (docs/agent-log/dry-runs/, linked from the agents page): planned by
// Claude as if the NYSE were open, and the weekend run the market analyst stopped
const DRY_CLAUDE = "/app/decision/46630/2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run-2?dry=1";
const DRY_CLOSED = "/app/decision/46630/2026-10-03-sTSLA-CSP-dry-run?dry=1";
// the market-hours scene shows the app as a viewer in Singapore (the buildathon's city) sees it
const VIEWER_TZ = "Asia/Singapore";
const U = "U S D G"; // Chatterbox reads "USDG" as a word
const EM = "Eepok Manager"; // "Epoch Manager" as Chatterbox should say it (Whisper hears "epoch manager")
// a desktop Chrome user agent for Arbiscan, whose bot check stops a headless one
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const require = createRequire(join(ROOT, "app", "package.json"));

/** "0.20" -> "zero point two oh", "0.35" -> "zero point three five" */
const sayDelta = (d) =>
  `zero point ${[...String(d).split(".")[1]].map((c) => (c === "0" ? "oh" : sayInt(c))).join(" ")}`;
const round2 = (x) => Number(x).toFixed(2);

/** Read before narrating: values the app and the chain show live. */
export async function probe(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("strike.ack.v1", "1");
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(`${APP}/app/monitor`);
  await page.getByText("NVIDIA").first().waitFor({ timeout: 60_000 });
  const mult = await nvdaMultiplier(page);
  if (!mult) throw new Error("NVDA multiplier not found on /app/monitor");
  // the vault's worst case this week, from the Stylus risk engine (the Risk section of the vault page)
  await page.goto(`${APP}/app/vault/${CC_VAULT}`);
  const worst = await page
    .waitForFunction(() => document.body.innerText.match(/Worst\s*[−-]\$([\d,]+\.\d\d)/)?.[1], null, {
      timeout: 60_000,
    })
    .then((h) => h.jsonValue());
  // agent #2's decision page: where the week starts losing and the model's odds, as the page computes them
  await page.goto(`${APP}${DECISION_OK}`);
  const lose = await page
    .waitForFunction(
      () => {
        const t = document.body.innerText;
        const be = t.match(/lose money on this series if TSLA settles below \$([\d,]+\.\d\d)/)?.[1];
        const odds = t.match(/Model odds of exercise:\s*([\d.]+)%/)?.[1];
        return be && odds ? { breakEven: be.replace(/,/g, ""), odds } : null;
      },
      null,
      { timeout: 60_000 },
    )
    .then((h) => h.jsonValue());
  // the proof page's price mirror audit (Robinhood Chain testnet): every mirrored round checked against mainnet
  await page.goto(`${APP}/app/proof`);
  const audit = await page
    .waitForFunction(
      () =>
        document.body.innerText
          .match(/(\d+) of (\d+) rounds match Robinhood Chain mainnet Chainlink/)
          ?.slice(1, 3),
      null,
      { timeout: 90_000 },
    )
    .then((h) => h.jsonValue());
  if (audit[0] !== audit[1]) throw new Error(`price mirror audit: ${audit[0]} of ${audit[1]} rounds match`);
  // the lessons page: how many lessons, and how many are fixed
  await page.goto(`${APP}/app/lessons`);
  const lessons = await page
    .waitForFunction(
      () => document.body.innerText.match(/Lessons\s*\n\s*(\d+)\s*\n\s*(\d+) fixed/i)?.slice(1, 3),
      null,
      { timeout: 60_000 },
    )
    .then((h) => h.jsonValue());
  await ctx.close();
  const { claimsCheck } = await import("./lib/facts.mjs");
  return {
    nvdaMultiplier: mult,
    nvdaMultiplierSaid: Number(mult).toFixed(6),
    riskWorst: worst.replace(/,/g, ""),
    ...lose,
    mirrorRounds: audit[0],
    lessons: lessons[0],
    lessonsFixed: lessons[1],
    claims: claimsCheck(ROOT),
    ...(await settlementProbe()),
    ...(await mcpProbe()),
    ...(await anchorProbe()),
  };
}

/** The walkthrough vault's week from /api/status: settled or not, its expiry and the TSLA feed's last print. */
async function settlementProbe() {
  const st = await (await fetch(`${APP}/api/status`)).json();
  const chain = st.chains.find((c) => c.chainId === 46630);
  const vault = chain.deployments.flatMap((d) => d.vaults).find((v) => v.address === CC_VAULT);
  const feed = chain.feeds.find((f) => f.symbol === "TSLA");
  if (!vault || !feed) throw new Error("/api/status: no sTSLA-CC vault or TSLA feed on 46630");
  const hhmm = (s) => new Date(s * 1000).toISOString().slice(11, 16);
  const settled =
    vault.lastSettlement && Number(vault.lastSettlement.epoch) >= Number(vault.epoch)
      ? vault.lastSettlement
      : null;
  return {
    settled, // null while the series waits for its settlement price
    expiry: vault.expiry,
    expiryHhmm: vault.expiry ? hhmm(vault.expiry) : null,
    lastPrint: feed.updatedAt,
    lastPrintHhmm: hhmm(feed.updatedAt),
    marketOpen: chain.marketOpen,
  };
}

/** The public MCP endpoint and the skill file, asked at render time (read-only). */
async function mcpProbe() {
  const { readmeFacts } = await import("./lib/facts.mjs");
  const f = readmeFacts(ROOT);
  const res = await fetch(f.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await res.text();
  const json = JSON.parse(body.startsWith("{") ? body : body.match(/data: (\{.*\})/)[1]);
  const tools = json.result.tools.map((t) => t.name);
  if (tools.length < 5) throw new Error(`MCP tools/list returned ${tools.length} tools`);
  const skill = (await (await fetch(f.skillUrl)).text()).split("\n").filter((l) => l.trim());
  return { mcpTools: tools, skillHead: skill.slice(0, 3) };
}

/** Re-hash the Claude-planned decision record and read its anchor from the DecisionLog on Arbitrum Sepolia: the
 *  DecisionRecorded event of the anchoring transaction (latestHash moves on when a later record for the same epoch,
 *  such as the settlement's, is anchored; the event of the original anchor stays). */
async function anchorProbe() {
  const { keccak256, toBytes, createPublicClient, http, parseAbi, parseEventLogs } = require("viem");
  const rec = JSON.parse(
    readFileSync(join(ROOT, "docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json"), "utf8"),
  );
  // the bytes the agent hashed: the record without its anchor and without the anchoring transaction
  // (agents/example/src/anchor.ts, unanchoredJson)
  const { anchor, ...rest } = rec;
  const unanchored = {
    ...rest,
    transactions: rest.transactions.filter((t) => t.label !== "DecisionLog.record"),
  };
  const recomputed = keccak256(toBytes(`${JSON.stringify(unanchored, null, 2)}\n`));
  const client = createPublicClient({ transport: http(ARB_RPC) });
  const receipt = await client.getTransactionReceipt({ hash: anchor.txHash });
  const ev = parseEventLogs({
    abi: parseAbi([
      "event DecisionRecorded(uint256 indexed agentId, address indexed vault, uint64 indexed epoch, bytes32 recordHash, string uri, uint256 timestamp)",
    ]),
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === anchor.contract.toLowerCase()),
  }).find(
    (e) =>
      e.args.agentId === BigInt(rec.agent.agentId) &&
      e.args.vault.toLowerCase() === rec.vault.address.toLowerCase() &&
      e.args.epoch === BigInt(anchor.epoch),
  );
  const onchain = ev?.args.recordHash;
  if (recomputed !== anchor.recordHash || onchain !== anchor.recordHash)
    throw new Error(`anchor: file ${anchor.recordHash}, recomputed ${recomputed}, on-chain ${onchain}`);
  return { anchorHash: onchain, anchorBlock: String(receipt.blockNumber) };
}

async function nvdaMultiplier(page) {
  return page
    .waitForFunction(
      () => {
        const leaf = (root, test) =>
          [...root.querySelectorAll("*")].find(
            (el) => el.children.length === 0 && test(el.textContent.trim()),
          );
        const isMult = (t) => /^1\.\d{6,}$/.test(t);
        let row = leaf(document.body, (t) => t === "NVIDIA");
        while (row && !leaf(row, isMult)) row = row.parentElement;
        if (!row || leaf(row, (t) => t === "Tesla" || t === "Amazon")) return null;
        return leaf(row, isMult).textContent.trim();
      },
      null,
      { timeout: 60_000 },
    )
    .then((h) => h.jsonValue());
}

async function openApp(page, path, ready) {
  await page.goto(`${APP}${path}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  if (ready) await ready();
  await page.evaluate(() => document.fonts.ready);
}

/** Box and zoom on the card around a label (its parent element, `up` levels up, or its closest `closest`). */
async function focusCard(h, re, { up = 1, scale = 1.45, dim = 0.22, closest = null } = {}) {
  await h.page.evaluate(
    ([src, flags, up, scale, dim, closest]) => {
      const v = window.__v;
      document.querySelectorAll(".__vbox").forEach((d) => d.remove());
      let el = v.leaf(src, flags);
      if (!el) throw new Error(`no element matches /${src}/`);
      if (closest) el = el.closest(closest);
      else for (let i = 0; i < up; i++) el = el.parentElement;
      const r = v.rect(el);
      v.box(r, { pad: 10, dim });
      v.zoomRect(r, scale);
    },
    [re.source, re.flags, up, scale, dim, closest],
  );
}

/** Scroll so the element matching `re` sits `offset` px from the top, before the clock starts. */
async function scrollToText(page, re, offset) {
  const y = await page
    .getByText(re)
    .first()
    .evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => window.__v.scrollTo(y, 0), y - offset);
}

/** Start a three.js scene's clock on the recorder's clock, with its cues (seconds on the scene clock). */
async function play3d(h, cues) {
  await h.page.evaluate(([c, now]) => window.__3d.play(c, now), [cues, h.now()]);
}

/** The Claude-planned run on Arbitrum Sepolia, from its epoch log, as the terminal shows it. */
function claudeRun(a) {
  const md = readFileSync(join(ROOT, "docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md"), "utf8");
  const block = md.match(/```\n(Strike example agent \(Claude mode\)[\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error("Arbitrum epoch log: the Claude run's output block was not found");
  const out = [];
  let inWhy = false;
  for (const raw of block.split("\n")) {
    if (inWhy) {
      if (/^ {4}\S/.test(raw)) continue; // the rest of the log's wrapped reasoning
      inWhy = false;
    }
    if (/^\s*Claude calls vault_state/.test(raw)) {
      // the log condenses the tool calls into one line; the terminal shows one per line, as the agent prints them
      out.push("    Claude calls vault_state");
      for (const c of a.candidates)
        out.push(`    Claude calls risk_check   Δ ${c.delta} at ${c.pct}% of fair value`);
      out.push("    Claude calls agent_stats");
      continue;
    }
    if (/^\s*Why: /.test(raw)) {
      // the first two sentences of Claude's reasoning, from the decision record
      const two = a.reasoning
        .match(/^(.+?\.)\s+(.+?\.)\s/)
        ?.slice(1, 3)
        .join(" ");
      out.push(`    Why: ${two} [...]`);
      inWhy = true;
      continue;
    }
    out.push(raw.replace(/series (\d{6})\d+(\d{4})/g, "series $1…$2"));
  }
  return out;
}

/** The positioning chart (2000×1520 png), scaled to fit above the caption bar with margins. */
const IMG_H = 870,
  IMG_W = Math.round((IMG_H * 2000) / 1520),
  IMG_TOP = 30;

/** The competition rows the video shows (scripts/charts/data/competition.json has all of them). */
const COMP_ROWS = [
  "Who picks the strike",
  "On-chain agent mandate",
  "Slashing paid to depositors",
  "Oracle-anchored pricing",
  "Stock-token (ERC-8056) safety",
];

export function scenes(f, live) {
  const comp = JSON.parse(readFileSync(join(ROOT, "scripts/charts/data/competition.json"), "utf8"));
  for (const name of [
    "Strike",
    "Stonkhouse",
    "Archer Markets",
    "Ribbon / Aevo",
    "Derive (Lyra)",
    "Thetanuts",
    "Tilt Protocol",
  ])
    if (!comp.projects.includes(name)) throw new Error(`competition.json: no project "${name}"`);
  if (comp.rows.filter((r) => COMP_ROWS.includes(r.row)).length !== COMP_ROWS.length)
    throw new Error("competition.json: a row the video shows is missing");
  const mult = live.nvdaMultiplierSaid;
  const a = f.arb;
  const m = a.mandate;
  const prem = round2(a.buyPerOption);
  const worst = round2(a.worstLoss);
  return [
    // ============================================================================================ 1. the problem
    {
      id: "problem",
      chapter: "The problem",
      kind: "footage",
      screen:
        "Stock footage (Pexels, free licence; credits in docs/media/CREDITS.md): stock-exchange columns, a stock app on a phone, a man on Wall Street, a chart on paper, a ticker, candlesticks, a worried face; cut on the narration.",
      tag: "The problem",
      lines: [
        L("Millions of people own stocks."),
        L("On Robinhood Chain, stocks are tokens, | but a token earns nothing while it sits."),
        L(
          "Wall Street holders sell covered calls for income, | but someone must pick each week's strike, | and you must trust them.",
        ),
        L(
          "On-chain it's harder: | multipliers easy to apply twice, | weekend price freezes, | pauses, mid-week splits.",
        ),
        L("So tokens sit idle, | or go to managers nobody can check."),
      ],
      // shot list: which clip plays from which caption chunk (line, chunk); clips in video/footage.json
      shots: [
        ["floor", 0, 0],
        ["phone", 1, 0],
        ["idle", 1, 1],
        ["screens", 2, 0],
        ["chart", 2, 1],
        ["worried", 2, 2],
        ["ticker", 3, 0],
        ["candles", 3, 2],
        ["waiting", 4, 0],
      ],
    },
    // ============================================================================================ 2. the turn
    {
      id: "turn",
      chapter: "Strike and its key features",
      kind: "replay",
      screen: "The wordmark, the one-liner and two promises, appearing as they are said.",
      tag: "Strike",
      replay: {
        mode: "turn",
        imagine:
          "An AI agent that picks the strike every week.<br><em>A contract that won't let it break the rules.</em>",
        title: "Weekly options vaults for Robinhood Chain stock tokens.",
        promises: [
          "Weekly premium on stock tokens, paid in USDG",
          "An AI agent picks the strike; the contract holds it to a mandate",
        ],
      },
      lines: [
        L("Now imagine an agent picking the strike each week, | held to the rules by a contract."),
        L("This is Strike: | options vaults for stock tokens."),
      ],
      async run(h) {
        await h.cue(1, -0.2);
        await h.page.evaluate(() => window.__turn.show(1));
        await h.chunk(1, 1, -0.1);
        await h.page.evaluate(() => window.__turn.show(2));
        await h.at(h.tl.lines[1].end - 0.6);
        await h.page.evaluate(() => window.__turn.show(4));
      },
    },
    // ============================================================================================ 3. key features
    {
      id: "features",
      kind: "replay",
      screen: "Five feature cards with line icons, appearing one by one.",
      tag: "Key features",
      replay: {
        mode: "features",
        kicker: "Key features",
        items: [
          {
            icon: "coin",
            big: "Weekly premium",
            small: "Covered calls and cash-secured puts, premium paid in USDG",
          },
          {
            icon: "shield",
            big: "On-chain mandate",
            small: "The agent proposes; the contract checks every limit",
          },
          {
            icon: "cut",
            big: "Bond and slashing",
            small: `${f.slash} USDG of the agent's bond to depositors per rejection`,
          },
          { icon: "chip", big: "Rust on Stylus", small: "Pricer, strike solver and risk engine on-chain" },
          {
            icon: "chains",
            big: "Two chains",
            small: "Live on Robinhood Chain testnet and Arbitrum Sepolia",
          },
        ],
      },
      lines: [
        L("Weekly premium in USDG.", `Weekly premium in ${U}.`),
        L("An AI agent picks the strike, inside a mandate."),
        L("Break it, and its bond goes to depositors."),
        L("Rust on Stylus does the math."),
        L("Live on Robinhood Chain and Arbitrum Sepolia.", "Live on Robinhood Chain and Arbitrum Sepolia.", {
          seeds: [11, 23, 37, 51, 64, 77],
        }),
      ],
      async run(h) {
        for (let i = 0; i < 5; i++) {
          await h.cue(i, -0.15);
          await h.page.evaluate((i) => window.__feat.show(i), i);
        }
      },
    },
    // ============================================================================================ 4. architecture
    {
      id: "flow3d",
      chapter: "Architecture",
      kind: "three",
      screen:
        "A three.js scene on two platforms (Robinhood Chain testnet, Arbitrum Sepolia), with a spotlight that dims everything but the part being named: depositors and the vault, the agent and its MCP tools, the proposal, the EpochManager's mandate check with the StockOracle (SafeStockFeed), the Stylus pricer and risk engine, options to buyers and USDG to the vault, a rejection and the bond slashed, the DecisionLog and the ERC-8004 identity, settlement to depositors, and the second chain.",
      tag: "Architecture",
      three: { mode: "flow", delta: a.delta, size: a.bought, premiumPct: a.premiumPct },
      lines: [
        L("Inside one week:"),
        L("Depositors fill a vault with a fixed mandate."),
        L("An agent reads it via MCP and dry-runs.", "An agent reads it via M C P and dry-runs."),
        L("It proposes delta, expiry, size and price."),
        L(
          "The Epoch Manager checks it at guarded oracle prices.",
          `The ${EM} checks it at guarded oracle prices.`,
        ),
        L("Rust on Stylus solves and stress-tests the strike."),
        L("If it passes, buyers pay premium in USDG.", `If it passes, buyers pay premium in ${U}.`),
        L("If not, the bond is slashed to depositors."),
        L(
          "Decisions are hashed on-chain; | the agent has an ERC-8004 identity.",
          "Decisions are hashed on-chain; | the agent has an E R C eighty oh four identity.",
        ),
        L("Friday's close settles; | depositors get the premium, less a fee."),
        L(
          "Same contracts on Robinhood Chain and Arbitrum Sepolia.",
          "Same contracts on Robinhood Chain and Arbitrum Sepolia.",
          { seeds: [11, 23, 37, 51, 64, 77] },
        ),
      ],
      async run(h) {
        await play3d(
          h,
          h.tl.lines.map((l) => l.start),
        );
      },
    },
    // ============================================================================================ 5. walkthrough
    {
      id: "vault",
      chapter: "Walkthrough: one depositor's week",
      screen: `The TSLA covered-call vault page (its first week, expired and waiting for settlement): zoom on the $${f.strike} strike and the ${f.premium} USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven.`,
      tag: "Vault",
      lines: [
        L("Say Maya opens the Tesla vault."),
        L(
          `Its first week sold the $${f.strike} call: | four options, ${f.premium} USDG.`,
          `Its first week sold the ${sayUsd(f.strike)} call: | four options, ${sayDec(f.premium)} ${U}.`,
        ),
        L(
          "At or below the strike, Maya keeps it; | the buyer profits above $372.36.",
          `At or below the strike, Maya keeps it; | the buyer profits above ${sayUsd("372.36")}.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${CC_VAULT}`, () =>
          page.getByText("Breakeven $372.36").first().waitFor({ timeout: 60_000 }),
        );
        for (const t of [`$${f.strike}`, "Breakeven $372.36", "4 of 4 sold", `${f.premium} USDG`])
          await page.getByText(t, { exact: false }).first().waitFor({ timeout: 30_000 });
        const y = await page
          .getByRole("heading", { name: /This week's option/ })
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 120, 0), y);
      },
      async run(h) {
        await h.cue(1, 0.2);
        await h.zoom(h.page.locator('[class*="seriesStrike"]').first(), { scale: 1.5 });
        await h.chunk(1, 1, -0.5);
        await h.box(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { pad: 10, dim: 0.15 });
        await h.zoom(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { scale: 1.8 });
        await h.cue(2, -0.1);
        await h.unbox();
        await h.unzoom(300);
        await h.scrollTo(/^Result at expiry/, { offset: 110, ms: 800 });
        await h.chunk(2, 1, -0.2);
        await h.box(/^Breakeven \$372\.36$/, { pad: 8, dim: 0.12 });
        await h.zoom(/^Breakeven \$372\.36$/, { scale: 1.6 });
      },
    },
    {
      id: "mandate",
      screen: `The same vault page, Mandate section: each limit boxed as it is said (delta ${m.deltaLo} to ${m.deltaHi}, at least ${m.minPremiumPct}% of fair value, at least ${m.minYieldPct}% yield, at most ${m.maxSoldPct}% sold, ${m.tenorMin} to ${m.tenorMax} days).`,
      tag: "Mandate",
      lines: [
        L("The limits are in the contract:"),
        L(
          `Delta ${m.deltaLo} to ${m.deltaHi}, | at least ${m.minPremiumPct}% of fair value, | at least ${m.minYieldPct}% yield,`,
          `Delta ${sayDelta(m.deltaLo)} to ${sayDelta(m.deltaHi)}, | at least ${sayInt(m.minPremiumPct)} percent of fair value, | at least ${sayDelta(m.minYieldPct)} percent yield,`,
        ),
        L(
          `at most ${m.maxSoldPct}% sold, | ${m.tenorMin} to ${m.tenorMax} days, | fixed for good.`,
          `at most ${sayInt(m.maxSoldPct)} percent sold, | ${sayInt(m.tenorMin)} to ${sayInt(m.tenorMax)} days, | fixed for good.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${CC_VAULT}`, () =>
          page.getByText("Max share sold", { exact: false }).first().waitFor({ timeout: 60_000 }),
        );
        await scrollToText(page, /^Delta band$/i, 330);
      },
      async run(h) {
        await h.cue(1, -0.2);
        await focusCard(h, /^Delta band$/i, { scale: 1.35 });
        await h.chunk(1, 1, -0.2);
        await focusCard(h, /^Minimum price$/i, { scale: 1.35 });
        await h.chunk(1, 2, -0.2);
        await focusCard(h, /^Minimum yield$/i, { scale: 1.35 });
        await h.cue(2, -0.2);
        await focusCard(h, /^Max share sold$/i, { scale: 1.35 });
        await h.chunk(2, 1, -0.2);
        await focusCard(h, /^Tenor$/i, { scale: 1.35 });
        await h.chunk(2, 2, -0.2);
        await h.unbox();
        await h.unzoom(450);
      },
    },
    {
      id: "playground",
      screen: `\`/app/playground\`, no wallet. Zoom on the honest 0.20-delta call preset, click it, zoom on **Accepted**; click the reckless at-the-money preset, zoom on **Rejected: DeltaOutOfBand**, then on the ${f.slash} USDG slash panel.`,
      tag: "Playground",
      lines: [
        L("The playground tests proposals live, | no wallet."),
        L("An honest 0.20-delta call: accepted.", "An honest zero point two oh delta call: accepted."),
        L("A reckless at-the-money strike: | rejected, delta out of band."),
        L(
          `A real one costs the agent ${f.slash} USDG, paid to depositors.`,
          `A real one costs the agent ${sayInt(f.slash)} ${U}, paid to depositors.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/playground", () =>
          page.locator('[data-testid="verdict"][data-kind="accepted"]').waitFor({ timeout: 60_000 }),
        );
        const presets = page.getByRole("group", { name: "Preset proposals" });
        const y = await presets.evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 175, 0), y);
      },
      async run(h) {
        const page = h.page;
        const presets = page.getByRole("group", { name: "Preset proposals" });
        const honest = presets.getByRole("button", { name: /0\.20-delta call/ });
        const verdict = page.getByTestId("verdict");
        await h.chunk(0, 1, 0.2);
        await h.zoom(honest, { scale: 1.5 });
        await h.cue(1, -1.0);
        await honest.click();
        await h.cue(1, -0.3);
        await h.zoom(verdict.getByText(/^Accepted/).first(), { scale: 1.6 });
        await h.cue(2, -0.5);
        await h.zoom(presets.getByRole("button", { name: /At-the-money/ }), { scale: 1.5 });
        await presets.getByRole("button", { name: /At-the-money/ }).click();
        await page.locator('[data-testid="verdict"][data-kind="rejected"]').waitFor({ timeout: 30_000 });
        await verdict.getByText("DeltaOutOfBand").first().waitFor({ timeout: 15_000 });
        await h.chunk(2, 1, -0.3);
        await h.zoom(verdict.getByText(/^Rejected/).first(), { scale: 1.6 });
        await h.cue(3, -0.2);
        await h.expectText(`slashed by ${f.slash} USDG`);
        await h.zoom(verdict.getByText(/slashed by/).first(), { scale: 1.5 });
      },
    },
    {
      id: "runagent",
      screen:
        "The playground's \"Run the agent\" on the TSLA cash-secured put: the example agent's rule stages run in the browser against the live vault (market checks, the strike ladder judged by the contract's previewProposal, the profile's pick and the critic), the stage strip and the run line; nothing is sent. Started before the clock, so the scene shows its finished result.",
      tag: "Playground",
      minDur: 5.6,
      lines: [
        L(
          "Run the agent does the rule stages live, in your browser, | against the real vault, sending nothing.",
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/playground", () =>
          page
            .getByRole("button", { name: /^Run the agent$/i })
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        const run = page.getByRole("button", { name: /^Run the agent$/i }).first();
        await run.scrollIntoViewIfNeeded();
        await run.click();
        await page
          .getByText(/\d of 5 stages ran/)
          .first()
          .waitFor({ timeout: 90_000 });
        const y = await page
          .locator('ol[class*="decision_strip"]')
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y, 0), y - 330);
      },
      async run(h) {
        await h.at(0.3);
        await h.page.evaluate(() => {
          const v = window.__v;
          const strip = document.querySelector('ol[class*="decision_strip"]');
          const line = v.leaf("^\\d of 5 stages ran", "");
          const r = v.union([v.rect(strip), v.rect(line)]);
          v.box(r, { pad: 10, dim: 0.22 });
          v.zoomRect(r, 1.3);
        });
      },
    },
    {
      id: "pricing",
      screen: `Agent #2's put vault (sTSLA-CSP-A2, selling its first week), seen from Singapore: "How the buy price is set" with the priced spot (oracle − ${a.spotBufferPct}%, against the buyer), the Black-Scholes fair value, the premium factor and the intrinsic-value floor, each zoomed as it is said; then the market-hours notice in the buy panel, with the next NYSE open in UTC and in the viewer's time zone.`,
      tag: "Pricing",
      timezoneId: VIEWER_TZ,
      lines: [
        L(
          `Buyers pay at the moment they buy: | oracle spot moved ${a.spotBufferPct}% against them, | Black-Scholes, times the agent's factor.`,
          `Buyers pay at the moment they buy: | oracle spot moved ${sayDec(a.spotBufferPct)} percent against them, | Black Scholes, times the agent's factor.`,
        ),
        L("Never below intrinsic value, | so stale prices can't be picked off."),
        live.marketOpen
          ? L("Sales stop before the NYSE close, | shown in the viewer's own time zone.")
          : L("Buying waits for the NYSE open, | shown in your own time zone."),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${A2_VAULT}`, () =>
          page.getByText("How the buy price is set", { exact: false }).first().waitFor({ timeout: 60_000 }),
        );
        await page
          .getByText(`${a.spotBufferPct}%, against the buyer`, { exact: false })
          .first()
          .waitFor({ timeout: 30_000 });
        // the notice must show the viewer's own time (it is left out when the viewer is on UTC)
        await page.getByTestId("market-hours-local").first().waitFor({ timeout: 30_000 });
        const open = (await page.getByTestId("market-hours").first().getAttribute("data-open")) === "true";
        if (open !== live.marketOpen)
          throw new Error(`market open on the page: ${open}, at probe: ${live.marketOpen}`);
        await scrollToText(page, /^How the buy price is set$/i, 300);
      },
      async run(h) {
        await h.at(0.3);
        await focusCard(h, /^How the buy price is set$/i, { scale: 1.15, dim: 0.12 });
        await h.chunk(0, 1, -0.2);
        await focusCard(h, /^Priced spot$/i, { scale: 1.6, closest: "li" });
        await h.chunk(0, 2, -0.2);
        await focusCard(h, /^Fair value$/i, { scale: 1.6, closest: "li" });
        await h.cue(1, -0.2);
        await h.page.evaluate(() => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          const el = v.leaf("^never below intrinsic value \\(", "i").closest("li");
          v.box(el, { pad: 10, dim: 0.22 });
          v.zoom(el, 1.7);
        });
        await h.cue(2, -0.5);
        await h.unbox();
        await h.unzoom(300);
        await h.scrollTo(h.page.getByTestId("market-hours").first(), { offset: 380, ms: 700 });
        await h.chunk(2, 1, -0.3);
        await h.box(h.page.getByTestId("market-hours").first(), { pad: 12, dim: 0.25 });
        await h.zoom(h.page.getByTestId("market-hours").first(), { scale: 1.45 });
      },
    },
    {
      id: "epoch",
      chapter: "Live on Robinhood Chain testnet",
      screen: `A terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)), opening half-printed: the seller agent's \`proposeByDelta\` accepted at $${f.strike}, then the reckless agent's forced put rejected and its bond going from ${f.bondBefore} to ${f.bondAfter} USDG.`,
      tag: "Live epoch",
      kind: "replay",
      replay: {
        mode: "terminal",
        wintitle: "~/strike · Robinhood Chain testnet (46630) · live run, 2026-09-29 17:08 UTC",
        sublabel: "docs/testnet-epochs/2026-09-29.md",
      },
      lines: [
        L(
          `Live on September 29, the seller agent asked for 0.20 delta; | the contract solved $${f.strike}, accepted.`,
          `Live on September twenty-ninth, the seller agent asked for zero point two oh delta; | the contract solved ${sayUsd(f.strike)}. Accepted.`,
        ),
        L("A reckless agent forced an at-the-money put:"),
        L(
          `rejected, ${f.slash} USDG slashed, | bond ${f.bondBefore} to ${f.bondAfter}.`,
          `rejected, ${sayInt(f.slash)} ${U} slashed, | bond ${sayInt(f.bondBefore)} to ${sayInt(f.bondAfter)}.`,
        ),
      ],
      async prepare(page, env) {
        await page.evaluate(
          (seg) => {
            window.__term.load(seg);
            window.__term.prefill("^\\[3\\]");
          },
          {
            ...env.epoch.seller,
            label: "Seller agent · 0.20-delta covered call",
            command: "pnpm --filter @strike/agent-example start -- --vault sTSLA-CC",
          },
        );
      },
      async run(h, env) {
        const t = (until, pause) => h.page.evaluate(([u, p]) => window.__term.type(u, p), [until, pause]);
        await h.at(0.6);
        await t("^\\s*Verdict: None", 70);
        await h.chunk(0, 1, -0.6);
        await t("^\\s*Accepted", 70);
        await h.page.evaluate(() => window.__term.mark("^\\s*Accepted", "hl"));
        await h.cue(1, -0.5);
        await h.page.evaluate(
          (seg) => {
            window.__term.load(seg);
            window.__term.prefill("^\\[2\\]");
          },
          {
            ...env.epoch.reckless,
            label: "Reckless agent · at-the-money put, forced",
            command: "pnpm --filter @strike/agent-example start -- --reckless --vault sTSLA-CSP",
          },
        );
        await t("^\\s*A careful agent", 70);
        await h.cue(2, -0.8);
        await t("REJECTED", 70);
        await h.page.evaluate(() => window.__term.mark("REJECTED", "hlbad"));
        await h.chunk(2, 1, -0.4);
        await t("^\\s*Agent now", 60);
        await h.page.evaluate(() => window.__term.mark("^\\s*Agent now", "hlbad"));
      },
    },
    {
      id: "explorer",
      screen: `The rejected \`proposeSeries\` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](${EXPLORER}/tx/${REJECT_TX})): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for ${f.slash} USDG".`,
      tag: "Explorer",
      lines: [
        L(
          `The explorer says Success: a rejection isn't a revert, | and ${f.slash} USDG left the bond.`,
          `The explorer says Success: a rejection isn't a revert, | and ${sayInt(f.slash)} ${U} left the bond.`,
        ),
      ],
      async prepare(page) {
        await page.goto(`${EXPLORER}/tx/${REJECT_TX}`, { waitUntil: "domcontentloaded" });
        await page.getByText("proposeSeries").first().waitFor({ timeout: 60_000 });
        await page.getByText("Tokens transferred").first().waitFor({ timeout: 60_000 });
        await page.mouse.move(1900, 700); // off the explorer's hover menus
        await page.waitForTimeout(2500);
      },
      async run(h) {
        await h.at(0.6);
        await h.zoom(/^Success$/, { scale: 1.8 });
        await h.chunk(0, 1, -0.6);
        await h.unzoom(350);
        await h.chunk(0, 1, -0.1);
        await h.page.evaluate(() => {
          const v = window.__v;
          const label = v.leaf("^Tokens transferred$", "i");
          const from = v.leaf("^AgentRegistry$", "");
          const usdg = [...document.querySelectorAll("*")].filter(
            (e) =>
              e.children.length === 0 &&
              e.textContent.trim() === "USDG" &&
              Math.abs(v.rect(e).y - v.rect(from).y) < 30,
          )[0];
          const r = v.union([v.rect(label), v.rect(from), v.rect(usdg ?? from)]);
          v.box(r, { pad: 14, dim: 0.35 });
          v.zoomRect(r, 1.5);
        });
      },
    },
    settleScene(f, live),
    signingScene(f),
    {
      id: "claude",
      chapter: "Planned by Claude, on Arbitrum Sepolia",
      screen: `A terminal replay of the Claude-planned run on Arbitrum Sepolia, 30 September ([log](../testnet-epochs/2026-09-30-arbitrum-sepolia.md), [record](../agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json)): Claude (${a.model}, through the Claude Code CLI) calls vault_state, risk_check on ${a.candidates.length} candidates and agent_stats, writes its plan (${a.delta} delta at ${a.premiumPct}% of fair value) and why, and the contract accepts the call at $${a.strike}.`,
      tag: "Claude",
      kind: "replay",
      replay: {
        mode: "terminal",
        wintitle: "~/strike · Arbitrum Sepolia (421614) · live run, 2026-09-30 17:30 UTC",
        sublabel: "docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md",
      },
      lines: [
        L(
          `On Arbitrum Sepolia, Claude planned it: | via Strike's MCP server, it read the vault | and dry-ran ${f.arbCandidatesWord} candidates.`,
          `On Arbitrum Sepolia, Claude planned it: | via Strike's M C P server, it read the vault | and dry-ran ${sayInt(a.candidates.length)} candidates.`,
        ),
        L(
          `It chose ${a.delta} delta at ${a.premiumPct}% of fair value, | and wrote why: | mid-band, safe from small moves.`,
          `It chose ${sayDelta(a.delta)} delta at ${sayInt(a.premiumPct)} percent of fair value, | and wrote why: | mid-band, safe from small moves.`,
        ),
        L(
          `The contract solved $${a.strike}: accepted.`,
          `The contract solved ${sayUsd(a.strike)}: accepted.`,
        ),
      ],
      async prepare(page) {
        await page.evaluate(
          (seg) => {
            window.__term.load(seg);
            window.__term.prefill("^\\[2\\]");
          },
          {
            lines: claudeRun(a),
            label: `Seller agent · planned by Claude (${a.model})`,
            command:
              "pnpm --filter @strike/agent-example start -- --vault sTSLA-CC --llm --planner claude-code --anchor",
          },
        );
      },
      async run(h) {
        const t = (until, pause) => h.page.evaluate(([u, p]) => window.__term.type(u, p), [until, pause]);
        const mark = (re, cls = "hl") => h.page.evaluate(([r, c]) => window.__term.mark(r, c), [re, cls]);
        await h.at(0.3);
        await t("^\\s*Claude Code \\d", 120);
        await h.chunk(0, 1, -0.2);
        await t("Claude calls vault_state", 100);
        await h.chunk(0, 2, -0.3);
        await t("Claude calls agent_stats", 160);
        await h.cue(1, -0.3);
        await t("^\\s*Claude's plan", 100);
        await mark("^\\s*Claude's plan");
        await h.chunk(1, 1, -0.2);
        await t("^\\s*Why:", 100);
        await h.cue(2, -0.6);
        await t("^\\s*Accepted", 70);
        await mark("^\\s*Accepted");
      },
    },
    {
      id: "arbiscan",
      screen: `The accepted \`proposeByDelta\` transaction on Arbiscan ([0xf26315b3…b5f4](${ARBISCAN}/tx/${a.tx})): zoom on the **Success** status, then on the transaction action (a call from the agent's signer to the EpochManager).`,
      tag: "Arbiscan",
      userAgent: DESKTOP_UA,
      lines: [
        L("On Arbiscan: | a successful call from the agent's signer."),
        L(
          `The same run slashed a reckless put ${f.arbSlash} USDG, | and a buyer took all ${f.arbBought} calls.`,
          `The same run slashed a reckless put ${sayInt(f.arbSlash)} ${U}, | and a buyer took all ${sayInt(f.arbBought)} calls.`,
        ),
      ],
      async prepare(page) {
        await page.goto(`${ARBISCAN}/tx/${a.tx}`, { waitUntil: "domcontentloaded" });
        await page.getByText("Transaction Action", { exact: false }).first().waitFor({ timeout: 90_000 });
        await page
          .getByText(/^Success$/)
          .first()
          .waitFor({ timeout: 30_000 });
        await page
          .getByRole("button", { name: /Got it/ })
          .click({ timeout: 5_000 })
          .catch(() => {});
        await page.mouse.move(1900, 700);
        await page.waitForTimeout(2000);
      },
      async run(h) {
        await h.at(0.4);
        await h.box(/^Success$/, { pad: 10, dim: 0.25 });
        await h.zoom(/^Success$/, { scale: 1.9 });
        await h.chunk(0, 1, -0.2);
        await h.unbox();
        await h.unzoom(300);
        await h.page.evaluate(() => {
          const v = window.__v;
          // the label reads "Arbitrum Sepolia Transaction Action" in the DOM; its card is the first ancestor wider than 1300 px
          let el = v.leaf("Transaction Action:?$", "i");
          while (el && el.getBoundingClientRect().width < 1300) el = el.parentElement;
          if (!el) return;
          const r = v.rect(el);
          v.box(r, { pad: 6, dim: 0.25 });
          v.zoomRect(r, 1.35);
        });
        await h.cue(1, 0.2);
        await h.unbox();
        await h.unzoom(500);
      },
    },
    {
      id: "surface3d",
      kind: "three",
      screen: `A three.js surface of the Claude-planned series (strike $${a.strike}, spot $${a.spot}, σ ${a.sigmaPct}%, ${a.tenorDays} days, $${a.buyPerOption} paid per option): the value of one covered share against TSLA's price and the days left to expiry, with the expiry edge, the strike plane and the stock alone for comparison; the camera orbits slowly.`,
      tag: "Payoff in 3D",
      three: {
        mode: "surface",
        strike: a.strike,
        spot: a.spot,
        sigmaPct: a.sigmaPct,
        tenorDays: a.tenorDays,
        premium: a.buyPerOption,
      },
      lines: [
        L("In 3D:", "In three D:"),
        L("Across, Tesla's price. Back, days left. | Up, a share's value."),
        L(
          `At expiry it bends flat at the $${a.strike} strike: | upside goes to the buyer.`,
          `At expiry it bends flat at the ${sayUsd(a.strike)} strike: | upside goes to the buyer.`,
        ),
        L(
          `Below, the depositor keeps stock plus $${prem} per option.`,
          `Below, the depositor keeps stock plus ${sayUsd(prem)} per option.`,
        ),
      ],
      async run(h) {
        const l = h.tl.lines;
        const c2 = l[2].chunks;
        const c1 = l[1].chunks;
        await play3d(h, [
          l[0].start,
          c1[0].start,
          c1[0].start + 1.1,
          c1[1].start,
          c2[0].start,
          c2[0].start + 1.2,
          c2[1].start,
          l[3].start,
        ]);
      },
    },
    {
      id: "gas3d",
      chapter: "Rust on Stylus: pricer and risk engine",
      kind: "three",
      screen: `Three.js bars of L2 gas from the README's gas table: \`strikeForDelta\` (${f.gasSolverSol} in Solidity, ${f.gasSolverStylus} in Stylus) and the whole \`proposeByDelta\` (${f.gasProposeSol} and ${f.gasProposeStylus}).`,
      tag: "Stylus",
      three: {
        mode: "gas",
        pairs: [
          { name: "strikeForDelta", sol: Number(f.gasSolverSol), sty: Number(f.gasSolverStylus) },
          { name: "proposeByDelta", sol: Number(f.gasProposeSol), sty: Number(f.gasProposeStylus) },
        ],
      },
      lines: [
        L("The math is Rust, on Arbitrum Stylus."),
        L(
          `Solving a strike takes ${f.solverSteps} Black-Scholes runs: | ${f.stylusSolverX} times less gas than Solidity, | ${f.stylusTxX} times less per proposal.`,
          `Solving a strike takes ${sayInt(f.solverSteps)} Black Scholes runs: | ${sayDec(f.stylusSolverX)} times less gas than Solidity, | ${sayDec(f.stylusTxX)} times less per proposal.`,
        ),
      ],
      async run(h) {
        const l = h.tl.lines;
        await play3d(h, [l[0].start, l[1].start, l[1].chunks[1].start, l[1].chunks[2].start]);
      },
    },
    {
      id: "decisionlog",
      chapter: "Decision records, identity and the multiplier trap",
      screen: `A terminal: the Claude-planned decision record (planner, target, the start of the reasoning), then its keccak256 recomputed from the published file and the DecisionRecorded event of its anchoring transaction, read from Arbitrum Sepolia at render time; both are ${live.anchorHash.slice(0, 10)}…`,
      tag: "DecisionLog",
      kind: "replay",
      replay: {
        mode: "terminal",
        wintitle: "~/strike · Arbitrum Sepolia (421614) · computed and read at render time",
        sublabel: "docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json",
      },
      lines: [
        L("Every run leaves a decision record."),
        L(
          "Its hash is anchored in the DecisionLog; | rehash the file, and it matches the chain.",
          "Its hash is anchored in the Decision Log; | rehash the file, and it matches the chain.",
        ),
        L(
          `CI re-checks every cited transaction: | ${live.claims.verified} of ${live.claims.cited} verified.`,
          `C I re-checks every cited transaction: | ${sayInt(live.claims.verified)} of ${sayInt(live.claims.cited)} verified.`,
        ),
      ],
      async prepare(page) {
        const r = a.record;
        await page.evaluate((seg) => window.__term.load(seg), {
          label: "Decision record · Claude-planned call",
          command: "jq '.decision, .dryRun, .result' 2026-09-30-sTSLA-CC.json",
          lines: [
            `planner   ${r.decision.planner.label}`,
            `target    Δ ${a.delta} at ${a.premiumPct}% of fair value · strike $${r.dryRun.strike}, ${r.dryRun.size} of ${r.dryRun.capacity} options`,
            `why       ${r.decision.reasoning.slice(0, 150).replace(/\s+\S*$/, "")} [...]`,
            `result    ${r.result.status}`,
          ],
        });
        await page.evaluate(() => window.__term.prefill("^zzz"));
      },
      async run(h) {
        const t = (until, pause) => h.page.evaluate(([u, p]) => window.__term.type(u, p), [until, pause]);
        await h.cue(1, -0.1);
        await h.page.evaluate((seg) => window.__term.more(seg), {
          command: "keccak256 of the record without its anchor",
          lines: [`Recomputed          ${live.anchorHash}`],
        });
        await t("Recomputed", 80);
        await h.chunk(1, 1, -0.3);
        await h.page.evaluate((seg) => window.__term.more(seg), {
          command: `cast receipt ${a.anchor.txHash.slice(0, 10)}… (DecisionLog ${a.anchor.contract.slice(0, 8)}…, DecisionRecorded)`,
          lines: [
            `On-chain recordHash ${live.anchorHash}`,
            "Match: the published record is the one the agent anchored.",
          ],
        });
        await t("Match", 140);
        await h.page.evaluate(() => window.__term.mark("^Match", "hl"));
        await h.cue(2, -0.3);
        // scripts/check-claims.mjs, run at render time: its own summary line
        await h.page.evaluate((seg) => window.__term.more(seg), {
          command: "node scripts/check-claims.mjs",
          lines: [live.claims.line],
        });
        await h.chunk(2, 1, -0.4);
        await t("verified", 60);
        await h.page.evaluate(() => window.__term.mark("verified", "hl"));
      },
    },
    {
      id: "pipeline",
      screen: `A dry run of the agent's specialist pipeline, planned by Claude and evaluated as if the NYSE were open (${DRY_CLAUDE}): the five-stage strip (market analyst, risk analyst, strike planner, critic: PASS; contract: not run) and the run line with the stage times and Claude's recorded usage.`,
      tag: "Pipeline",
      lines: [
        L("The agent now runs five stages: | market, risk, strike planner, critic, then the contract."),
        L("In this Claude-planned dry run, four passed and nothing was sent; | its token use is on record."),
      ],
      async prepare(page) {
        await openApp(page, DRY_CLAUDE, () =>
          page
            .getByText(/stages ran/)
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        const strip = await page.locator('ol[class*="decision_strip"]').first().innerText();
        if ((strip.match(/\bPass\b/gi) ?? []).length !== 4 || !/not run/i.test(strip))
          throw new Error(`stage strip changed: ${strip.replace(/\s+/g, " ")}`);
        await page
          .getByText(/Claude used \d+ calls/)
          .first()
          .waitFor({ timeout: 30_000 });
        await scrollToText(page, /^Specialists$/i, 120);
      },
      async run(h) {
        await h.chunk(0, 1, -0.3);
        await h.page.evaluate(() => {
          const v = window.__v;
          const strip = document.querySelector('ol[class*="decision_strip"]');
          v.box(strip, { pad: 10, dim: 0.22 });
          v.zoom(strip, 1.35);
        });
        await h.chunk(1, 1, -0.4);
        await h.page.evaluate(() => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          const line = v.leaf("^4 of 5 stages ran", "");
          v.box(line, { pad: 10, dim: 0.22 });
          v.zoom(line, 1.6);
        });
      },
    },
    {
      id: "notrade",
      screen: `The weekend dry run of the same pipeline (${DRY_CLOSED}): the market analyst stops it with MARKET_CLOSED, "No trade", and the four later stages read "Not run".`,
      tag: "Pipeline",
      lines: [L("On the weekend, the market analyst said no trade; | the rest never ran.")],
      async prepare(page) {
        await openApp(page, DRY_CLOSED, () =>
          page
            .getByText(/^No trade: stopped by the market analyst/)
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        await scrollToText(page, /^Specialists$/i, 120);
      },
      async run(h) {
        await h.at(0.2);
        await h.page.evaluate(() => {
          const v = window.__v;
          const strip = document.querySelector('ol[class*="decision_strip"]');
          const why = v.leaf("^No trade: stopped by the market analyst", "");
          const r = v.union([v.rect(strip), v.rect(why)]);
          v.box(r, { pad: 10, dim: 0.22 });
          v.zoomRect(r, 1.35);
        });
      },
    },
    {
      id: "decision",
      screen: `Agent #2's decision page for 2 October (${DECISION_OK}): the mandate check rule by rule with the headroom left, the "why not the other strikes" ladder, "what would make this week lose" (below $${live.breakEven}, ${live.odds}% model odds) with its stress rows, and the "what if" alternatives, read from the page at render time.`,
      tag: "Decision page",
      lines: [
        L("Agent two's accepted put: | each mandate rule, with the headroom left."),
        L("Why not the other strikes: | the same proposal at each delta, judged by the rules."),
        L(
          `What would make the week lose: | TSLA below $${live.breakEven}, ${Math.round(Number(live.odds))}% model odds, | then stress rows and what-ifs.`,
          `What would make the week lose: | Tesla below ${sayUsd(live.breakEven)}, ${sayInt(Math.round(Number(live.odds)))} percent model odds, | then stress rows and what-ifs.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, DECISION_OK, () =>
          page.getByText("Model odds of exercise", { exact: false }).first().waitFor({ timeout: 60_000 }),
        );
        for (const t of [`settles below $${live.breakEven}`, "What if it had sold half as many options"])
          await page.getByText(t, { exact: false }).first().waitFor({ timeout: 30_000 });
        await scrollToText(page, /^Mandate check$/i, 70);
      },
      async run(h) {
        const focus = (src, scale = 1.45) =>
          h.page.evaluate(
            ([src, scale]) => {
              const v = window.__v;
              document.querySelectorAll(".__vbox").forEach((d) => d.remove());
              const el = v.leaf(src, "i");
              if (!el) throw new Error(`no element matches /${src}/`);
              v.box(el, { pad: 10, dim: 0.22 });
              v.zoom(el, scale);
            },
            [src, scale],
          );
        /** The first table below a section heading, boxed, zoomed on its left part. */
        const table = (heading, frac, scale) =>
          h.page.evaluate(
            ([heading, frac, scale]) => {
              const v = window.__v;
              document.querySelectorAll(".__vbox").forEach((d) => d.remove());
              const top = v.rect(v.leaf(heading, "i")).y;
              const t = [...document.querySelectorAll("table")].find((x) => v.rect(x).y > top);
              const r = v.rect(t);
              v.box(r, { pad: 10, dim: 0.22 });
              v.zoomRect({ x: r.x, y: r.y, w: r.w * frac, h: r.h }, scale);
            },
            [heading, frac, scale],
          );
        await h.chunk(0, 1, -0.3);
        await focus("^Headroom: \\$[\\d.]+ \\(", 1.5);
        await h.cue(1, -0.4);
        await h.unbox();
        await h.unzoom(250);
        await h.scrollTo(/^Why not the other strikes$/i, { offset: 70, ms: 600 });
        await h.chunk(1, 1, -0.3);
        await table("^Why not the other strikes$", 0.66, 1.45);
        await h.cue(2, -0.4);
        await h.unbox();
        await h.unzoom(250);
        await h.scrollTo(/^What would make this week lose$/i, { offset: 70, ms: 600 });
        await h.chunk(2, 1, -0.3);
        await focus("lose money on this series if TSLA settles below", 1.4);
        await h.chunk(2, 2, -0.3);
        await h.unbox();
        await h.unzoom(200);
        await h.scrollTo(/^What if$/i, { offset: 70, ms: 600 });
        await table("^What if$", 0.72, 1.4);
      },
    },
    {
      id: "rejected",
      screen: `Agent #1's rejected put of 1 October (${DECISION_REJECTED}): the verdict, then the mandate check with the delta band rule marked FAILS and the rule after it NOT REACHED.`,
      tag: "Decision page",
      lines: [
        L("Agent one's forced put was rejected: | the check stops at the delta band; later rules never run."),
      ],
      async prepare(page) {
        await openApp(page, DECISION_REJECTED, () =>
          page.getByText("NOT REACHED", { exact: false }).first().waitFor({ timeout: 60_000 }),
        );
      },
      async run(h) {
        await h.at(0.3);
        await h.box(/^Rejected$/, { pad: 12, dim: 0.22 });
        await h.zoom(/^Rejected$/, { scale: 1.5 });
        await h.chunk(0, 1, -0.7);
        await h.unbox();
        await h.unzoom(250);
        await h.scrollTo(/^Delta band/, { offset: 380, ms: 500 });
        await h.chunk(0, 1, 0.1);
        await h.page.evaluate(() => {
          const v = window.__v;
          const fail = v.leaf("^Delta band", "").closest("li");
          const r = v.union([v.rect(fail), v.rect(fail.nextElementSibling ?? fail)]);
          v.box(r, { pad: 12, dim: 0.25 });
          v.zoomRect(r, 1.3);
        });
      },
    },
    {
      id: "agents",
      screen: `\`/app/agents\` leaderboard: agent #1's row opened, a zoom on its ERC-8004 identity (#${f.identity} on Robinhood Chain testnet).`,
      tag: "ERC-8004",
      lines: [
        L(
          `Its ERC-8004 identity: | ${f.identity} on Robinhood Chain testnet, ${f.arbIdentity} on Arbitrum Sepolia.`,
          `Its E R C eighty oh four identity: | ${f.identity === "114" ? "one-fourteen" : sayInt(f.identity)} on Robinhood Chain testnet, ${f.arbIdentity === "253" ? "two-fifty-three" : sayInt(f.arbIdentity)} on Arbitrum Sepolia.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/agents", () =>
          page
            .getByText(new RegExp(`ERC-8004 #${f.identity}`))
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        await scrollToText(page, "Leaderboard", 140);
      },
      async run(h) {
        await h.at(0.5);
        // agent #1's row on the v2 registry (agent #2's row above it opens by default)
        const row = h.page.getByRole("button", { name: /about agent 1\b/i }).first();
        if ((await row.getAttribute("aria-expanded").catch(() => null)) === "false") await row.click();
        await h.at(0.9);
        await h.page.evaluate((id) => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          // the open panel whose identity is agent #1's
          // the label is a <dt> ("ERC-8004", its glossary note, "identity"); its cell holds the id
          const el = [...document.querySelectorAll("dt")]
            .filter(
              (dt) => /^ERC-8004/.test(dt.textContent.trim()) && /identity$/i.test(dt.textContent.trim()),
            )
            .map((dt) => dt.parentElement)
            .find((cell) => cell.textContent.includes(`#${id}`) && cell.getClientRects().length);
          if (!el) throw new Error(`no open panel with ERC-8004 #${id}`);
          const r = v.rect(el);
          v.box(r, { pad: 10, dim: 0.22 });
          v.zoomRect(r, 1.7);
        }, f.identity);
        await h.chunk(0, 1, 0.6);
        await h.unbox();
        await h.unzoom(400);
      },
    },
    {
      id: "monitor",
      screen: `\`/app/monitor\`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (${live.nvdaMultiplier}, read from the page at render time).`,
      tag: "Monitor",
      lines: [
        L("The monitor, | live on mainnet:"),
        L(
          `Nvidia's multiplier, ${mult}, is already in the price, | so Strike never applies it twice.`,
          `Nvidia's multiplier, ${sayDec(mult).replace(/^one point zero zero zero /, "one point zero zero zero, ")}, is already in the price, | so Strike never applies it twice.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/monitor", () =>
          page.getByText("NVIDIA").first().waitFor({ timeout: 60_000 }),
        );
        const now = await nvdaMultiplier(page);
        if (Number(now).toFixed(6) !== mult)
          throw new Error(`NVDA multiplier changed: ${now} (narration says ${mult})`);
        await scrollToText(page, /^TSLA$/, 300);
      },
      async run(h) {
        await h.chunk(0, 1, 0.3);
        await h.scrollTo("NVIDIA", { offset: 380, ms: 1400 });
        await h.cue(1, -0.2);
        await h.zoom(new RegExp(`^${live.nvdaMultiplier.replace(".", "\\.")}$`), { scale: 1.8 });
      },
    },
    {
      id: "backtest",
      chapter: "Backtest and evidence",
      screen: `\`/app/backtest\` (TSLA): zoom on the volatility figures, then on the annual return (${f.tslaCcCagr}% against ${f.tslaHeldCagr}% held); then the assumption.`,
      tag: "Backtest",
      lines: [
        L(
          `Over ${f.backtestWeeks} weeks since 2019, | covered calls cut volatility ${f.volCut}%,`,
          `Over ${sayInt(f.backtestWeeks)} weeks since twenty nineteen, | covered calls cut volatility ${f.volCut.split(" to ").map(sayInt).join(" to ")} percent,`,
        ),
        L(
          `but lagged holding everywhere: | Tesla ${f.tslaCcCagr}% a year, against ${f.tslaHeldCagr}% held.`,
          `but lagged holding everywhere: | Tesla ${sayDec(f.tslaCcCagr)} percent a year, against ${sayDec(f.tslaHeldCagr)} percent held.`,
        ),
        L("And it assumes full weekly sales."),
      ],
      async prepare(page) {
        await openApp(page, "/app/backtest", () =>
          page.getByText(`${f.backtestWeeks} weeks`).first().waitFor({ timeout: 60_000 }),
        );
        await page.locator("#bt-equity-body svg").waitFor();
        const stock = page.getByRole("group", { name: "Stock", exact: true }).first();
        const y = await stock.evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 110, 0), y);
      },
      async run(h) {
        await h.chunk(0, 1, -0.2);
        await h.zoom(h.page.locator('[data-metric="vol"]'), { scale: 1.5 });
        await h.chunk(1, 1, -0.4);
        const cagr = await h.page.locator('[data-metric="cagr"]').innerText();
        if (!cagr.includes(`${f.tslaCcCagr}%`) || !cagr.includes(`${f.tslaHeldCagr}%`))
          throw new Error(`TSLA CAGR on /app/backtest: ${cagr}`);
        await h.zoom(h.page.locator('[data-metric="cagr"]'), { scale: 1.5 });
        await h.cue(2, -0.2);
        await h.unzoom(400);
      },
    },
    {
      id: "proof",
      screen: `\`/app/proof\`: the headline tiles (deployment, Foundry tests, coverage, internal review), then "Running by itself" (read from both testnets, mainnet and GitHub by /api/status: price age, each vault's epoch and last settlement, the scheduled keeper and weekly agent) and its price mirror audit: ${live.mirrorRounds} of ${live.mirrorRounds} mirrored rounds match Robinhood Chain mainnet Chainlink, read at render time.`,
      tag: "Proof",
      lines: [
        L("The proof page:"),
        L(
          `${Number(f.testsTotal).toLocaleString("en-US")} tests and proofs, | ${f.coverage}% line coverage, | ${sayInt(f.halmos)} Halmos proofs, | all ${f.reviewFindings} review findings fixed.`,
          `${sayInt(f.testsTotal)} tests and proofs, | ${sayDec(f.coverage)} percent line coverage, | ${sayInt(f.halmos)} Halmos proofs, | all ${sayInt(f.reviewFindings)} review findings fixed.`,
        ),
        L("Running by itself reads both testnets: | prices, each vault's week, | the scheduled jobs."),
        L(
          `The mirror audit checks every copied price: | ${live.mirrorRounds} of ${live.mirrorRounds} rounds match mainnet Chainlink.`,
          `The mirror audit checks every copied price: | ${sayInt(live.mirrorRounds)} of ${sayInt(live.mirrorRounds)} rounds match mainnet Chainlink.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/proof", () =>
          page
            .getByText(/^Internal review$/i)
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        await page
          .getByText(`${live.mirrorRounds} of ${live.mirrorRounds} rounds match`, { exact: false })
          .first()
          .waitFor({ timeout: 90_000 })
          .catch(() => {
            throw new Error(`the mirror audit no longer reads ${live.mirrorRounds} of ${live.mirrorRounds}`);
          });
        await scrollToText(page, /^Deployment$/i, 260);
      },
      async run(h) {
        await h.cue(1, -0.2);
        await focusCard(h, /^Foundry tests$/i, { scale: 1.6 });
        await h.chunk(1, 1, -0.2);
        await focusCard(h, /^Coverage$/i, { scale: 1.6 });
        await h.chunk(1, 3, -0.2);
        await focusCard(h, /^Internal review$/i, { scale: 1.6 });
        await h.cue(2, -0.4);
        await h.unbox();
        await h.unzoom(250);
        await h.scrollTo(/^Running by itself$/i, { offset: 60, ms: 700 });
        await h.chunk(2, 1, -0.2);
        // the Robinhood Chain testnet card: prices, the mirror audit and each vault's week
        await focusCard(h, /^Newest mirrored round$/i, { up: 1, scale: 1.6, dim: 0.18 });
        await h.chunk(2, 2, -0.3);
        // the scheduled keeper and weekly agent, as the card reads them now
        await focusCard(h, /^Testnet keeper$/, {
          closest: '[class*="status_schedules"]',
          scale: 1.4,
          dim: 0.18,
        });
        await h.cue(3, -0.2);
        await h.page.evaluate((n) => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          const el = v.leaf(`${n} of ${n} rounds match Robinhood Chain mainnet Chainlink`, "");
          if (!el) throw new Error("no mirror audit line");
          v.box(el, { pad: 10, dim: 0.25 });
          v.zoom(el, 1.8);
        }, live.mirrorRounds);
      },
    },
    {
      id: "lessons",
      screen: `\`/app/lessons\`: ${live.lessons} lessons from the live runs (${live.lessonsFixed} fixed, read at render time), each with what happened, its evidence, what changed and the test that guards it.`,
      tag: "Lessons",
      lines: [
        L(
          `${live.lessons} lessons from the live runs, | each with evidence, the fix and its test.`,
          `${sayInt(live.lessons)} lessons from the live runs, | each with evidence, the fix and its test.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/lessons", () =>
          page
            .getByText(/^Guarded by$/i)
            .first()
            .waitFor({ timeout: 60_000 }),
        );
      },
      async run(h) {
        await h.at(0.2);
        await h.page.evaluate(() => {
          const v = window.__v;
          const meta = document.querySelector('dl[class*="metaGrid"]');
          v.box(meta, { pad: 8, dim: 0.2 });
        });
        await h.chunk(0, 1, -0.4);
        await h.unbox();
        await h.scrollTo(/^A rejected proposal said/, { offset: 130, ms: 700 });
        await h.page.evaluate(() => {
          const v = window.__v;
          const li = v.leaf("^A rejected proposal said", "").closest("li");
          v.box(li, { pad: 8, dim: 0.2 });
        });
      },
    },
    // ============================================================================================ competition
    {
      id: "compete",
      chapter: "Who else is here, and how Strike differs",
      kind: "replay",
      screen: `The capability matrix from scripts/charts/data/competition.json (checked ${comp.checked}): rows appear, then the columns being described light up in turn (Stonkhouse and Archer Markets; Ribbon/Aevo, Derive and Thetanuts; Tilt Protocol), Strike's column shaded throughout.`,
      tag: "Competition",
      replay: {
        mode: "matrix",
        title: "Who picks the strike, and what holds them to it",
        projects: comp.projects,
        rows: comp.rows.filter((r) => COMP_ROWS.includes(r.row)),
        source: `Sources: each project's own docs and repository, checked ${comp.checked}. "not described" means those pages do not cover it. README.md · Competition`,
      },
      lines: [
        L("Who else is here?"),
        L(
          "Stonkhouse and Archer Markets on Robinhood Chain are order books: | traders pick strike and price.",
        ),
        L(
          "Ribbon, Derive and Thetanuts sell crypto options | by auction, order book or RFQ.",
          "Ribbon, Derive and Theta-nuts sell crypto options | by auction, order book or R F Q.",
        ),
        L("Tilt's AI manages vaults, with no options; | its sources don't say what limits it on-chain."),
      ],
      async prepare(page) {
        await page.evaluate(() => window.__mx.rows(0));
      },
      async run(h) {
        const col = (name) => comp.projects.indexOf(name) + 1;
        const focus = (cols) => h.page.evaluate((c) => window.__mx.focus(c), cols);
        for (let r = 1; r <= COMP_ROWS.length; r++) {
          await h.at(0.3 + r * 0.32);
          await h.page.evaluate((n) => window.__mx.rows(n), r);
        }
        await h.cue(1, -0.1);
        await focus([1, col("Stonkhouse"), col("Archer Markets")]);
        await h.cue(2, -0.1);
        await focus([1, col("Ribbon / Aevo"), col("Derive (Lyra)"), col("Thetanuts")]);
        await h.cue(3, -0.1);
        await focus([1, col("Tilt Protocol")]);
        await h.at(h.tl.lines[3].end + 0.1);
        await focus(null);
      },
    },
    {
      id: "position",
      kind: "page",
      screen:
        "The whole positioning chart (docs/media/charts/competition-positioning-light.png: who picks the strike against how the price is set) above the caption bar; Strike is boxed, then Stonkhouse and Archer Markets, the two others on Robinhood Chain.",
      tag: "Competition",
      lines: [
        L(
          "In Strike, a bonded agent proposes, | the contract enforces mandate and price, | and rule-breakers pay.",
        ),
        L("Stock-token traps are handled on-chain."),
        L("Holders get income and keep their keys."),
      ],
      async prepare(page) {
        const png = readFileSync(join(ROOT, "docs/media/charts/competition-positioning-light.png"));
        await page.route("https://video.strike.local/**", (r) =>
          r.request().url().endsWith(".png")
            ? r.fulfill({ contentType: "image/png", body: png })
            : r.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html><body style="margin:0;background:#e9e9e7;width:1920px;height:1080px;overflow:hidden"><img id="c" src="/c.png" style="position:absolute;left:${(1920 - IMG_W) / 2}px;top:${IMG_TOP}px;width:${IMG_W}px;height:${IMG_H}px"></body></html>`,
              }),
        );
        await page.goto("https://video.strike.local/position");
        await page.locator("#c").evaluate((img) => img.decode());
      },
      async run(h) {
        // The whole chart stays in frame (no zoom): a box on Strike, then one on the two competitors on Robinhood
        // Chain (Stonkhouse, Archer Markets); the scene ends with both boxed. Positions are fractions of the chart.
        const box = (fx, fy, fw, fh) =>
          h.page.evaluate(
            ([fx, fy, fw, fh]) => {
              const r = window.__v.rect(document.getElementById("c"));
              window.__v.box(
                { x: r.x + r.w * fx, y: r.y + r.h * fy, w: r.w * fw, h: r.h * fh },
                { pad: 8, dim: 0 },
              );
            },
            [fx, fy, fw, fh],
          );
        await h.at(0.8);
        await box(0.835, 0.19, 0.105, 0.06);
        await h.cue(1, -0.2);
        await box(0.285, 0.69, 0.145, 0.072);
      },
    },
    // ============================================================================================ 6. challenges
    {
      id: "challenges",
      chapter: "Challenges, solutions and close",
      kind: "replay",
      screen:
        "A two-column card: each challenge and how Strike solves it, lit as it is said, ending with what is not done yet.",
      tag: "Challenges",
      replay: {
        mode: "challenges",
        rows: [
          ["Weekend price freezes", "Settle on the first price at or after expiry"],
          ["The multiplier trap", "Never applied; tested on a fork of mainnet"],
          ["Trusting an agent", "Immutable mandate, bond and slashing"],
          ["Gas for on-chain pricing", `Rust on Stylus: a ${f.stylusSolverX}× cheaper strike solver`],
          ["Not done yet", "No external audit; testnet only"],
        ],
      },
      lines: [
        L("Weekend freezes: settle on the first post-expiry price."),
        L("Multiplier: never applied, fork-tested."),
        L("Agent trust: fixed mandate, bond, slashing."),
        L(
          `Gas: Rust on Stylus, ${f.stylusSolverX} times cheaper.`,
          `Gas: Rust on Stylus, ${sayDec(f.stylusSolverX)} times cheaper.`,
        ),
        L("Not done: no audit, and testnet only."),
      ],
      async run(h) {
        for (let i = 0; i < 5; i++) {
          await h.cue(i, -0.15);
          await h.page.evaluate((i) => window.__chal.show(i), i);
        }
      },
    },
    // ============================================================================================ 7. close
    {
      id: "close",
      screen: `The closing card: the line, **strike-options.vercel.app**, the repository and "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited", then a few seconds of silence.`,
      tag: "Strike",
      kind: "replay",
      tail: 0.8,
      replay: {
        mode: "close",
        title: "Options on Robinhood Chain and Arbitrum, run by agents the contract holds to a mandate.",
        app: "strike-options.vercel.app",
        repo: "github.com/Prashant-thakur77/Strike",
        badge: "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited",
      },
      lines: [L("Strike: options on Robinhood Chain and Arbitrum, | run by agents held to a mandate.")],
      async run(h) {
        await h.page.evaluate(() => window.__close.show(2));
        await h.at(1.6);
        await h.page.evaluate(() => window.__close.show(4));
        await h.at(3.2);
        await h.page.evaluate(() => window.__close.show(5));
      },
    },
  ];
}

/** The walkthrough vault's week after its Friday expiry, as the chain stands at render time. While the series waits
 *  for its settlement price: the vault page's settlement panel and the epoch trace. Once it has settled, this scene
 *  must be rewritten to show the settled trace and the decision page's "In hindsight"; until then the render stops. */
function settleScene(f, live) {
  if (live.settled)
    throw new Error(
      `sTSLA-CC settled (${JSON.stringify(live.settled)}): show the settled epoch trace and "In hindsight" in settleScene`,
    );
  if (!live.expiry || live.expiry * 1000 > Date.now()) throw new Error("sTSLA-CC has not expired yet");
  if (live.lastPrint >= live.expiry)
    throw new Error("a TSLA print at or after expiry exists: settlement is possible");
  const day = new Date(live.expiry * 1000).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const sayHhmm = (hm) => {
    const [hh, mm] = hm.split(":").map(Number);
    return `${sayInt(hh)}${mm ? ` ${mm < 10 ? `oh ${sayInt(mm)}` : sayInt(mm)}` : " hundred"}`;
  };
  return {
    id: "settle",
    screen: `The same covered-call vault page after the ${day} ${live.expiryHhmm} UTC expiry, unsettled at render time (from /api/status): the "Expired, settling" panel, why it waits (the first mainnet Chainlink print at or after expiry; settle reverts with InvalidSettlementRound for any other round), the last print at ${live.lastPrintHhmm} UTC, then the epoch trace with each step's transaction and "Settlement pending".`,
    tag: "Settlement",
    lines: [
      L(
        `The call expired ${day} at ${live.expiryHhmm} UTC; | it has not settled yet.`,
        `The call expired ${day} at ${sayHhmm(live.expiryHhmm)} U T C; | it has not settled yet.`,
      ),
      L(
        "It settles at the first mainnet Chainlink print after expiry; | the contract rejects any other price.",
      ),
      L(
        `The last print, at ${live.lastPrintHhmm}, came before expiry.`,
        `The last print, at ${sayHhmm(live.lastPrintHhmm)}, came before expiry.`,
      ),
      L("The epoch trace shows each step's transaction, | and what is pending."),
    ],
    async prepare(page) {
      await openApp(page, `/app/vault/${CC_VAULT}`, () =>
        page
          .getByText("Waiting for the settlement price", { exact: false })
          .first()
          .waitFor({ timeout: 60_000 }),
      );
      for (const t of ["Expired, settling", `Last print: `, "InvalidSettlementRound", "Settlement pending"])
        await page.getByText(t, { exact: false }).first().waitFor({ timeout: 30_000 });
      await scrollToText(page, /Waiting for the settlement price\.?$/, 260);
    },
    async run(h) {
      const focus = (src) =>
        h.page.evaluate((src) => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          const el = v.leaf(src, "");
          if (!el) throw new Error(`no element matches /${src}/`);
          v.box(el, { pad: 10, dim: 0.22 });
          v.zoom(el, 1.45);
        }, src);
      await h.at(0.3);
      await focus("^Expired .*Waiting for the settlement price\\.?$");
      await h.cue(1, -0.2);
      await focus("^It settles at the first Chainlink");
      await h.cue(2, -0.2);
      await focus("^Last print: ");
      await h.cue(3, -0.5);
      await h.unbox();
      await h.unzoom(300);
      await h.scrollTo(/^Epoch trace$/i, { offset: 120, ms: 800 });
      await h.page.evaluate(() => {
        const v = window.__v;
        const r = v.rect(v.leaf("^Settlement pending$", "").closest("ol, ul"));
        v.zoomRect({ x: r.x, y: r.y, w: r.w, h: Math.min(r.h, 640) }, 1.3);
      });
      await h.chunk(3, 1, -0.3);
      await h.page.evaluate(() => {
        const v = window.__v;
        const step = v.leaf("^Settlement pending$", "").closest("li");
        v.box(step, { pad: 10, dim: 0.22 });
        v.zoom(step, 1.4);
      });
    },
  };
}

/** Recorded once with a real signature (`--live-sign`), then replayed from video/clips on every render. */
function signingScene(f) {
  return {
    id: "signing",
    screen:
      '`/app/agents`, "Run your own agent": a test wallet connects, fills the form (its ERC-8004 identity, a 60 USDG bond) and signs two transactions (register, then bond; the USDG allowance was set before the take) in a confirmation panel labelled as the test wallet; the app shows each pending and done state; then the bond transaction on the explorer. Recorded for real on 1 October: this is how agent #2 joined.',
    tag: "Run an agent",
    kind: "clip",
    clip: "video/clips/signing.mp4",
    // the 33.5 s take plays 1.6 times faster (the block waits and the explorer load); the lines keep their places
    // in it: `pre` holds the last two until the screen they describe (signing.json has the take's own line times)
    clipSpeed: 1.6,
    minDur: 20.9,
    lines: [
      L("Anyone can run an agent, with no permission."),
      L(
        "Here a test wallet registers an agent | and bonds 60 USDG, above the 50 minimum.",
        `Here a test wallet registers an agent | and bonds sixty ${U}, above the fifty minimum.`,
      ),
      L("The wallet signs each step: | register, then bond."),
      L("Each one waits for its block on Robinhood Chain testnet."),
      L(
        `Now it can propose. | Every rejected proposal costs it ${f.slash} USDG.`,
        `Now it can propose. | Every rejected proposal costs it ${sayInt(f.slash)} ${U}.`,
        { pre: 0.6 },
      ),
    ],
    context: signingContext,
    prepare: signingPrepare,
    run: signingRun,
  };
}

export const outputs = {
  narrated: "strike-demo.mp4",
  silent: "strike-demo-silent.mp4",
  srt: "strike-demo.srt",
  poster: "strike-demo-poster.png",
  gif: "strike-demo.gif",
  transcript: "strike-demo-narration.txt",
};
export const poster = { scene: "surface3d", at: 24 };
export const gifScene = "flow3d";
export const timing = { lead: 0.08, gap: 0.1, tail: 0.15 };
export const crf = 24;
/** The demo reads faster than the pitch: every take sped up 32% with Rubber Band (formants kept), to fit the
 *  decision pages, the settlement state and the proof page's liveness checks into about five and a half minutes. */
export const tts = { speed: 1.32, speed_max_cps: 23, max_cps: 19 };
/** The music bed (video/narration/music.py, CC0): ducked under the voice, -16 LUFS overall. */
export const music = { seed: 7, speech_lufs: -31, gap_db: 5, fade_in: 2, fade_out: 3 };

export const scriptDoc = {
  path: "docs/submission/demo-script.md",
  head: ({ total, words, wpm, mmss, chapters }) => `# Demo video script (${mmss(total)})

The narration of [docs/media/strike-demo.mp4](../media/strike-demo.mp4) (${total.toFixed(1)} s, 1920×1080, narrated, with a quiet music bed), and the captions of the voiceless cut [strike-demo-silent.mp4](../media/strike-demo-silent.mp4). Both are rendered by \`node video/record.mjs demo\` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The arc: the problem (over stock footage), the turn, the key features, the architecture (a 3D scene with a spotlight on each part as it is named), one depositor's walkthrough of the live product on both chains (including the decision pages, the week after its expiry as the chain stands at render time, and the proof page's liveness checks), the competition, challenges and solutions, and the close. The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, read 32% faster with Rubber Band (formants kept): ${words} words in ${total.toFixed(0)} s (${wpm} words a minute, numbers counted as one word). Every number is read from README.md and the epoch logs at render time; the NVDA multiplier, the decision page's break-even and odds, the mirror audit's round count and the settlement state are read from the live app, the count of verified transactions from a live run of \`scripts/check-claims.mjs\`, and the DecisionLog hash is recomputed and read from Arbitrum Sepolia. The 3D scenes are three.js pages ([video/three.html](../../video/three.html)) drawn from the same numbers. Footage and music credits: [docs/media/CREDITS.md](../media/CREDITS.md). Nothing here is audited: the video says so.

## Chapters

Ready to paste into a YouTube description:

\`\`\`
${chapters.join("\n")}
\`\`\`

## Video description

\`\`\`
Strike: weekly options vaults for Robinhood Chain stock tokens, run by AI agents the contract holds to a mandate. Live on Robinhood Chain testnet and Arbitrum Sepolia. Unaudited; testnet only.

App: https://strike-options.vercel.app
Code: https://github.com/Prashant-thakur77/Strike

${chapters.join("\n")}

Voice: Chatterbox TTS (Resemble AI, open source) with a synthetic reference voice.
Music: "Strike ambient bed", synthesised for this video by video/narration/music.py; original work, dedicated to the public domain (CC0 1.0).
Stock footage: Pexels (Pexels License); clip list and links in docs/media/CREDITS.md.
\`\`\``,
};
