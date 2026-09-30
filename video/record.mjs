#!/usr/bin/env node
// Records the Strike demo video (captions burned in, plus an .srt for a voice-over) end to end:
//
//   node video/record.mjs            # from the repo root, Node 22, `pnpm install` done
//
// 1. Builds the app for Robinhood Chain testnet (NEXT_PUBLIC_DEFAULT_CHAIN_ID=46630; this rewrites app/.next)
//    and starts it with `next start`. The app reads the LIVE testnet (vaults, agents, playground) and
//    Robinhood Chain mainnet (monitor); nothing runs against a local chain.
// 2. Reads the real output of the live testnet epoch from docs/testnet-epochs/2026-09-29.md and the real
//    alerts from `pnpm --filter @strike/telegram-bot dry-run` (run now, against the chain).
// 3. Records the scenes with Playwright (1920x1080) with an injected caption bar: the app pages, the
//    Blockscout page of the rejected proposal, and cards rendered by video/replay.html (problem, terminal
//    replay of the live run, Telegram chat, closing card).
// 4. Cuts and joins the scenes with ffmpeg into docs/media/strike-demo.mp4 (30 fps), writes
//    docs/media/strike-demo.srt from the caption timings, a poster PNG and a README GIF (first 12 s).
//
// Env: VIDEO_APP_PORT (default 3321), SKIP_BUILD=1 (reuse app/.next, which must be a testnet build),
// APP_URL=http://... (use an app that is already running: no build, no start), ONLY=hero,vault (record only
// these scenes into video/.out/preview.mp4, for iterating), KEEP=1 (keep video/.out/raw).
// Only processes this script starts are stopped, by PID. Raw recordings live in video/.out (gitignored).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "app");
const OUT = join(ROOT, "video", ".out");
const MEDIA = join(ROOT, "docs", "media");
const require = createRequire(join(APP_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const APP_PORT = Number(process.env.VIDEO_APP_PORT ?? 3321);
const APP = process.env.APP_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${APP_PORT}`;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const EPOCH_LOG = join(ROOT, "docs/testnet-epochs/2026-09-29.md");
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const REJECT_TX = "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0";
const CC_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"; // sTSLA-CC on 46630
const REPO = "github.com/Prashant-thakur77/Strike";

const HOME = process.env.HOME;
const ENV = { ...process.env, PATH: `${HOME}/.foundry/bin:${process.env.PATH}` };

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

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

// ------------------------------------------------------------------------------------------ real data

/** The live run's agent output, split by the log's "== ..." headers: { seller, reckless, buyer }. */
function epochLog() {
  const md = readFileSync(EPOCH_LOG, "utf8");
  const block = md.match(/```\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error(`no output block in ${EPOCH_LOG}`);
  const parts = {};
  let cur = null;
  for (const line of block.split("\n")) {
    const h = line.match(/^== (\w+)/);
    if (h) {
      cur = h[1];
      parts[cur] = [];
    } else if (cur) parts[cur].push(line);
  }
  for (const k of Object.keys(parts)) while (parts[k].at(-1) === "") parts[k].pop();
  for (const k of ["seller", "reckless", "buyer"]) if (!parts[k]?.length) throw new Error(`no "${k}" output`);
  return parts;
}

/** The Telegram bot's real alerts for the live chain (and its /subscribe reply), from its dry run. */
async function botAlerts() {
  // The public RPC drops a request now and then: retry the dry run a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      return botAlertsOnce();
    } catch (e) {
      if (attempt >= 4) throw e;
      log(`  dry run failed (attempt ${attempt}), retrying`);
      await sleep(5000 * attempt);
    }
  }
}
function botAlertsOnce() {
  const r = spawnSync(
    "corepack",
    ["pnpm", "--silent", "--filter", "@strike/telegram-bot", "dry-run", "/subscribe"],
    {
      cwd: ROOT,
      env: { ...ENV, FORCE_COLOR: "0" },
      encoding: "utf8",
      maxBuffer: 16 << 20,
      timeout: 180_000,
    },
  );
  const out = stripAnsi(r.stdout ?? "");
  if (r.status !== 0) throw new Error(`telegram dry-run failed:\n${out}\n${r.stderr}`);
  writeFileSync(join(OUT, "telegram-dry-run.txt"), out);
  const alerts = {};
  for (const m of out.matchAll(/^--- (\w+), block (\d+)\n([\s\S]*?)\n\n/gm))
    (alerts[m[1]] ??= []).push({ block: m[2], text: m[3] });
  const subscribe = out.match(/^>>> \/subscribe\n(.+)$/m)?.[1];
  for (const k of ["ProposalRejected", "OptionsBought"])
    if (!alerts[k]) throw new Error(`the dry run printed no ${k} alert:\n${out}`);
  if (!subscribe) throw new Error("the dry run printed no /subscribe reply");
  return { alerts, subscribe };
}

// ------------------------------------------------------------------------------------------ app

async function startApp() {
  if (process.env.APP_URL) {
    await waitFor(async () => (await fetch(APP)).ok, `the app at ${APP}`);
    return;
  }
  if (!process.env.SKIP_BUILD) {
    log("build the app for Robinhood Chain testnet (app/.next)");
    const env = { ...ENV, NEXT_PUBLIC_DEFAULT_CHAIN_ID: "46630" };
    delete env.NEXT_PUBLIC_LOCAL_RPC;
    // Another build or dev server holding app/.next makes `next build` fail: wait and retry.
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync("corepack", ["pnpm", "--filter", "@strike/app", "build"], {
        cwd: ROOT,
        env,
        encoding: "utf8",
        maxBuffer: 64 << 20,
      });
      if (r.status === 0) break;
      if (attempt >= 5) throw new Error(`app build failed:\n${r.stdout}\n${r.stderr}`);
      log(`  build failed (attempt ${attempt}), retrying in 30 s`);
      await sleep(30_000);
    }
  }
  if (!(await portFree(APP_PORT))) throw new Error(`port ${APP_PORT} is busy (set VIDEO_APP_PORT)`);
  const next = startChild(join(APP_DIR, "node_modules/.bin/next"), ["start", "-p", String(APP_PORT)], {
    cwd: APP_DIR,
  });
  log(`next start pid ${next.pid} on ${APP}`);
  await waitFor(async () => (await fetch(APP)).ok, "the app");
}

// ------------------------------------------------------------------------------------------ page helpers

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
      current = "";
      window.__capEvent?.("");
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
      window.__capEvent?.(text); // caption timings for the .srt
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

/** Scroll to the heading whose accessible name matches `name` (a RegExp). */
async function scrollToHeading(page, name, offset = 150, ms = 1500) {
  await scrollToEl(page.getByRole("heading", { name }).first(), offset, ms);
}

async function scrollToEl(locator, offset = 150, ms = 1500) {
  const y = await locator.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await scrollTo(locator.page(), y - offset, ms);
}

/** Every number a caption states must be on the page: fail the run instead of recording a wrong caption. */
async function expectText(page, text, timeout = 30_000) {
  await page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ timeout })
    .catch(() => {
      throw new Error(`expected "${text}" on ${page.url()}`);
    });
}

/** The app's self-hosted fonts as inline data: URIs, for pages on another origin (Blockscout). */
function inlineFontFaces() {
  const cssDir = join(APP_DIR, ".next/static/css");
  const faces = new Set();
  for (const f of readdirSync(cssDir).filter((f) => f.endsWith(".css")))
    for (const m of readFileSync(join(cssDir, f), "utf8").matchAll(/@font-face\{[^}]*\}/g)) faces.add(m[0]);
  return [...faces]
    .filter((f) => /Inter Tight;|Inter Tight"/.test(f) && /url\(/.test(f))
    .map((f) =>
      f.replace(/url\((\/_next\/static\/media\/[^)]+)\)/, (_, p) => {
        const b64 = readFileSync(join(APP_DIR, ".next", p.replace("/_next/", ""))).toString("base64");
        return `url(data:font/woff2;base64,${b64})`;
      }),
    )
    .join("\n");
}

// ------------------------------------------------------------------------------------------ recording

let browser;
async function scene(name, opts, body) {
  const dir = join(OUT, "raw", name);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    timezoneId: "UTC",
    bypassCSP: Boolean(opts.external),
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("strike.ack.v1", "1"); // the first-visit eligibility (US-person) notice
    } catch {}
  });
  await ctx.route(`${APP}/__video/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: replayHtml }),
  );
  let t0 = Date.now();
  const captions = [];
  await ctx.exposeBinding("__capEvent", (_src, text) => captions.push({ t: (Date.now() - t0) / 1000, text }));
  const page = await ctx.newPage();
  t0 = Date.now();
  const marks = {};
  const mark = (k) => (marks[k] = (Date.now() - t0) / 1000);
  page.on("pageerror", (e) => log(`  [${name}] page error: ${e.message.slice(0, 160)}`));
  await body(page, mark);
  mark("end");
  const video = page.video();
  mark("close");
  await ctx.close();
  const path = await video.path();
  // The recording starts a little after t0 and ends when the context closes: shift the marks onto the
  // video's own timeline, so the cut starts where the scene does and the .srt stays in sync.
  const shift = Math.max(0, marks.close - videoDuration(path));
  log(`  ${name}: ${(marks.end - marks.start).toFixed(1)} s (video starts ${shift.toFixed(2)} s late)`);
  const captionsOnVideo = captions.map((c) => ({ ...c, t: c.t - shift }));
  return {
    name,
    path,
    start: Math.max(0, marks.start - shift),
    end: marks.end - shift,
    captions: captionsOnVideo,
    srt: opts.srt,
  };
}

/** Duration of a recording in seconds, by decoding it (Playwright's webm has no duration in its header). */
function videoDuration(path) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-f", "null", "-"], { encoding: "utf8" });
  const times = [...(r.stderr ?? "").matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
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

async function replayScene(name, data, opts = {}) {
  return scene(name, opts, async (page, mark) => {
    replayHtml = buildReplayHtml(data);
    await page.goto(`${APP}/__video/${name}`);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(installCaption);
    if (data.mode === "close") await page.evaluate(() => window.__caption(""));
    else if (data.first) await page.evaluate(([t, g]) => window.__caption(t, g), [data.first, data.tag]);
    await sleep(500);
    mark("start");
    await page.evaluate(() => window.__run());
  });
}

const want = (name) => !ONLY || ONLY.has(name);

async function recordAll({ epoch, bot }) {
  browser = await chromium.launch();
  const scenes = [];
  const add = async (name, fn) => {
    if (want(name)) scenes.push(await fn(name));
  };

  // 1. Hero, then one smooth scroll to the live activity band.
  await add("hero", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/`);
      await page.waitForLoadState("load");
      await page.evaluate(() => document.fonts.ready);
      // The live band reads the chain on load: wait for its rows before starting.
      await page.locator("#live").getByText("DeltaOutOfBand").first().waitFor({ timeout: 40_000 });
      await caption(page, "Strike: weekly options vaults for Robinhood Chain stock tokens.", "Strike");
      await sleep(600);
      mark("start");
      await sleep(3000);
      const live = await page.locator("#live").evaluate((el) => el.getBoundingClientRect().top + scrollY);
      await caption(page, "Live on Robinhood Chain testnet: real events, read from the chain.", "Live");
      await scrollTo(page, live - 70, 2800); // section head clear of the transparent nav
      await sleep(2300);
    }),
  );

  // 2. The problem.
  await add("problem", (name) =>
    replayScene(name, {
      mode: "problem",
      tag: "The problem",
      first: "Stock tokens on Robinhood Chain earn nothing on their own.",
      rows: [
        {
          word: "Idle tokens.",
          caption: "Stock tokens on Robinhood Chain earn nothing on their own.",
          tag: "The problem",
          hold: 3900,
        },
        {
          word: "Options, run by hand.",
          caption: "Options exist on the chain, but people run them by hand.",
          hold: 3900,
        },
        {
          word: "Agent + <em>contract.</em>",
          caption: "Strike: an AI agent runs the vault, and the contract enforces the rules.",
          tag: "Strike",
          hold: 4200,
        },
      ],
    }),
  );

  // 3. Mandate playground: an honest proposal is accepted, a reckless one rejected with the slash.
  await add("playground", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/app/playground`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.locator('[data-testid="verdict"][data-kind="accepted"]').waitFor({ timeout: 40_000 });
      await page.evaluate(() => document.fonts.ready);
      await caption(
        page,
        "The mandate playground: ask the deployed contract about a proposal. No wallet.",
        "Playground",
      );
      await sleep(600);
      mark("start");
      await sleep(3000);
      const presets = page.getByRole("group", { name: "Preset proposals" });
      await scrollToEl(presets, 180, 1500); // below the sticky nav and page index
      await sleep(500);
      await caption(page, "Honest agent: a 0.20-delta call. The contract answers: Accepted.");
      await presets.getByRole("button", { name: /0\.20-delta call/ }).click();
      await page.locator('[data-testid="verdict"][data-kind="accepted"]').waitFor({ timeout: 30_000 });
      await sleep(5200);
      await caption(page, "Reckless agent: an at-the-money put. Rejected: DeltaOutOfBand.");
      await presets.getByRole("button", { name: /At-the-money put/ }).click();
      await page.locator('[data-testid="verdict"][data-kind="rejected"]').waitFor({ timeout: 30_000 });
      await expectText(page, "DeltaOutOfBand");
      await sleep(4200);
      await expectText(page, "slashed by 10 USDG");
      await caption(page, "The slash: 10 USDG of the agent's bond, paid to the vault's depositors.");
      await scrollToEl(page.getByTestId("verdict"), 170, 1400);
      await sleep(4600);
      await caption(page, "Each verdict is a read-only call to the deployed EpochManager, not a simulation.");
      await scrollToHeading(page, /What this proves/, 110, 1800);
      await sleep(4200);
    }),
  );

  // 4. The real epoch on Robinhood Chain testnet: terminal replay of the live run, and the rejection on
  //    Blockscout.
  const wintitle = "~/strike · Robinhood Chain testnet (46630) · live run, 2026-09-29 17:08 UTC";
  const sublabel = "docs/testnet-epochs/2026-09-29.md";
  await add("epoch", (name) =>
    replayScene(name, {
      mode: "terminal",
      tag: "Live epoch",
      first: "A real epoch on Robinhood Chain testnet, 29 Sep 2026. First, the seller agent.",
      wintitle,
      sublabel,
      segments: [
        {
          clear: true,
          label: "Seller agent · 0.20-delta covered call",
          command: "pnpm --filter @strike/agent-example start -- --vault sTSLA-CC",
          linePause: 55,
          stepPause: 220,
          typeSpeed: 0.6,
          rules: [
            {
              match: "^\\s*\\[3\\]",
              caption: "The seller agent targets a 0.20-delta call on the TSLA covered-call vault.",
            },
            { match: "strikes at \\$", highlight: "hl", hold: 1300 },
            {
              match: "^\\s*\\[5\\]",
              caption: "proposeByDelta: the contract solves the strike on-chain.",
              hold: 1500,
            },
            { match: "^\\s*Opened the epoch", highlight: "hl", hold: 300 },
            {
              match: "^\\s*Accepted",
              highlight: "hl",
              hold: 1700,
              caption: "Accepted at a $369.86 strike. The series goes on sale.",
            },
            { match: "^\\s*tx 0x", highlight: "hl", hold: 700 },
          ],
          endHold: 500,
          lines: epoch.seller,
        },
        {
          clear: true,
          label: "Reckless agent · at-the-money put, forced",
          command: "pnpm --filter @strike/agent-example start -- --reckless --vault sTSLA-CSP",
          caption: "--reckless: the agent forces an at-the-money put, outside the 0.10 to 0.35 delta band.",
          linePause: 55,
          stepPause: 220,
          typeSpeed: 0.6,
          rules: [
            { match: "^\\s*Verdict:", highlight: "hlbad", hold: 900 },
            {
              match: "REJECTED",
              highlight: "hlbad",
              hold: 1900,
              caption: "Rejected on-chain: DeltaOutOfBand. 10 USDG of the agent's bond is slashed.",
            },
            {
              match: "^\\s*Agent now:",
              highlight: "hlbad",
              hold: 1300,
              caption: "The agent's bond drops from 60 to 50 USDG: 1 of 3 strikes.",
            },
          ],
          endHold: 500,
          lines: epoch.reckless,
        },
      ],
    }),
  );

  await add("blockscout", (name) =>
    scene(name, { external: true }, async (page, mark) => {
      await page.goto(`${EXPLORER}/tx/${REJECT_TX}`, { waitUntil: "domcontentloaded" });
      await page.getByText("proposeSeries").first().waitFor({ timeout: 60_000 });
      await page.getByText("Tokens transferred").first().waitFor({ timeout: 30_000 });
      await sleep(2500); // let the page settle (icons, confirmations)
      await page.addStyleTag({ content: inlineFontFaces() });
      await page.evaluate(() => document.fonts.ready);
      await caption(
        page,
        "The rejection on Blockscout: proposeSeries, and 10 USDG moved out of the agent's bond.",
        "Blockscout",
      );
      await sleep(500);
      mark("start");
      await sleep(4300);
    }),
  );

  await add("buyer", (name) =>
    replayScene(name, {
      mode: "terminal",
      tag: "Live epoch",
      first: "A buyer agent spends up to 15 USDG on the live series.",
      wintitle,
      sublabel,
      segments: [
        {
          clear: true,
          label: "Buyer agent · calls within a 15 USDG budget",
          command: "pnpm --filter @strike/agent-example start -- --buy --budget 15 --vault sTSLA-CC",
          linePause: 70,
          stepPause: 260,
          typeSpeed: 0.6,
          rules: [
            { match: "^\\s*One option costs", highlight: "hl", hold: 600 },
            {
              match: "^\\s*Bought",
              highlight: "hl",
              hold: 1500,
              caption: "It bought 4 calls for 10.005944 USDG. The premium is the most it can lose.",
            },
            { match: "^\\s*Max loss", highlight: "hl", hold: 400 },
          ],
          endHold: 1400,
          lines: epoch.buyer,
        },
      ],
    }),
  );

  // 5. The vault page, live on chain 46630.
  await add("vault", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/app/vault/${CC_VAULT}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.getByText("How the buy price is set").first().waitFor({ timeout: 40_000 });
      await expectText(page, "$369.86");
      await expectText(page, "Breakeven $372.36");
      await expectText(page, "4 of 4 sold");
      await expectText(page, "5 TSLA");
      await page.evaluate(() => document.fonts.ready);
      await caption(page, "The TSLA covered-call vault, live on testnet. It holds 5 testnet TSLA.", "Vault");
      await sleep(800);
      mark("start");
      await sleep(3400);
      await caption(page, "This week's series: a TSLA call at $369.86, expiring Fri Oct 2. All 4 sold.");
      await scrollToHeading(page, /This week's option/, 120, 1600);
      await sleep(4600);
      await caption(
        page,
        "The buy price: spot plus 0.5% against the buyer, at Black-Scholes fair value, never below intrinsic.",
      );
      await scrollToHeading(page, /How the buy price is set/, 380, 1300);
      await sleep(5200);
      await caption(
        page,
        "Buyer profits above $372.36. At or below $369.86, depositors keep the full premium.",
      );
      await scrollToHeading(page, /Result at expiry/, 110, 1400);
      await sleep(5200);
      await caption(page, "Epoch 1 opened Tue Sep 29 and settles at Friday's NYSE close.");
      await scrollToHeading(page, /Epoch timeline/, 120, 1400);
      await sleep(3000);
    }),
  );

  // 6. Agents: the ERC-8004 identity, bond, strikes and the rejection feed.
  await add("agents", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/app/agents`);
      await page.getByText("Leaderboard").first().waitFor();
      await page
        .getByText(/ERC-8004 #114/)
        .first()
        .waitFor({ timeout: 40_000 });
      await page.getByText("DeltaOutOfBand").first().waitFor({ timeout: 40_000 });
      await expectText(page, "50 USDG");
      await page.evaluate(() => document.fonts.ready);
      await caption(page, "Every agent posts a USDG bond. A rejected proposal costs 10 USDG.", "Agents");
      await sleep(600);
      mark("start");
      await sleep(2600);
      await caption(
        page,
        "Agent #1: ERC-8004 identity #114, 1 accepted, 1 rejected, 1 strike, 50 USDG bond.",
      );
      await scrollToHeading(page, /Leaderboard/, 150, 1500);
      await sleep(4200);
      await caption(page, "The rejection feed: DeltaOutOfBand on the TSLA put vault, 10 USDG slashed.");
      await scrollToHeading(page, /Rejected proposals/, 380, 1000);
      await sleep(3000);
    }),
  );

  // 7. Telegram: the bot's real alerts for the live chain, in a chat mock.
  const rejected = bot.alerts.ProposalRejected.at(-1).text;
  const bought = bot.alerts.OptionsBought.at(-1).text;
  const boughtHead = bought.split("\n")[0]; // "sTSLA-CC: 4 TSLA calls bought for 10.005944 USDG"
  await add("telegram", (name) =>
    replayScene(name, {
      mode: "telegram",
      tag: "Alerts",
      first: "The Telegram bot reads the chain's logs and posts an alert for each event.",
      botName: "Strike Alerts",
      note: "Messages are the bot's real alerts for Robinhood Chain testnet, printed by <code>pnpm --filter @strike/telegram-bot dry-run</code>.",
      messages: [
        { from: "me", text: "/subscribe", before: 400, hold: 700 },
        { from: "bot", text: bot.subscribe, hold: 1500 },
        {
          from: "bot",
          text: rejected,
          highlight: true,
          caption: "A rejected proposal: the rule it broke, the 10 USDG slash and the transaction.",
          hold: 4400,
        },
        {
          from: "bot",
          text: bought,
          highlight: true,
          caption: `A sale: ${boughtHead.replace(/^[^:]+: /, "")}.`,
          hold: 4000,
        },
      ],
    }),
  );

  // 8. Stock-token safety monitor, live on Robinhood Chain mainnet.
  await add("monitor", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/app/monitor`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.getByText("NVIDIA").first().waitFor({ timeout: 40_000 });
      await page
        .getByText(/All five checks pass/)
        .first()
        .waitFor({ timeout: 40_000 });
      // NVDA's live ERC-8056 multiplier, read from its row.
      const mult = await page.evaluate(() => {
        const leaf = (root, test) =>
          [...root.querySelectorAll("*")].find(
            (el) => el.children.length === 0 && test(el.textContent.trim()),
          );
        const isMult = (t) => /^1\.\d{6,}$/.test(t); // e.g. "1.000775159"
        // The smallest ancestor of NVDA's name that holds a multiplier cell: its row, and only its row.
        let row = leaf(document.body, (t) => t === "NVIDIA");
        while (row && !leaf(row, isMult)) row = row.parentElement;
        if (!row || leaf(row, (t) => t === "Tesla" || t === "Amazon")) return null;
        return leaf(row, isMult).textContent.trim();
      });
      if (!mult) throw new Error("NVDA multiplier not found on /app/monitor");
      await page.evaluate(() => document.fonts.ready);
      await caption(
        page,
        "The safety monitor: every Robinhood Chain stock token, read live from mainnet.",
        "Monitor",
      );
      await sleep(600);
      mark("start");
      await sleep(3000);
      await caption(page, "Each token gets the verdict the contracts would give: five checks, or no price.");
      await scrollToText(page, "Tesla", 360, 1400);
      await sleep(2600);
      await caption(page, `NVDA's multiplier is ${mult}: already in the price, so Strike never applies it.`);
      await scrollToText(page, "NVIDIA", 330, 1000);
      await sleep(4200);
    }),
  );

  // 9. Proof: verified contracts, tests, formal proofs, internal review.
  await add("proof", (name) =>
    scene(name, {}, async (page, mark) => {
      await page.goto(`${APP}/app/proof`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page
        .getByText(/Verified on Blockscout/)
        .first()
        .waitFor({ timeout: 40_000 });
      await expectText(page, "9 properties proven with Halmos");
      await expectText(page, "11 findings, all fixed");
      await page.evaluate(() => document.fonts.ready);
      await caption(page, "The proof page: every claim next to its evidence.", "Proof");
      await sleep(600);
      mark("start");
      await sleep(1000);
      await caption(page, "Every deployed contract is verified on Blockscout.");
      await scrollToHeading(page, /^Live on Robinhood Chain testnet$/, 170, 1200);
      await sleep(2000);
      await caption(page, "432 Foundry tests, plus Rust, TypeScript, bot and subgraph tests.");
      await scrollToHeading(page, /^Tests$/, 170, 1200);
      await sleep(2000);
      await caption(page, "9 properties proven with Halmos, for every input in range.");
      await scrollToHeading(page, /^Formal properties$/, 300, 1200);
      await sleep(2000);
      await caption(page, "An internal review: 11 findings, all fixed, with regression tests.");
      await scrollToHeading(page, /^Internal review/, 170, 1200);
      await sleep(2600);
    }),
  );

  // 10. Closing card (numbers as in the README).
  await add("close", (name) =>
    replayScene(
      name,
      {
        mode: "close",
        hold: 5200,
        items: [
          { big: "500+", small: "tests: 432 Foundry, plus TypeScript and bot" },
          { big: "9", small: "invariants, fuzzed in CI" },
          { big: "9", small: "formal proofs (Halmos)" },
          { big: "Fork", small: "tests on Robinhood Chain mainnet" },
          { big: "Rust = Solidity", small: "the Stylus pricer matches the Solidity one" },
        ],
        link: `<span>→</span> ${REPO}`,
      },
      {
        srt: [
          "Strike: options on Robinhood Chain, run by agents that cannot break the rules.",
          `500+ tests, 9 invariants, 9 formal proofs, fork tests on mainnet. ${REPO}`,
        ],
      },
    ),
  );

  // Poster: the vault page at this week's series, without the caption bar (a separate, unrecorded page).
  if (want("poster")) {
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      colorScheme: "light",
      timezoneId: "UTC",
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("strike.ack.v1", "1");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${APP}/app/vault/${CC_VAULT}`);
    await page.getByText("How the buy price is set").first().waitFor({ timeout: 40_000 });
    await expectText(page, "Breakeven $372.36");
    await page.evaluate(() => document.fonts.ready);
    await scrollToHeading(page, /This week's option/, 120, 10);
    await sleep(1500);
    await page.screenshot({ path: join(OUT, "poster.png") });
    await ctx.close();
  }

  await browser.close();
  return scenes;
}

// ------------------------------------------------------------------------------------------ ffmpeg

function ff(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${r.stderr}`);
}

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** Caption cues on the final timeline: each caption lasts until the next one (or its scene's end). */
function cues(scenes) {
  const out = [];
  let offset = 0;
  for (const s of scenes) {
    const dur = Math.max(1, s.end - s.start);
    if (Array.isArray(s.srt)) {
      const step = dur / s.srt.length;
      s.srt.forEach((text, i) => out.push({ from: offset + i * step, to: offset + (i + 1) * step, text }));
    } else {
      // The caption visible when the cut starts, then every change inside the cut.
      const ev = s.captions.map((c) => ({ t: c.t - s.start, text: c.text }));
      const before = ev.filter((c) => c.t <= 0).at(-1);
      const inside = ev.filter((c) => c.t > 0 && c.t < dur - 0.3);
      const list = [...(before ? [{ ...before, t: 0 }] : []), ...inside];
      list.forEach((c, i) => {
        if (!c.text) return;
        const to = i + 1 < list.length ? list[i + 1].t : dur;
        out.push({ from: offset + c.t, to: offset + to, text: c.text });
      });
    }
    offset += dur;
  }
  // Merge a caption that carries over a cut.
  const merged = [];
  for (const c of out) {
    const last = merged.at(-1);
    if (last && last.text === c.text && Math.abs(last.to - c.from) < 0.05) last.to = c.to;
    else merged.push({ ...c });
  }
  return merged;
}

function assemble(scenes, preview) {
  const seg = join(OUT, "seg");
  rmSync(seg, { recursive: true, force: true });
  mkdirSync(seg, { recursive: true });
  const list = [];
  let total = 0;
  scenes.forEach((s, i) => {
    const dur = Math.max(1, s.end - s.start);
    const out = join(seg, `${String(i).padStart(2, "0")}-${s.name}.mp4`);
    const fo = Math.max(0, dur - 0.3).toFixed(2);
    ff([
      "-ss",
      s.start.toFixed(2),
      "-i",
      s.path,
      "-t",
      dur.toFixed(2),
      "-vf",
      `fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${fo}:d=0.3`,
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "21",
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
  const mp4 = preview ? join(OUT, "preview.mp4") : join(MEDIA, "strike-demo.mp4");
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
  const srt = cues(scenes)
    .map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`)
    .join("\n");
  writeFileSync(preview ? join(OUT, "preview.srt") : join(MEDIA, "strike-demo.srt"), srt);
  if (preview) return { total, mp4 };
  execFileSync("cp", [join(OUT, "poster.png"), join(MEDIA, "strike-demo-poster.png")]);
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
  rmSync(pal, { force: true });
  return { total, mp4 };
}

// ------------------------------------------------------------------------------------------ main

async function main() {
  mkdirSync(OUT, { recursive: true });
  const epoch = epochLog();
  log("telegram bot dry run (live chain)");
  const bot = await botAlerts();
  await startApp();
  const scenes = await recordAll({ epoch, bot });
  const { total, mp4 } = assemble(scenes, Boolean(ONLY));
  const files = ONLY
    ? [mp4, join(OUT, "preview.srt")]
    : ["strike-demo.mp4", "strike-demo.srt", "strike-demo-poster.png", "strike-demo.gif"].map((f) =>
        join(MEDIA, f),
      );
  for (const p of files) log(`${p}  ${(statSync(p).size / 1e6).toFixed(2)} MB`);
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
