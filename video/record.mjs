#!/usr/bin/env node
// Records the Strike demo video (a draft to narrate over) end to end:
//
//   node video/record.mjs            # from the repo root, Node 22, Foundry on PATH, `pnpm install` done
//
// 1. Starts its own anvil (NYSE hours), deploys Strike (Deploy.s.sol + Seed.s.sol).
// 2. Snapshot → runs the example agent flows (propose, --reckless, buyer --hedge) and captures their stdout
//    → reverts, then fills the chain with a realistic history (app/scripts/demo-chain.mjs).
// 3. Builds the app against that chain (NEXT_PUBLIC_LOCAL_RPC, NEXT_PUBLIC_DEFAULT_CHAIN_ID=31337; this rewrites
//    app/.next) and starts it.
// 4. Records the scenes with Playwright (1920x1080), with an injected caption bar, and a "terminal replay"
//    page (video/replay.html) for the agent output.
// 5. Cuts and joins the scenes with ffmpeg into docs/media/strike-demo.mp4, plus a poster PNG and a README GIF.
//
// Env: VIDEO_RPC_PORT (default 8561), VIDEO_APP_PORT (3261), SKIP_BUILD=1 (reuse app/.next, which must already
// point at the same RPC port), KEEP=1 (keep video/.out). Only processes this script starts are stopped, by PID.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "app");
const OUT = join(ROOT, "video", ".out");
const MEDIA = join(ROOT, "docs", "media");
const require = createRequire(join(APP_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const RPC_PORT = Number(process.env.VIDEO_RPC_PORT ?? 8561);
const APP_PORT = Number(process.env.VIDEO_APP_PORT ?? 3261);
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const START_TS = 1791212400; // Mon 2026-10-05 15:00 UTC: NYSE open

const HOME = process.env.HOME;
const ENV = { ...process.env, PATH: `${HOME}/.foundry/bin:${process.env.PATH}` };

// anvil's well-known dev accounts: #0 deployer / curator / agent 1, #1 depositor and buyer ("you").
const K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const A1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const log = (...a) => console.log("[video]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------ processes (ours)

const children = [];
function startChild(cmd, args, opts) {
  const child = spawn(cmd, args, { env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  children.push(child);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
  return child;
}
function stopChildren() {
  for (const c of children) {
    if (c.exitCode === null && c.pid) {
      // next start forks a worker: stop the whole process group we created (detached => own group).
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        try {
          c.kill("SIGTERM");
        } catch {}
      }
    }
  }
}
process.on("exit", stopChildren);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch (e) {
    return e?.cause?.code === "ECONNREFUSED";
  }
}
async function waitFor(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------------------------------ chain

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { env: ENV, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
const send = (key, to, sig, ...args) =>
  run("cast", ["send", "--rpc-url", RPC, "--private-key", key, to, sig, ...args.map(String)]);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function agent(key, args) {
  const r = spawnSync("pnpm", ["--silent", "--filter", "@strike/agent-example", "start", ...args], {
    cwd: ROOT,
    env: {
      ...ENV,
      STRIKE_CHAIN_ID: "31337",
      STRIKE_RPC_URL: RPC,
      STRIKE_AGENT_PRIVATE_KEY: key,
      FORCE_COLOR: "0",
    },
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.status !== 0) throw new Error(`agent ${args.join(" ")} failed:\n${out}`);
  return out.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
}

async function setupChain() {
  if (!(await portFree(RPC_PORT))) throw new Error(`port ${RPC_PORT} is busy (set VIDEO_RPC_PORT)`);
  log(`anvil on ${RPC} at ${new Date(START_TS * 1000).toISOString()}`);
  const anvil = startChild("anvil", [
    "--port",
    String(RPC_PORT),
    "--timestamp",
    String(START_TS),
    "--silent",
  ]);
  log(`anvil pid ${anvil.pid}`);
  await waitFor(async () => (await rpc("eth_chainId")) === "0x7a69", "anvil");

  log("deploy + seed");
  const fenv = { ...ENV, PRIVATE_KEY: K0 };
  for (const s of ["script/Deploy.s.sol", "script/Seed.s.sol"])
    run("forge", ["script", s, "--rpc-url", RPC, "--broadcast", "--silent"], {
      cwd: join(ROOT, "contracts"),
      env: fenv,
    });
  const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/31337.json"), "utf8"));
  const vaults = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/31337-vaults.json"), "utf8"));
  const TSLA = dep.stocks.TSLA.token;
  const CC = vaults.TSLA_covered_call;
  const CSP = vaults.TSLA_cash_secured_put;

  // --- terminal flows on a snapshot, so the app gets the richer history afterwards
  const snap = await rpc("evm_snapshot");
  log("agent flows (snapshot", snap + ")");
  const wei10 = (10n * 10n ** 18n).toString();
  send(K0, TSLA, "mint(address,uint256)", A0, wei10);
  send(K0, TSLA, "approve(address,uint256)", CC, wei10);
  send(K0, CC, "deposit(uint256,address)", wei10, A0);
  send(K0, dep.usdg, "approve(address,uint256)", CSP, 50_000_000_000);
  send(K0, CSP, "deposit(uint256,address)", 50_000_000_000, A0);
  const propose = agent(K0, ["--vault", "sTSLA-CC"]);
  const reckless = agent(K0, ["--reckless", "--vault", "sTSLA-CSP"]);
  agent(K0, ["--vault", "sTSLA-CSP"]); // a live put series for the buyer (not shown)
  send(K1, dep.usdg, "faucet(uint256)", 10_000_000_000);
  const hedge = agent(K1, ["--buy", "--hedge", "10", "--budget", "50"]);
  const flows = { propose, reckless, hedge };
  writeFileSync(join(OUT, "terminal.json"), JSON.stringify(flows, null, 2));
  for (const [k, v] of Object.entries(flows)) writeFileSync(join(OUT, `${k}.txt`), v.join("\n"));
  if (!(await rpc("evm_revert", [snap]))) throw new Error("evm_revert failed");

  log("demo history (app/scripts/demo-chain.mjs)");
  const out = run("node", ["scripts/demo-chain.mjs"], { cwd: APP_DIR, env: { ...ENV, RPC_URL: RPC } });
  process.stdout.write(out.replace(/^/gm, "  "));
  return { flows, CC, CSP };
}

// ------------------------------------------------------------------------------------------ app

async function startApp() {
  if (!process.env.SKIP_BUILD) {
    log("build app for the local chain (app/.next)");
    run("pnpm", ["build"], {
      cwd: APP_DIR,
      env: { ...ENV, NEXT_PUBLIC_LOCAL_RPC: RPC, NEXT_PUBLIC_DEFAULT_CHAIN_ID: "31337" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 << 20,
    });
  }
  if (!(await portFree(APP_PORT))) throw new Error(`port ${APP_PORT} is busy (set VIDEO_APP_PORT)`);
  const next = startChild(join(APP_DIR, "node_modules/.bin/next"), ["start", "-p", String(APP_PORT)], {
    cwd: APP_DIR,
  });
  log(`next start pid ${next.pid} on ${APP}`);
  await waitFor(async () => (await fetch(APP)).ok, "the app");
}

// ------------------------------------------------------------------------------------------ page helpers

/** Minimal EIP-1193 wallet (as in app/e2e/helpers.ts): accounts/chain answered locally, the rest sent to anvil. */
function mockWallet({ rpc, account, chainId }) {
  let id = 0;
  const forward = async (method, params) => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message);
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }
    return json.result;
  };
  const listeners = {};
  window.ethereum = {
    isMockWallet: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "net_version":
          return String(chainId);
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        default:
          return forward(method, params);
      }
    },
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
    },
  };
}

/** Caption bar: ink, mint rule, large type, bottom of the viewport. Idempotent; survives client navigation. */
function installCaption() {
  if (window.__caption && document.getElementById("__cap")) return;
  const style = document.createElement("style");
  style.textContent = `
    #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(13,13,13,.96);
      border-top:4px solid #75d0cb;padding:26px 96px 30px;display:flex;align-items:center;gap:28px;
      min-height:118px;pointer-events:none;box-shadow:0 -20px 50px rgba(0,0,0,.18)}
    #__cap .tag{flex:none;font:700 15px/1 var(--font-sans,"Inter Tight"),"Inter Tight",system-ui,sans-serif;
      letter-spacing:.16em;text-transform:uppercase;color:#75d0cb;min-width:150px}
    #__cap .txt{font:600 36px/1.22 var(--font-sans,"Inter Tight"),"Inter Tight",system-ui,sans-serif;
      letter-spacing:-.01em;color:#f1f0ed;transition:opacity .28s ease,transform .28s ease}
    #__cap .txt.out{opacity:0;transform:translateY(8px)}
    #__cap.hide{display:none}`;
  document.head.appendChild(style);
  const bar = document.createElement("div");
  bar.id = "__cap";
  bar.innerHTML = '<div class="tag"></div><div class="txt"></div>';
  document.body.appendChild(bar);
  let current = "";
  window.__caption = (text, tag) => {
    const el = document.getElementById("__cap") ?? (document.body.appendChild(bar), bar);
    if (tag !== undefined) el.querySelector(".tag").textContent = tag;
    if (!text) {
      el.classList.add("hide");
      return;
    }
    el.classList.remove("hide");
    if (text === current) return;
    current = text;
    const t = el.querySelector(".txt");
    t.classList.add("out");
    setTimeout(() => {
      t.textContent = text;
      t.classList.remove("out");
    }, 280);
  };
}

async function caption(page, text, tag) {
  await page.evaluate(installCaption);
  await page.evaluate(([t, g]) => window.__caption(t, g), [text, tag]);
}

/** Eased scroll to an absolute y over ms (CSS smooth scrolling off while it runs). */
async function scrollTo(page, y, ms = 1500) {
  await page.evaluate(
    ([y, ms]) =>
      new Promise((res) => {
        const html = document.documentElement;
        const prev = html.style.scrollBehavior;
        html.style.scrollBehavior = "auto";
        const max = html.scrollHeight - innerHeight;
        const target = Math.max(0, Math.min(max, y));
        const start = scrollY;
        const d = target - start;
        const t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          window.scrollTo(0, start + d * ease(t));
          if (t < 1) requestAnimationFrame(step);
          else {
            html.style.scrollBehavior = prev;
            res();
          }
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
}

/** Document y of the first element whose own text is exactly `text` (case-insensitive). */
async function topOf(page, text) {
  return page.evaluate((text) => {
    const want = text.toLowerCase();
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("#__cap")) continue;
      if (el.children.length === 0 && el.textContent.trim().toLowerCase() === want)
        return el.getBoundingClientRect().top + scrollY;
    }
    return null;
  }, text);
}

async function scrollToText(page, text, offset = 150, ms = 1500) {
  const y = await topOf(page, text);
  if (y === null) throw new Error(`text not found on ${page.url()}: ${text}`);
  await scrollTo(page, y - offset, ms);
}

// ------------------------------------------------------------------------------------------ recording

let browser;
async function scene(name, { wallet = false } = {}, body) {
  const dir = join(OUT, "raw", name);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("strike.ack.v1", "1"); // the first-visit eligibility (US-person) notice
    } catch {}
  });
  if (wallet) await ctx.addInitScript(mockWallet, { rpc: RPC, account: A1, chainId: 31337 });
  await ctx.route(`${APP}/__video/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: replayHtml }),
  );
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => (marks[k] = (Date.now() - t0) / 1000);
  page.on("pageerror", (e) => log(`  [${name}] page error: ${e.message.slice(0, 160)}`));
  await body(page, mark);
  mark("end");
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  log(`  ${name}: ${(marks.end - marks.start).toFixed(1)} s`);
  return { name, path, start: marks.start, end: marks.end };
}

async function connect(page) {
  const btn = page.getByRole("banner").getByRole("button", { name: "Connect wallet" });
  await btn.click();
  await btn.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
}

let replayHtml = "";
function buildReplayHtml(data) {
  // Self-hosted fonts from the app build (same origin: the page is served under the app's URL by a route).
  const cssDir = join(APP_DIR, ".next/static/css");
  const faces = [];
  for (const f of readdirSync(cssDir).filter((f) => f.endsWith(".css")))
    for (const m of readFileSync(join(cssDir, f), "utf8").matchAll(/@font-face\{[^}]*\}/g)) faces.push(m[0]);
  return readFileSync(join(ROOT, "video/replay.html"), "utf8")
    .replace("/*__FONTS__*/", [...new Set(faces)].join("\n"))
    .replace("/*__DATA__*/ null", JSON.stringify(data));
}

async function replayScene(name, data) {
  return scene(name, {}, async (page, mark) => {
    replayHtml = buildReplayHtml(data);
    await page.goto(`${APP}/__video/${name}`);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(installCaption);
    if (data.mode === "close") await page.evaluate(() => window.__caption(""));
    else await page.evaluate(([t, g]) => window.__caption(t, g), [data.segments[0].caption, data.tag]);
    await sleep(400);
    mark("start");
    await page.evaluate(() => window.__run());
  });
}

async function recordAll({ flows, CC, CSP }) {
  browser = await chromium.launch();
  const scenes = [];

  // A. Landing → vault list → TSLA covered-call vault
  scenes.push(
    await scene("app-vaults", { wallet: true }, async (page, mark) => {
      await page.goto(`${APP}/`);
      await page.waitForLoadState("load");
      await page.evaluate(() => document.fonts.ready);
      await caption(
        page,
        "Robinhood Chain has tokenized TSLA, NVDA and SPY. Holding them earns nothing.",
        "The problem",
      );
      await sleep(300);
      mark("start");
      await sleep(4200); // hero line draws in
      const tops = await page.evaluate(() =>
        [...document.querySelectorAll("main > section")].map((s) => ({
          top: s.getBoundingClientRect().top + scrollY,
          h: s.getBoundingClientRect().height,
        })),
      );
      const [, manifesto, numbers, how, agentsSec, safety, , closing] = tops;
      await caption(page, "No options on the chain, no yield, and price feeds that are easy to misread.");
      await scrollTo(page, manifesto.top - 60, 1100);
      await scrollTo(page, manifesto.top + manifesto.h - 1080, 4800);
      await caption(page, "Stock tokens sit idle: 0% yield, next to $400M of stablecoins on the same chain.");
      await scrollTo(page, numbers.top + 600, 2200);
      await sleep(3000);
      await caption(page, "Strike: weekly options vaults. Premium is paid to depositors in USDG.", "Strike");
      await scrollTo(page, how.top + 420, 1800);
      await scrollTo(page, how.top + 1300, 3000);
      await caption(page, "An AI agent picks each week's strike. The contract enforces the mandate.");
      await scrollTo(page, agentsSec.top + 450, 1800);
      await sleep(3400);
      await caption(page, "When a price check fails, the contract refuses instead of guessing.");
      await scrollTo(page, safety.top + 60, 1600);
      await sleep(2400);
      await caption(page, "Stock tokens that pay every week, run by agents that cannot break the rules.");
      await scrollTo(page, closing.top + 420, 2000);
      await sleep(2000);

      // Open the app (client-side navigation keeps the recording continuous).
      await caption(
        page,
        "The app, on a local devnet: a TSLA covered-call vault and a cash-secured-put vault.",
        "Vaults",
      );
      await page
        .getByRole("link", { name: /open app/i })
        .first()
        .click();
      await page.locator('a[href^="/app/vault/"]').first().waitFor();
      await page.evaluate(installCaption);
      await sleep(1200);
      await connect(page);
      await sleep(1200);
      await caption(page, "Each vault sells one option series a week and pays the premium in USDG.");
      await scrollTo(page, 560, 1600);
      await sleep(2800);

      await caption(
        page,
        "The TSLA covered-call vault: deposit TSLA, earn weekly premium in USDG.",
        "Deposit",
      );
      await page.locator(`a[href="/app/vault/${CC}"]`).first().click();
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.getByText("Settled epochs").waitFor({ timeout: 20_000 });
      await page.evaluate(installCaption);
      await sleep(1600);
      await page.screenshot({ path: join(OUT, "poster.png") }); // the README poster: vault page at rest
      await sleep(1400);
      await caption(page, "Your position: 25 TSLA deposited, shares, value and premium to claim.");
      await scrollToText(page, "Your position", 150, 1600);
      await sleep(3000);
      await caption(
        page,
        "This week's series: a $407 call, priced at Black-Scholes fair value at the live oracle price.",
      );
      await scrollToText(page, "This week's option", 140, 1800);
      await sleep(3800);
      await caption(
        page,
        "Settlement uses the first Chainlink round after Friday's 16:00 New York close.",
        "Settle",
      );
      await scrollToText(page, "Epoch timeline", 140, 1600);
      await sleep(3000);
      await caption(
        page,
        "The mandate: delta 0.10 to 0.35, at least 95% of fair value, at most 80% sold, 1 to 8 days.",
        "Mandate",
      );
      await scrollToText(page, "Mandate", 140, 1600);
      await sleep(4200);
    }),
  );

  // B. Terminal: the agent proposes, then a reckless proposal is rejected and slashed
  scenes.push(
    await replayScene("terminal-agent", {
      mode: "terminal",
      tag: "The agent",
      segments: [
        {
          clear: true,
          label: "Strike example agent · talks to the Strike MCP server",
          command: "pnpm --filter @strike/agent-example start -- --vault sTSLA-CC",
          caption: "The agent reads the vault through the Strike MCP server.",
          linePause: 230,
          rules: [
            {
              match: "^\\[2\\]",
              caption: "The agent proposes a 0.20-delta call, dry-run first with risk_check.",
            },
            { match: "strikes at \\$", highlight: "hl", hold: 900 },
            {
              match: "^\\[5\\]",
              caption: "proposeByDelta: the contract solves the strike on-chain with the Stylus pricer.",
            },
            {
              match: "^\\s*Accepted",
              highlight: "hl",
              hold: 2600,
              caption: "Inside the mandate: accepted. The series is on sale.",
            },
          ],
          endHold: 1400,
        },
        {
          clear: true,
          label: "Strike example agent · --reckless",
          command: "pnpm --filter @strike/agent-example start -- --reckless --vault sTSLA-CSP",
          caption: "--reckless: the agent forces an at-the-money put, far outside the delta band.",
          linePause: 230,
          rules: [
            { match: "^\\s*Verdict:", highlight: "hlbad", hold: 1200 },
            {
              match: "REJECTED",
              highlight: "hlbad",
              hold: 2600,
              caption: "A reckless proposal is rejected on-chain and the bond is slashed.",
            },
            {
              match: "^\\s*Agent now:",
              highlight: "hlbad",
              hold: 1400,
              caption:
                "The slashed 10 USDG goes to the vault's depositors. The agent never touches vault funds.",
            },
          ],
          endHold: 2200,
        },
      ].map((s, i) => ({ ...s, lines: i === 0 ? flows.propose : flows.reckless })),
    }),
  );

  // C. Agents page: leaderboard and rejection feed
  scenes.push(
    await scene("app-agents", {}, async (page, mark) => {
      await page.goto(`${APP}/app/agents`);
      await page.getByText("Leaderboard").first().waitFor();
      await page
        .getByText(/StrikeWrongSide/)
        .first()
        .waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      await caption(page, "Every agent posts a USDG bond. Three rejections and it is suspended.", "Agents");
      await sleep(600);
      mark("start");
      await sleep(2600);
      await caption(page, "The leaderboard: accepted and rejected proposals, strikes, bond, track record.");
      await scrollToText(page, "Leaderboard", 150, 1600);
      await sleep(4000);
      await caption(
        page,
        "Every rejection is on-chain: the rule it broke, and 10 USDG slashed to depositors.",
      );
      await scrollToText(page, "Rejected proposals", 150, 1600);
      await sleep(2400);
      await scrollTo(page, (await page.evaluate(() => scrollY)) + 420, 2600);
      await sleep(1600);
    }),
  );

  // D. Put vault: buy panel and the "Protect my position" hedge planner
  scenes.push(
    await scene("app-hedge", { wallet: true }, async (page, mark) => {
      await page.goto(`${APP}/app/vault/${CSP}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await connect(page);
      const tabs = page.getByRole("tablist", { name: "How to size the buy" });
      await tabs.waitFor();
      await page
        .getByText(/^[\d,.]+ USDG$/)
        .first()
        .waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      await caption(page, "Buyers: the TSLA cash-secured-put vault sells puts this week.", "Buy");
      await sleep(800);
      mark("start");
      await sleep(2200);
      await caption(page, "The premium is Black-Scholes fair value at the live oracle price, paid in USDG.");
      await scrollToText(page, "This week's option", 140, 1800);
      await sleep(2400);
      const panel = tabs.locator("xpath=../..");
      await scrollTo(
        page,
        (await panel.evaluate((el) => el.getBoundingClientRect().top + scrollY)) - 150,
        1400,
      );
      await caption(page, "Protect my position: size puts against the TSLA you already hold.");
      await tabs.getByRole("tab", { name: "Protect my position" }).click();
      await sleep(900);
      const field = panel.getByLabel(/tokens you hold/);
      await field.click();
      await field.fill("");
      await field.pressSequentially("10", { delay: 220 });
      await panel.getByText(/^10 puts$/).waitFor();
      await sleep(900);
      await caption(page, "Before buying: cost, protected price, worst case at expiry and max loss.");
      await sleep(4200);
      await caption(page, "Buy with USDG: the puts arrive as ERC-1155 options in the wallet.");
      await panel.getByRole("button", { name: /use this amount/i }).click();
      await sleep(900);
      await panel.getByRole("button", { name: /^(Buy|Approve USDG & buy)$/ }).click();
      await page.locator('[data-phase="done"]').first().waitFor({ timeout: 30_000 });
      await sleep(1600);
      await caption(page, "The position: 10 TSLA puts, redeemable in USDG if TSLA settles below the strike.");
      await scrollToText(page, "Your options", 150, 1600);
      await sleep(3600);
    }),
  );

  // E. Terminal: a buyer agent hedges with puts
  scenes.push(
    await replayScene("terminal-buyer", {
      mode: "terminal",
      tag: "Buyer agent",
      segments: [
        {
          clear: true,
          label: "Strike example agent · buyer mode (account #1)",
          command: "pnpm --filter @strike/agent-example start -- --buy --hedge 10 --budget 50",
          caption: "A buyer agent hedges 10 TSLA with puts.",
          linePause: 260,
          rules: [
            {
              match: "^\\[2\\]",
              caption:
                "hedge_plan picks the put series and sizes the hedge: cost, protected price, worst case.",
            },
            { match: "^\\s*Hedge 10 TSLA", highlight: "hl", hold: 2600 },
            {
              match: "^\\s*Bought",
              highlight: "hl",
              hold: 1200,
              caption: "It buys through the MCP server. The premium is the most it can lose.",
            },
          ],
          endHold: 2400,
        },
      ].map((s) => ({ ...s, lines: flows.hedge })),
    }),
  );

  // F. Close
  scenes.push(await replayScene("close", { mode: "close", hold: 5200 }));

  await browser.close();
  return scenes;
}

// ------------------------------------------------------------------------------------------ ffmpeg

function ff(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${r.stderr}`);
}

function assemble(scenes) {
  const seg = join(OUT, "seg");
  rmSync(seg, { recursive: true, force: true });
  mkdirSync(seg, { recursive: true });
  const list = [];
  let total = 0;
  scenes.forEach((s, i) => {
    const dur = Math.max(1, s.end - s.start);
    const out = join(seg, `${String(i).padStart(2, "0")}-${s.name}.mp4`);
    const fo = Math.max(0, dur - 0.35).toFixed(2);
    ff([
      "-ss",
      s.start.toFixed(2),
      "-i",
      s.path,
      "-t",
      dur.toFixed(2),
      "-vf",
      `fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${fo}:d=0.35`,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "20",
      "-tune",
      "stillimage",
      "-an",
      out,
    ]);
    list.push(`file '${out}'`);
    total += dur;
  });
  writeFileSync(join(seg, "list.txt"), list.join("\n"));
  mkdirSync(MEDIA, { recursive: true });
  const mp4 = join(MEDIA, "strike-demo.mp4");
  ff([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(seg, "list.txt"),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  copyFileSync(join(OUT, "poster.png"), join(MEDIA, "strike-demo-poster.png"));
  const pal = join(OUT, "palette.png");
  const gf = "fps=10,scale=960:-1:flags=lanczos";
  ff(["-t", "12", "-i", mp4, "-vf", `${gf},palettegen=max_colors=128:stats_mode=diff`, pal]);
  ff([
    "-t",
    "12",
    "-i",
    mp4,
    "-i",
    pal,
    "-lavfi",
    `${gf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    join(MEDIA, "strike-demo.gif"),
  ]);
  return total;
}

// ------------------------------------------------------------------------------------------ main

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chain = await setupChain();
  await startApp();
  const scenes = await recordAll(chain);
  const total = assemble(scenes);
  for (const f of ["strike-demo.mp4", "strike-demo-poster.png", "strike-demo.gif"]) {
    const p = join(MEDIA, f);
    log(`${p}  ${(statSync(p).size / 1e6).toFixed(2)} MB`);
  }
  log(
    `duration ${total.toFixed(1)} s (${scenes.map((s) => `${s.name} ${(s.end - s.start).toFixed(1)}`).join(", ")})`,
  );
  if (!process.env.KEEP) rmSync(join(OUT, "raw"), { recursive: true, force: true });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    stopChildren();
    if (existsSync(OUT) && !process.env.KEEP) rmSync(join(OUT, "seg"), { recursive: true, force: true });
  });
