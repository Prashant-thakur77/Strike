import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type Browser, type Page } from "@playwright/test";
import { acknowledge, settle } from "./helpers";

// UI audit: every page, in every state worth looking at, at five widths. For each it saves a full-page screenshot
// and a JSON report of DOM checks (horizontal overflow, clipped or spilling text, elements past the right edge,
// overlapping text, broken images, console errors, failed requests, layout shift).
//
// Opt-in, since it takes a while and reads live chains:
//   UI_AUDIT=1 npx playwright test e2e/ui-audit.spec.ts --project=desktop --workers=3
// Against production: add AUDIT_BASE=https://strike-options.vercel.app. Output: ~/.cache/strike-ui-audit/<label>/
// (AUDIT_LABEL, default "local" or "live"); summarise with `node scripts/ui-audit-summary.mjs <label>`.

const BASE = process.env.AUDIT_BASE ?? "";
const LABEL = process.env.AUDIT_LABEL ?? (BASE ? "live" : "local");
const OUT = join(homedir(), ".cache", "strike-ui-audit", LABEL);
const ONLY = process.env.AUDIT_ONLY ? new RegExp(process.env.AUDIT_ONLY) : null;

const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
  { w: 360, h: 740 },
] as const;

/** Vault addresses per chain, read from the SDK's deployment map (the spec can't import the ESM-only SDK). */
function vaults(chainId: number): { name: string; address: string }[] {
  const src = readFileSync(join(__dirname, "..", "..", "sdk", "src", "deployments.generated.ts"), "utf8");
  const start = src.indexOf(`"${chainId}": {`);
  if (start < 0) return [];
  const block = src.slice(start, src.indexOf('"vaults": {', start) + 400);
  const vaultsAt = block.indexOf('"vaults": {');
  const body = block.slice(vaultsAt, block.indexOf("}", vaultsAt));
  return [...body.matchAll(/"(TSLA_[a-z_]+|[A-Z]+_[a-z_]+)": "(0x[0-9a-fA-F]{40})"/g)].map((m) => ({
    name: m[1].toLowerCase().replace(/_/g, "-"),
    address: m[2],
  }));
}

interface State {
  name: string;
  path: string;
  /** Waits for the page's data, then puts it in the state to capture. */
  prepare?: (page: Page) => Promise<void>;
  /** Only these widths (default: all). */
  widths?: number[];
  /** Also capture viewport-sized frames top to bottom (pages with pinned, scroll-driven sections). */
  frames?: boolean;
}

const h1 = async (page: Page) => {
  await page
    .getByRole("heading", { level: 1 })
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
};

/** Wait until skeletons are gone (or give up after `ms`). */
async function loaded(page: Page, ms = 25_000) {
  await h1(page);
  await page
    .waitForFunction(() => document.querySelectorAll(".skeleton").length === 0, null, { timeout: ms })
    .catch(() => {});
  await settle(page, 1500);
}

const preset = (id: string) => async (page: Page) => {
  await loaded(page);
  const verdict = page.getByTestId("verdict");
  await page.locator(`[data-preset="${id}"]`).click({ timeout: 45_000 });
  await page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="verdict"]');
        return v && !v.hasAttribute("data-busy") && v.getAttribute("data-kind") !== "pending";
      },
      null,
      { timeout: 45_000 },
    )
    .catch(() => {});
  await verdict.scrollIntoViewIfNeeded().catch(() => {});
  await settle(page, 800);
};

const backtest =
  (ticker: string, vault: string, vrp: string, tables = false) =>
  async (page: Page) => {
    await loaded(page);
    const c = page.getByRole("region", { name: "Backtest settings" });
    await c.getByRole("button", { name: ticker, exact: true }).click();
    await c.getByRole("button", { name: vault, exact: true }).click();
    await c.getByRole("button", { name: `Realised volatility × ${vrp}` }).click();
    if (tables) {
      const toTable = page.getByRole("button", { name: "Show as table" });
      while ((await toTable.count()) > 0) await toTable.first().click();
    }
    await settle(page, 800);
  };

const STATES: State[] = [
  { name: "landing", path: "/", prepare: async (p) => settle(p, 2500), frames: true },
  { name: "not-found", path: "/no-such-page" },
  { name: "waitlist", path: "/waitlist", prepare: (p) => settle(p, 1200) },
  { name: "vaults-46630", path: "/app?chain=46630", prepare: loaded },
  { name: "vaults-421614", path: "/app?chain=421614", prepare: loaded },
  { name: "vaults-4663", path: "/app?chain=4663", prepare: loaded },
  ...[46630, 421614].flatMap((chain) =>
    vaults(chain).map((v) => ({
      name: `vault-${chain}-${v.name}`,
      path: `/app/vault/${v.address}?chain=${chain}`,
      prepare: async (page: Page) => {
        await loaded(page, 40_000);
        await page
          .getByText("Settled epochs")
          .first()
          .waitFor({ timeout: 20_000 })
          .catch(() => {});
        await settle(page, 1500);
      },
    })),
  ),
  { name: "playground", path: "/app/playground", prepare: loaded },
  ...["honest", "reckless", "big", "cheap"].map((id) => ({
    name: `playground-${id}`,
    path: "/app/playground",
    prepare: preset(id),
  })),
  {
    name: "playground-invalid",
    path: "/app/playground",
    prepare: async (page: Page) => {
      await loaded(page);
      await page.getByRole("button", { name: /Explicit strike/ }).click();
      await page.getByLabel(/Premium factor/).fill("");
      await settle(page, 800);
    },
  },
  { name: "backtest", path: "/app/backtest", prepare: loaded },
  { name: "backtest-tables", path: "/app/backtest", prepare: backtest("TSLA", "Covered call", "1.15", true) },
  ...[
    ["NVDA", "Cash-secured put", "1.00"],
    ["SPY", "Covered call", "1.00"],
    ["AMZN", "Cash-secured put", "1.15"],
  ].map(([t, v, r]) => ({
    name: `backtest-${t.toLowerCase()}-${v.startsWith("Cash") ? "put" : "call"}-${r}`,
    path: "/app/backtest",
    prepare: backtest(t, v, r),
    widths: [1440, 390],
  })),
  { name: "agents-46630", path: "/app/agents?chain=46630", prepare: loaded },
  { name: "agents-421614", path: "/app/agents?chain=421614", prepare: loaded },
  { name: "monitor-46630", path: "/app/monitor?chain=46630", prepare: (p) => loaded(p, 40_000) },
  { name: "monitor-421614", path: "/app/monitor?chain=421614", prepare: (p) => loaded(p, 40_000) },
  { name: "proof", path: "/app/proof", prepare: (p) => loaded(p, 40_000) },
  { name: "faucet-46630", path: "/app/faucet?chain=46630", prepare: loaded },
  { name: "faucet-421614", path: "/app/faucet?chain=421614", prepare: loaded },
  { name: "glossary", path: "/app/glossary", prepare: loaded },
  {
    name: "menu-open",
    path: "/app/playground",
    widths: [768, 390, 360],
    prepare: async (page: Page) => {
      await loaded(page);
      await page.getByRole("button", { name: "Menu" }).click();
      await settle(page, 1200);
    },
  },
  {
    name: "term-open",
    path: "/app?chain=46630",
    prepare: async (page: Page) => {
      await loaded(page);
      await page.locator("[data-term]").first().focus();
      await settle(page, 400);
    },
  },
  { name: "skill-md", path: "/skill.md" },
  { name: "llms-txt", path: "/llms.txt" },
];

/** The DOM checks, run in the page. */
function domChecks() {
  const vw = document.documentElement.clientWidth;
  const out: Record<string, unknown[]> = {
    clipped: [],
    spill: [],
    pastRight: [],
    overlap: [],
    brokenImages: [],
    ellipsisNoTitle: [],
    brokenWords: [],
  };
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const hiddenChain = (el: Element | null): boolean => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return true;
      if (e.getAttribute("aria-hidden") === "true" && e.closest("svg")) return true;
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return true;
      if (e.tagName === "DETAILS" && !(e as HTMLDetailsElement).open) {
        // content of a closed <details> other than its summary
        return true;
      }
    }
    return false;
  };
  const sel = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && parts.length < 4 && e !== document.body; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += `#${e.id}`;
      const cls = [...e.classList].slice(0, 2).join(".");
      if (cls) s += `.${cls}`;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const text = (el: Element) =>
    ((el as HTMLElement).innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ");
  const all = [...document.body.querySelectorAll("*")];

  // Ancestors that clip horizontally (scroll containers and overflow hidden), so their contents don't count as
  // past the right edge.
  const clipsX = (e: Element) => {
    const o = getComputedStyle(e).overflowX;
    return o !== "visible";
  };

  for (const el of all) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const t = text(el);
    const hx = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const hy = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());

    if ((hx || hy) && t && !hiddenChain(el)) {
      const overX = hx && el.scrollWidth > el.clientWidth + 1;
      const overY = hy && el.scrollHeight > el.clientHeight + 2;
      if (overX || overY) {
        const titled = !!el.closest("[title]") || !!el.querySelector("[title]");
        const entry = {
          sel: sel(el),
          text: t.slice(0, 90),
          x: overX ? `${el.scrollWidth}>${el.clientWidth}` : undefined,
          y: overY ? `${el.scrollHeight}>${el.clientHeight}` : undefined,
          ellipsis: cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none" ? true : undefined,
          titled: titled || undefined,
        };
        if (entry.ellipsis && !titled) out.ellipsisNoTitle.push(entry);
        else if (!entry.ellipsis) out.clipped.push(entry);
      }
    }
    // Spill: own text whose line boxes reach past its block container (long words, addresses, numbers).
    if (ownText && cs.display !== "inline" && !hiddenChain(el)) {
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent!.trim()) continue;
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.right > box.right + 2 || r.left < box.left - 2) {
          out.spill.push({
            sel: sel(el),
            text: n.textContent!.trim().slice(0, 90),
            x: `text ${Math.round(r.left)}..${Math.round(r.right)} box ${Math.round(box.left)}..${Math.round(box.right)}`,
          });
          break;
        }
      }
    }
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      if (img.complete && img.naturalWidth === 0) out.brokenImages.push({ sel: sel(el), src: img.src });
    }
  }

  // Past the right (or left) edge, outermost offender only, ignoring anything inside a clipping/scrolling box.
  const reported: Element[] = [];
  for (const el of all) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) continue;
    if (getComputedStyle(el).position === "fixed") {
      // off-canvas drawers are fine when hidden; a visible fixed element off the edge is not
    }
    let clipped = false;
    for (
      let a = el.parentElement;
      a && a !== document.body && a !== document.documentElement;
      a = a.parentElement
    ) {
      if (clipsX(a)) {
        const ar = a.getBoundingClientRect();
        if (ar.right <= vw + 1 && ar.left >= -1) clipped = true;
        break;
      }
    }
    if (clipped || hiddenChain(el)) continue;
    if (reported.some((p) => p.contains(el))) continue;
    reported.push(el);
    out.pastRight.push({
      sel: sel(el),
      text: text(el).slice(0, 60),
      left: Math.round(r.left),
      right: Math.round(r.right),
      vw,
    });
  }

  // Overlapping text: line boxes of text nodes, pairwise.
  type Box = { node: Text; r: DOMRect; parent: Element };
  const boxes: Box[] = [];
  // The visible part of an element's box after every clipping ancestor (overflow other than visible).
  const clipCache = new Map<Element, DOMRect | null>();
  const clipOf = (el: Element | null): DOMRect | null => {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (clipCache.has(el)) return clipCache.get(el)!;
    const up = clipOf(el.parentElement);
    const cs = getComputedStyle(el);
    let r: DOMRect | null = up;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible")
      r = clipTo(el.getBoundingClientRect(), up) ?? new DOMRect(0, 0, 0, 0);
    clipCache.set(el, r);
    return r;
  };
  function clipTo(r: DOMRect, c: DOMRect | null): DOMRect | null {
    if (!c) return r;
    const left = Math.max(r.left, c.left);
    const top = Math.max(r.top, c.top);
    const right = Math.min(r.right, c.right);
    const bottom = Math.min(r.bottom, c.bottom);
    return right - left > 1 && bottom - top > 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.textContent!.trim()) continue;
    const parent = n.parentElement!;
    if (!parent || parent.closest("script,style,noscript,.sr-only,.visually-hidden,svg")) continue;
    if (hiddenChain(parent)) continue;
    // Fixed layers (banner, menus, tooltips) sit over content by design.
    let fixed = false;
    for (let e: Element | null = parent; e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).position === "fixed") {
        fixed = true;
        break;
      }
    }
    if (fixed) continue;
    range.selectNodeContents(n);
    // Line boxes span the font's whole ascent/descent; keep the middle band where the glyphs are, so tight
    // display leading (line-height < 1) doesn't count as overlap.
    for (const r of range.getClientRects()) {
      if (r.width > 1 && r.height > 1) {
        const band = clipTo(
          new DOMRect(r.left, r.top + r.height * 0.22, r.width, r.height * 0.56),
          clipOf(parent),
        );
        if (band) boxes.push({ node: n, r: band, parent });
      }
    }
  }
  // Words split across lines mid-word (overflow-wrap: anywhere squeezing a title or a number into a narrow box).
  {
    const wr = document.createRange();
    const done = new Set<Element>();
    for (const { node, parent } of boxes) {
      if (done.has(parent)) continue;
      const t = node.textContent!;
      for (const m of t.matchAll(/[A-Za-z0-9$.,%]{3,}/g)) {
        wr.setStart(node, m.index!);
        wr.setEnd(node, m.index! + m[0].length);
        const rects = [...wr.getClientRects()].filter((r) => r.width > 1);
        const lines = new Set(rects.map((r) => Math.round(r.top)));
        // Hashes, addresses and URLs are meant to break anywhere; real words and numbers are not.
        if (lines.size > 1 && m[0].length < 24) {
          done.add(parent);
          out.brokenWords.push({ sel: sel(parent), word: m[0] });
          break;
        }
      }
    }
  }
  const seen = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.node === b.node) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix <= 2 || iy <= 2) continue;
      // Fixed/sticky layers (nav) over content are expected when scrolled; we capture at the top.
      const key = `${sel(a.parent)}|${sel(b.parent)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.overlap.push({
        a: `${sel(a.parent)} «${a.node.textContent!.trim().slice(0, 40)}»`,
        b: `${sel(b.parent)} «${b.node.textContent!.trim().slice(0, 40)}»`,
        at: [Math.round(a.r.left), Math.round(a.r.top)],
      });
    }
  }

  document.body.style.overflowX = "visible";
  document.documentElement.style.overflowX = "visible";
  const hOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  document.body.style.overflowX = "";
  document.documentElement.style.overflowX = "";
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 40);
  return { hOverflow, ...out };
}

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
      await new Promise((r) => setTimeout(r, 120));
    }
    document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  });
}

async function audit(browser: Browser, state: State, w: number, h: number) {
  const mobile = w <= 400;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: "light",
    baseURL: BASE || test.info().project.use.baseURL,
  });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r) =>
    failed.push(`${r.failure()?.errorText} ${r.method()} ${r.url().slice(0, 160)}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`);
  });
  await acknowledge(page);
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((list) => {
        type Shift = {
          value: number;
          hadRecentInput: boolean;
          startTime: number;
          sources: { node: Node | null }[];
        };
        const w = window as unknown as { __cls: number; __shifts: string[] };
        w.__shifts ??= [];
        for (const e of list.getEntries() as unknown as Shift[]) {
          if (e.hadRecentInput) continue;
          w.__cls += e.value;
          const src = e.sources
            .map((s) => {
              const n = s.node as Element | null;
              if (!n || n.nodeType !== 1) return String(n?.nodeName);
              return `${n.tagName.toLowerCase()}.${[...n.classList].slice(0, 2).join(".")} «${(n.textContent ?? "").trim().slice(0, 30)}»`;
            })
            .join(" | ");
          w.__shifts.push(`${e.value.toFixed(3)} @${Math.round(e.startTime)}ms ${src}`);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // unsupported
    }
  });

  let status = 0;
  let contentType = "";
  try {
    const res = await page.goto(state.path, { waitUntil: "load", timeout: 60_000 });
    status = res?.status() ?? 0;
    contentType = res?.headers()["content-type"] ?? "";
  } catch (e) {
    consoleErrors.push(`goto: ${(e as Error).message.split("\n")[0]}`);
  }
  if (state.prepare)
    await state.prepare(page).catch((e) => consoleErrors.push(`prepare: ${String(e).slice(0, 200)}`));
  else await settle(page, 1500);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls).catch(() => -1);
  const shifts = await page
    .evaluate(() => (window as unknown as { __shifts?: string[] }).__shifts ?? [])
    .catch(() => [] as string[]);
  if (state.frames) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    let n = 0;
    for (let y = 0; ; y += Math.round(h * 0.9)) {
      const top = Math.min(y, total - h);
      await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), top);
      await settle(page, 700);
      await page.screenshot({ path: join(OUT, `${state.name}-${w}-f${String(++n).padStart(2, "0")}.png`) });
      if (top >= total - h) break;
    }
  }
  await scrollThrough(page).catch(() => {});
  await settle(page, 1200);
  const checks = await page.evaluate(domChecks).catch((e) => ({ error: String(e) }));
  const file = join(OUT, `${state.name}-${w}`);
  await page.screenshot({ path: `${file}.png`, fullPage: true }).catch(() => {});
  const report = {
    state: state.name,
    path: state.path,
    width: w,
    status,
    contentType,
    cls: Math.round(cls * 1000) / 1000,
    shifts: shifts.slice(0, 10),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 30),
    failedRequests: [...new Set(failed)].slice(0, 30),
    ...checks,
  };
  writeFileSync(`${file}.json`, JSON.stringify(report, null, 2));
  await ctx.close();
}

test.describe("ui audit", () => {
  test.describe.configure({ mode: "parallel" });
  test.skip(!process.env.UI_AUDIT, "set UI_AUDIT=1 to run the UI audit");

  for (const state of STATES) {
    if (ONLY && !ONLY.test(state.name)) continue;
    test(state.name, async ({ browser }, info) => {
      test.skip(info.project.name !== "desktop", "the audit sets its own viewports");
      test.setTimeout(900_000);
      mkdirSync(OUT, { recursive: true });
      for (const { w, h } of WIDTHS) {
        if (state.widths && !state.widths.includes(w)) continue;
        await audit(browser, state, w, h);
      }
    });
  }
});
