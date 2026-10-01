// The demo walkthrough, scene by scene, on the arc problem -> turn -> key features -> architecture -> one user's
// walkthrough of the live product -> challenges and solutions -> close. Each scene: what is said (`lines`, captioned
// word for word), what is on screen (`prepare` runs before the clock starts, `run` on the clock), its caption tag,
// and `chapter` where a chapter of the YouTube description starts. Durations come from the narration audio, so
// editing a line re-times its scene. Numbers come from README.md and the epoch logs (facts, facts.arb) or the live
// app and chain, read at render time. Plan and reasons: docs/submission/demo-script.md.
//
// Adding a scene is one entry in the list returned by scenes(). The Friday settlement (2 October, after 20:00 UTC)
// is left out until it has happened; its slot is marked "FRIDAY SETTLEMENT" below, with what the scene should show.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { L, ROOT } from "./lib/engine.mjs";
import { sayDec, sayInt, sayUsd } from "./lib/facts.mjs";
import { signingContext, signingPrepare, signingRun } from "./lib/wallet.mjs";

export const APP = (process.env.APP_URL ?? "https://strike-options.vercel.app").replace(/\/$/, "");
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const ARBISCAN = "https://sepolia.arbiscan.io";
const ARB_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const REJECT_TX = "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0";
const CC_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"; // sTSLA-CC, v2 on 46630
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
  await ctx.close();
  return {
    nvdaMultiplier: mult,
    nvdaMultiplierSaid: Number(mult).toFixed(6),
    riskWorst: worst.replace(/,/g, ""),
    ...(await mcpProbe()),
    ...(await anchorProbe()),
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

/** Re-hash the Claude-planned decision record and read its anchor from the DecisionLog on Arbitrum Sepolia. */
async function anchorProbe() {
  const { keccak256, toBytes, createPublicClient, http, parseAbi } = require("viem");
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
  const onchain = await client.readContract({
    address: anchor.contract,
    abi: parseAbi(["function latestHash(uint256,address,uint64) view returns (bytes32)"]),
    functionName: "latestHash",
    args: [BigInt(rec.agent.agentId), rec.vault.address, BigInt(anchor.epoch)],
  });
  if (recomputed !== anchor.recordHash || onchain !== anchor.recordHash)
    throw new Error(`anchor: file ${anchor.recordHash}, recomputed ${recomputed}, on-chain ${onchain}`);
  return { anchorHash: onchain };
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

/** Box and zoom on the card around a label (its parent element, `up` levels up). */
async function focusCard(h, re, { up = 1, scale = 1.45, dim = 0.22 } = {}) {
  await h.page.evaluate(
    ([src, flags, up, scale, dim]) => {
      const v = window.__v;
      document.querySelectorAll(".__vbox").forEach((d) => d.remove());
      let el = v.leaf(src, flags);
      if (!el) throw new Error(`no element matches /${src}/`);
      for (let i = 0; i < up; i++) el = el.parentElement;
      const r = v.rect(el);
      v.box(r, { pad: 10, dim });
      v.zoomRect(r, scale);
    },
    [re.source, re.flags, up, scale, dim],
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
  const fifth = (n) =>
    ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"][n];
  const expirySaid = f.expiryDay.replace(
    /^(\w+) (\d+) (\w+)$/,
    (_, d, n, mo) => `${d}, ${mo} ${fifth(Number(n)) ?? n}`,
  );
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
        L(
          "On Robinhood Chain, they can hold them as tokens. | But a token earns nothing while it sits in a wallet.",
        ),
        L(
          "On Wall Street, holders sell covered calls for weekly income. | But someone has to pick the strike each week, | and you have to trust them.",
        ),
        L(
          "On-chain it is harder: | a multiplier that is easy to apply twice, | prices that freeze on weekends, | pause switches, and mid-week splits.",
        ),
        L("So the tokens sit idle, | or go to a manager nobody can check."),
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
      chapter: "Strike",
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
        L(
          "Now imagine an AI agent that picks the strike every week, | and a contract that won't let it break the rules.",
        ),
        L("This is Strike: | weekly options vaults for Robinhood Chain stock tokens."),
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
      chapter: "Key features",
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
        L("Depositors earn a weekly premium in USDG.", `Depositors earn a weekly premium in ${U}.`),
        L("An AI agent picks the strike, inside a mandate the contract enforces."),
        L("Break the mandate, and its bond goes to the depositors."),
        L("The math runs on-chain, in Rust on Arbitrum Stylus."),
        L("And it is live on Robinhood Chain testnet and Arbitrum Sepolia."),
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
        L("Here is one week, inside Strike."),
        L("Depositors put stock tokens in a vault with a fixed mandate."),
        L(
          "An agent reads the vault through MCP tools, | and dry-runs its proposal.",
          "An agent reads the vault through M C P tools, | and dry-runs its proposal.",
        ),
        L("Then it proposes a call: | a delta, an expiry, a size and a price."),
        L(
          "The Epoch Manager checks it against the mandate, | at prices from a guarded stock oracle.",
          `The ${EM} checks it against the mandate, | at prices from a guarded stock oracle.`,
        ),
        L("A Rust pricer on Stylus solves the strike, | and a risk engine stress-tests it."),
        L("If it passes, buyers pay premium in USDG.", `If it passes, buyers pay premium in ${U}.`),
        L("If not, it is rejected, and the bond is slashed to depositors."),
        L(
          "Each decision is hashed into a DecisionLog, | and the agent has an ERC-8004 identity.",
          "Each decision is hashed into a Decision Log, | and the agent has an E R C eighty oh four identity.",
        ),
        L("After Friday's close the options settle, | and the premium, less a fee, goes to depositors."),
        L("The same contracts run on Robinhood Chain testnet and Arbitrum Sepolia."),
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
      screen: `The TSLA covered-call vault page: zoom on the $${f.strike} strike and the ${f.premium} USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven.`,
      tag: "Vault",
      lines: [
        L("Now one depositor: | say Maya holds Tesla tokens, and opens the covered-call vault."),
        L(
          `This week it sold the $${f.strike} call, all four options, | to a buyer agent, for ${f.premium} USDG.`,
          `This week it sold the ${sayUsd(f.strike)} call, all four options, | to a buyer agent, for ${sayDec(f.premium)} ${U}.`,
        ),
        L(
          "At or below the strike, depositors like Maya keep all of it. | The buyer only profits above $372.36.",
          `At or below the strike, depositors like Maya keep all of it. | The buyer only profits above ${sayUsd("372.36")}.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${CC_VAULT}`, () =>
          page.getByText("How the buy price is set").first().waitFor({ timeout: 60_000 }),
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
        await h.chunk(1, 1, 0.6);
        await h.box(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { pad: 10, dim: 0.15 });
        await h.zoom(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { scale: 1.8 });
        await h.cue(2, -0.5);
        await h.unbox();
        await h.unzoom(300);
        await h.scrollTo(/^Result at expiry/, { offset: 110, ms: 900 });
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
        L("She doesn't have to trust the agent: | the limits are in the contract."),
        L(
          `Delta between ${m.deltaLo} and ${m.deltaHi}. | At least ${m.minPremiumPct}% of fair value. | A yield of at least ${m.minYieldPct}%.`,
          `Delta between ${sayDelta(m.deltaLo)} and ${sayDelta(m.deltaHi)}. | At least ${sayInt(m.minPremiumPct)} percent of fair value. | A yield of at least ${sayDelta(m.minYieldPct)} percent.`,
        ),
        L(
          `At most ${m.maxSoldPct}% sold, | and ${m.tenorMin} to ${m.tenorMax} days to expiry. | Nobody can change them.`,
          `At most ${sayInt(m.maxSoldPct)} percent sold, | and ${sayInt(m.tenorMin)} to ${sayInt(m.tenorMax)} days to expiry. | Nobody can change them.`,
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
        L(
          "She can test the rules herself: | the playground asks the deployed Epoch Manager, with no wallet.",
          `She can test the rules herself: | the playground asks the deployed ${EM}, with no wallet.`,
        ),
        L("An honest 0.20-delta call: accepted.", "An honest zero point two oh delta call: accepted."),
        L("A reckless at-the-money strike: | rejected, delta out of band."),
        L(
          `A real one would cost the agent ${f.slash} USDG of its bond, | paid to depositors like Maya.`,
          `A real one would cost the agent ${sayInt(f.slash)} ${U} of its bond, | paid to depositors like Maya.`,
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
      id: "pricing",
      screen: `The vault page, "How the buy price is set": the priced spot (oracle + ${a.spotBufferPct}% against the buyer), the Black-Scholes fair value, the premium factor and the intrinsic-value floor, each zoomed as it is said.`,
      tag: "Pricing",
      lines: [
        L(
          `Buyers pay a price set when they buy: | the oracle spot moved ${a.spotBufferPct}% against them, | priced with Black-Scholes, times the agent's premium factor.`,
          `Buyers pay a price set when they buy: | the oracle spot moved ${sayDec(a.spotBufferPct)} percent against them, | priced with Black Scholes, times the agent's premium factor.`,
        ),
        L("Never below intrinsic value, | so Monday's price can't be picked off on Wednesday."),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${CC_VAULT}`, () =>
          page.getByText("How the buy price is set", { exact: false }).first().waitFor({ timeout: 60_000 }),
        );
        await page.getByText(`+ ${a.spotBufferPct}%`, { exact: false }).first().waitFor({ timeout: 30_000 });
        await scrollToText(page, /^How the buy price is set$/i, 300);
      },
      async run(h) {
        await h.at(0.4);
        await focusCard(h, /^How the buy price is set$/i, { scale: 1.15, dim: 0.12 });
        await h.chunk(0, 1, -0.2);
        await focusCard(h, /^Priced spot$/i, { scale: 1.6 });
        await h.chunk(0, 2, -0.2);
        await focusCard(h, /^Fair value$/i, { scale: 1.5 });
        await h.cue(1, -0.2);
        await h.page.evaluate(() => {
          const v = window.__v;
          document.querySelectorAll(".__vbox").forEach((d) => d.remove());
          const el = v.leaf("never below intrinsic value", "i");
          v.box(el, { pad: 10, dim: 0.22 });
          v.zoom(el, 1.7);
        });
      },
    },
    {
      id: "epoch",
      chapter: "Live on Robinhood Chain testnet, 29 September",
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
          "Maya's vault ran for real on September 29.",
          "Maya's vault ran for real on September twenty-ninth.",
        ),
        L(
          `The seller agent asked for a 0.20-delta Tesla call, | and the contract solved the strike on-chain: $${f.strike}, accepted.`,
          `The seller agent asked for a zero point two oh delta Tesla call, | and the contract solved the strike on-chain: ${sayUsd(f.strike)}. Accepted.`,
        ),
        L("Then a reckless agent forced an at-the-money put."),
        L(
          `Rejected, and ${f.slash} USDG slashed: | its bond went from ${f.bondBefore} to ${f.bondAfter}.`,
          `Rejected, and ${sayInt(f.slash)} ${U} slashed: | its bond went from ${sayInt(f.bondBefore)} to ${sayInt(f.bondAfter)}.`,
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
        await h.cue(1, 0.2);
        await t("^\\s*Verdict: None", 120);
        await h.chunk(1, 1, -0.6);
        await t("^\\s*Accepted", 110);
        await h.page.evaluate(() => window.__term.mark("^\\s*Accepted", "hl"));
        await h.cue(2, -0.5);
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
        await t("^\\s*A careful agent", 130);
        await h.cue(3, -0.8);
        await t("REJECTED", 110);
        await h.page.evaluate(() => window.__term.mark("REJECTED", "hlbad"));
        await h.chunk(3, 1, -0.4);
        await t("^\\s*Agent now", 90);
        await h.page.evaluate(() => window.__term.mark("^\\s*Agent now", "hlbad"));
      },
    },
    {
      id: "explorer",
      screen: `The rejected \`proposeSeries\` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](${EXPLORER}/tx/${REJECT_TX})): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for ${f.slash} USDG".`,
      tag: "Explorer",
      minDur: 9,
      lines: [
        L(
          `On the explorer it says Success: a rejection is not a revert, | and ${f.slash} USDG left the agent's bond.`,
          `On the explorer it says Success: a rejection is not a revert, | and ${sayInt(f.slash)} ${U} left the agent's bond.`,
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
    // FRIDAY SETTLEMENT: after 20:00 UTC on Friday 2 October, add one scene here, e.g. { id: "settle", kind: "replay",
    // replay: { mode: "terminal", ... }, lines: [...] } replaying the keeper's settle and the buyer's --redeem from the
    // epoch logs (docs/testnet-epochs/), with the settlement price and payouts read from the log the same way as
    // epochLog() in record.mjs. Nothing else in the list has to change.
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
        L("On Arbitrum Sepolia, Claude planned the proposal itself."),
        L(
          `Through Claude Code and Strike's MCP server, | it read the vault, | and dry-ran ${f.arbCandidatesWord} candidates with risk_check.`,
          `Through Claude Code and Strike's M C P server, | it read the vault, | and dry-ran ${sayInt(a.candidates.length)} candidates with risk check.`,
        ),
        L(
          `It chose a ${a.delta} delta at ${a.premiumPct}% of fair value, | and wrote down why: | mid-band, so a small move can't push it out of the mandate.`,
          `It chose a ${sayDelta(a.delta)} delta at ${sayInt(a.premiumPct)} percent of fair value, | and wrote down why: | mid-band, so a small move can't push it out of the mandate.`,
        ),
        L(
          `The contract solved the strike, $${a.strike}, and accepted it.`,
          `The contract solved the strike, ${sayUsd(a.strike)}, and accepted it.`,
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
        await h.cue(1, -0.2);
        await t("^\\s*Claude Code \\d", 140);
        await h.chunk(1, 1, -0.2);
        await t("Claude calls vault_state", 100);
        await h.chunk(1, 2, -0.3);
        await t("Claude calls agent_stats", 260);
        await h.cue(2, -0.3);
        await t("^\\s*Claude's plan", 100);
        await mark("^\\s*Claude's plan");
        await h.chunk(2, 1, -0.2);
        await t("^\\s*Why:", 100);
        await h.cue(3, -0.6);
        await t("^\\s*Accepted", 70);
        await mark("^\\s*Accepted");
      },
    },
    {
      id: "arbiscan",
      screen: `The accepted \`proposeByDelta\` transaction on Arbiscan ([0xf26315b3…b5f4](${ARBISCAN}/tx/${a.tx})): zoom on the **Success** status, then on the transaction action (a call from the agent's signer to the EpochManager).`,
      tag: "Arbiscan",
      userAgent: DESKTOP_UA,
      minDur: 10,
      lines: [
        L(
          "On Arbiscan: | a successful call to the Epoch Manager, from the agent's signer.",
          `On Arbiscan: | a successful call to the ${EM}, from the agent's signer.`,
        ),
        L(
          `In the same run, a reckless put was rejected with a ${f.arbSlash} USDG slash, | and a buyer took all ${f.arbBought} calls.`,
          `In the same run, a reckless put was rejected with a ${sayInt(f.arbSlash)} ${U} slash, | and a buyer took all ${sayInt(f.arbBought)} calls.`,
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
        L("Here is that covered call, in 3D.", "Here is that covered call, in three D."),
        L("Across, Tesla's price. | Front to back, days to expiry. | Up, one covered share's value."),
        L(
          `At expiry, it bends flat at the $${a.strike} strike: | above it, the upside goes to the buyer.`,
          `At expiry, it bends flat at the ${sayUsd(a.strike)} strike: | above it, the upside goes to the buyer.`,
        ),
        L(
          `Below it, the depositor keeps the stock, | plus $${prem} of premium per option.`,
          `Below it, the depositor keeps the stock, | plus ${sayUsd(prem)} of premium per option.`,
        ),
      ],
      async run(h) {
        const l = h.tl.lines;
        const c2 = l[2].chunks;
        await play3d(h, [
          l[0].start,
          ...l[1].chunks.map((c) => c.start),
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
        L("The math is written in Rust, and runs on Arbitrum Stylus."),
        L(
          `Solving the strike takes ${f.solverSteps} Black-Scholes evaluations. | In Stylus, that costs ${f.stylusSolverX} times less gas than in Solidity, | and the whole proposal ${f.stylusTxX} times less.`,
          `Solving the strike takes ${sayInt(f.solverSteps)} Black Scholes evaluations. | In Stylus, that costs ${sayDec(f.stylusSolverX)} times less gas than in Solidity, | and the whole proposal ${sayDec(f.stylusTxX)} times less.`,
        ),
      ],
      async run(h) {
        const l = h.tl.lines;
        await play3d(h, [l[0].start, l[1].start, l[1].chunks[1].start, l[1].chunks[2].start]);
      },
    },
    {
      id: "decisionlog",
      chapter: "Decision records and identity",
      screen: `A terminal: the Claude-planned decision record (planner, target, the start of the reasoning), then its keccak256 recomputed from the published file and the DecisionLog's \`latestHash\` read from Arbitrum Sepolia at render time; both are ${live.anchorHash.slice(0, 10)}…`,
      tag: "DecisionLog",
      kind: "replay",
      replay: {
        mode: "terminal",
        wintitle: "~/strike · Arbitrum Sepolia (421614) · computed and read at render time",
        sublabel: "docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json",
      },
      lines: [
        L(
          "Every run leaves a decision record: | what the agent saw, what it chose and why, and what the contract said.",
        ),
        L(
          "Its hash is anchored in the DecisionLog contract. | Hash the published file again, and it matches the chain.",
          "Its hash is anchored in the Decision Log contract. | Hash the published file again, and it matches the chain.",
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
          command: `cast call ${a.anchor.contract.slice(0, 10)}… "latestHash(uint256,address,uint64)" ${a.agentId} ${a.vault.slice(0, 8)}… ${a.anchor.epoch}`,
          lines: [
            `On-chain latestHash ${live.anchorHash}`,
            "Match: the published record is the one the agent anchored.",
          ],
        });
        await t("Match", 140);
        await h.page.evaluate(() => window.__term.mark("^Match", "hl"));
      },
    },
    {
      id: "agents",
      screen: `\`/app/agents\` leaderboard: zoom on agent #1's ERC-8004 #${f.identity} link, then on its ${f.bondAfter} USDG bond.`,
      tag: "ERC-8004",
      lines: [
        L(
          `On the leaderboard, the agent's public ERC-8004 identity: | ${f.identity} on Robinhood Chain testnet, ${f.arbIdentity} on Arbitrum Sepolia.`,
          `On the leaderboard, the agent's public E R C eighty oh four identity: | ${f.identity === "114" ? "one-fourteen" : sayInt(f.identity)} on Robinhood Chain testnet, ${f.arbIdentity === "253" ? "two-fifty-three" : sayInt(f.arbIdentity)} on Arbitrum Sepolia.`,
        ),
        L(
          "Any agent can join the same way, through the public MCP server, with no allow-list.",
          "Any agent can join the same way, through the public M C P server, with no allow-list.",
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
        const row = h.page.getByRole("button", { name: /about agent 1$/ }).first();
        if ((await row.getAttribute("aria-expanded").catch(() => null)) === "false") await row.click();
        await h.at(0.9);
        await focusCard(h, /^ERC-8004 identity$/i, { scale: 1.7 });
        await h.chunk(0, 1, 0.6);
        await h.unbox();
        await h.unzoom(400);
        await h.cue(1, -0.3);
        // "Testnet agents welcome. ... No permission needed": the open-join banner at the top of the page
        await h.scrollTo(/^Testnet agents welcome\.?$/i, { offset: 260, ms: 900 });
        await focusCard(h, /^Testnet agents welcome\.?$/i, { scale: 1.4 });
      },
    },
    {
      id: "monitor",
      chapter: "The multiplier trap, live",
      screen: `\`/app/monitor\`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (${live.nvdaMultiplier}, read from the page at render time).`,
      tag: "Monitor",
      lines: [
        L("This monitor reads every stock token | on Robinhood Chain mainnet, live."),
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
      chapter: "Backtest: what it shows, and what it doesn't",
      screen: `\`/app/backtest\` (TSLA): zoom on the volatility figures, then on the annual return (${f.tslaCcCagr}% against ${f.tslaHeldCagr}% held); then the assumption.`,
      tag: "Backtest",
      lines: [
        L(
          `Over ${f.backtestWeeks} weekly epochs since 2019, | the covered call cut volatility by ${f.volCut}%.`,
          `Over ${sayInt(f.backtestWeeks)} weekly eepoks since twenty nineteen, | the covered call cut volatility by ${f.volCut.split(" to ").map(sayInt).join(" to ")} percent.`,
        ),
        L(
          `But it lagged holding on every ticker: | Tesla returned ${f.tslaCcCagr}% a year in the vault, against ${f.tslaHeldCagr}% held.`,
          `But it lagged holding on every ticker: | Tesla returned ${sayDec(f.tslaCcCagr)} percent a year in the vault, against ${sayDec(f.tslaHeldCagr)} percent held.`,
        ),
        L("And it assumes buyers take the full size every week, | which no contract can guarantee."),
      ],
      async prepare(page) {
        await openApp(page, "/app/backtest", () =>
          page.getByText(`${f.backtestWeeks} weeks`).first().waitFor({ timeout: 60_000 }),
        );
        await page.locator("#bt-equity-body svg").waitFor();
        const stock = page.getByRole("group", { name: "Stock" });
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
      chapter: "Evidence: the proof page",
      screen: `\`/app/proof\`: the headline tiles (deployment, Foundry tests, coverage, internal review), then the pricer read from the chain when the page loads.`,
      tag: "Proof",
      lines: [
        L("The proof page puts every claim next to its evidence."),
        L(
          `${f.testsTotal} tests and proofs, | ${f.coverage}% line coverage, | ${sayInt(f.halmos)} properties proven with Halmos, | and all ${f.reviewFindings} internal-review findings fixed.`,
          `${sayInt(f.testsTotal)} tests and proofs, | ${sayDec(f.coverage)} percent line coverage, | ${sayInt(f.halmos)} properties proven with Halmos, | and all ${sayInt(f.reviewFindings)} internal review findings fixed.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/proof", () =>
          page
            .getByText(/^Internal review$/i)
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        await scrollToText(page, /^Deployment$/i, 260);
      },
      async run(h) {
        await h.cue(1, -0.2);
        await focusCard(h, /^Foundry tests$/i, { scale: 1.6 });
        await h.chunk(1, 1, -0.2);
        await focusCard(h, /^Coverage$/i, { scale: 1.6 });
        await h.chunk(1, 3, -0.2);
        await focusCard(h, /^Internal review$/i, { scale: 1.6 });
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
          "Stonkhouse and Archer Markets, on Robinhood Chain, are order books: | traders and writers pick the strike and set the price.",
        ),
        L(
          "Ribbon, Derive and Thetanuts, on other chains, | sell options on crypto by auction, order book or RFQ.",
          "Ribbon, Derive and Theta-nuts, on other chains, | sell options on crypto by auction, order book or R F Q.",
        ),
        L(
          "Tilt Protocol, a past winner, has an AI manage tokenized-asset vaults. | It sells no options, and its sources don't describe what limits that AI on-chain.",
        ),
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
          "In Strike, a bonded agent proposes, the contract checks an immutable mandate, | prices every buy at the oracle, | and makes a rule-breaking agent pay the depositors.",
        ),
        L("The stock-token traps are handled in the contract."),
        L("For a holder: income without handing over the keys, | and every decision checkable on-chain."),
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
      chapter: "Challenges and solutions",
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
          ["Not done yet", `No external audit; testnet only; both epochs settle ${f.expiryDay}`],
        ],
      },
      lines: [
        L("Weekend freezes: settle on the first price after expiry."),
        L("The multiplier: never applied, tested on a mainnet fork."),
        L("Trusting an agent: a fixed mandate, a bond, and slashing."),
        L(
          `On-chain pricing: Rust on Stylus, ${f.stylusSolverX} times cheaper.`,
          `On-chain pricing: Rust on Stylus, ${sayDec(f.stylusSolverX)} times cheaper.`,
        ),
        L(
          `What's not done: there is no external audit, it is testnet only, | and both epochs settle on ${f.expiryDay}.`,
          `What's not done: there is no external audit, it is testnet only, | and both epochs settle on ${expirySaid}.`,
        ),
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
      chapter: "Close",
      screen: `The closing card: the line, **strike-options.vercel.app**, the repository and "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited", then a few seconds of silence.`,
      tag: "Strike",
      kind: "replay",
      tail: 1.9,
      replay: {
        mode: "close",
        title: "Options on Robinhood Chain and Arbitrum, run by agents the contract holds to a mandate.",
        app: "strike-options.vercel.app",
        repo: "github.com/Prashant-thakur77/Strike",
        badge: "Live on Robinhood Chain testnet and Arbitrum Sepolia · Unaudited",
      },
      lines: [
        L(
          "Strike: options on Robinhood Chain and Arbitrum, | run by agents the contract holds to a mandate.",
        ),
        L(
          "Try the playground at strike-options.vercel.app. | It is unaudited, and on testnet.",
          "Try the playground at strike dash options dot vercel dot app. | It is unaudited, and on testnet.",
        ),
      ],
      async run(h) {
        await h.page.evaluate(() => window.__close.show(2));
        await h.cue(1, -0.3);
        await h.page.evaluate(() => window.__close.show(4));
        await h.chunk(1, 1, -0.3);
        await h.page.evaluate(() => window.__close.show(5));
      },
    },
  ];
}

/** Recorded once with a real signature (`--live-sign`), then replayed from video/clips on every render. */
function signingScene(f) {
  return {
    id: "signing",
    screen:
      '`/app/agents`, "Run your own agent": a test wallet connects, fills the form (50 USDG bond) and signs two transactions (register, then bond; the USDG allowance was set before the take) in a confirmation panel labelled as the test wallet; the app shows each pending and done state; then the bond transaction on the explorer.',
    tag: "Run an agent",
    kind: "clip",
    clip: "video/clips/signing.mp4",
    minDur: 33.5,
    lines: [
      L("Anyone can run an agent, with no permission."),
      L(
        "Here a test wallet registers an agent | and bonds 50 USDG, the minimum.",
        `Here a test wallet registers an agent | and bonds fifty ${U}, the minimum.`,
      ),
      L("The wallet signs each step: | register, then bond."),
      L(
        "Each one waits for its block on Robinhood Chain testnet.",
        "Each one waits for its block on Robinhood Chain testnet.",
        {
          pre: 1.6,
        },
      ),
      L(
        `Now it can propose. | Every rejected proposal costs it ${f.slash} USDG.`,
        `Now it can propose. | Every rejected proposal costs it ${sayInt(f.slash)} ${U}.`,
        { pre: 4.6 },
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
export const timing = { lead: 0.2, gap: 0.22, tail: 0.3 };
export const crf = 24;
/** The music bed (video/narration/music.py, CC0): ducked under the voice, -16 LUFS overall. */
export const music = { seed: 7, speech_lufs: -31, gap_db: 5, fade_in: 2, fade_out: 3 };

export const scriptDoc = {
  path: "docs/submission/demo-script.md",
  head: ({ total, words, wpm, mmss, chapters }) => `# Demo video script (${mmss(total)})

The narration of [docs/media/strike-demo.mp4](../media/strike-demo.mp4) (${total.toFixed(1)} s, 1920×1080, narrated, with a quiet music bed), and the captions of the voiceless cut [strike-demo-silent.mp4](../media/strike-demo-silent.mp4). Both are rendered by \`node video/record.mjs demo\` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The arc: the problem (over stock footage), the turn, the key features, the architecture (a 3D scene with a spotlight on each part as it is named), one depositor's walkthrough of the live product on both chains, challenges and solutions, and the close. The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, ${words} words in ${total.toFixed(0)} s (${wpm} words a minute, numbers counted as one word). Every number is read from README.md and the epoch logs at render time; the NVDA multiplier is read from the live monitor, and the DecisionLog hash is recomputed and read from Arbitrum Sepolia. The 3D scenes are three.js pages ([video/three.html](../../video/three.html)) drawn from the same numbers. Footage and music credits: [docs/media/CREDITS.md](../media/CREDITS.md). Nothing here is audited: the video says so.

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
