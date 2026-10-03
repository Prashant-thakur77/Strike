// The video engine: narration first, then pictures timed to it.
//
//   1. narrate   every scene's lines go to Chatterbox (video/narration/synth.py, cached); each take is transcribed
//                with Whisper and the best one kept. Scene lengths come from the audio: lead + lines + gaps + tail.
//   2. record    each scene is recorded with Playwright at 1920x1080 on that clock: `h.cue(i)` waits for line i,
//                so a click, zoom or highlight lands on the word that names it. Captions are NOT in the recording.
//   3. assemble  cut the scenes, overlay the caption bar (rendered from the spoken text, at most 2 lines of 42
//                characters, timed to the audio), mix the narration to -16 LUFS, and write the outputs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(ROOT, "app", "package.json"));
export const { chromium } = require("@playwright/test");

export const log = (...a) => console.log("[video]", ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1920,
  H = 1080,
  BAR = 150; // caption bar height; scenes keep what matters above y = 930
export const VIEW_CENTER_Y = (H - BAR) / 2;

const PY = process.env.PYTHON ?? `${process.env.HOME}/.pyenv/versions/3.10.13/bin/python3`;

// ------------------------------------------------------------------------------------------ lines and chunks

/** A narration line: `text` is shown (and is what Whisper is checked against), `say` is what Chatterbox reads.
 *  A "|" in both marks where the caption changes inside the sentence. */
export const L = (text, say = text, opts = {}) => ({ text, say, ...opts });

const clean = (s) =>
  s
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Wrap a caption chunk into at most two lines of about 42 characters, balanced. */
export function wrap2(text, max = 42) {
  if (text.length <= max) return [text];
  let best = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") continue;
    const a = text.slice(0, i),
      b = text.slice(i + 1);
    const worst = Math.max(a.length, b.length);
    if (!best || worst < best.worst) best = { lines: [a, b], worst };
  }
  if (!best || best.worst > max + 3) throw new Error(`caption does not fit two lines of ${max}: "${text}"`);
  return best.lines;
}

// ------------------------------------------------------------------------------------------ narration

export function narrate(scenes, work, settings) {
  const items = scenes
    .filter((s) => s.lines?.length)
    .map((s) => ({ id: s.id, lines: s.lines.map((l) => [clean(l.text), clean(l.say), l.seeds ?? null]) }));
  const job = join(work, "narration-job.json");
  const out = join(work, "narration.json");
  writeFileSync(job, JSON.stringify({ settings, items }, null, 1));
  const hash = createHash("sha1").update(readFileSync(job)).digest("hex");
  const stamp = join(work, "narration.hash");
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === hash) {
    log("narration: cached");
  } else {
    log("narration: Chatterbox (this takes a while the first time)");
    const r = spawnSync(PY, [join(ROOT, "video/narration/synth.py"), job, out], {
      cwd: work,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status !== 0) throw new Error("synth.py failed");
    writeFileSync(stamp, hash);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/** Scene clocks from the audio. Each line: start/end inside the scene; each caption chunk: start inside the scene. */
export function timeline(scenes, narr, defaults = {}) {
  const D = { lead: 0.3, gap: 0.42, tail: 0.4, ...defaults };
  let t0 = 0;
  const out = [];
  for (const s of scenes) {
    const takes = narr[s.id] ?? [];
    const lead = s.lead ?? D.lead,
      gap = s.gap ?? D.gap,
      tail = s.tail ?? D.tail;
    let t = lead;
    const lines = (s.lines ?? []).map((l, i) => {
      const take = takes[i];
      if (!take) throw new Error(`no narration for ${s.id} line ${i}`);
      // D.gapAfter (opt-in, e.g. { "?": 0.75, ".": 0.6, ";": 0.4 }): the gap follows how the previous line ends, so
      // pauses vary as in a human read instead of one fixed gap (targets: .internal/docs/reference-videos.md).
      // A scene's own `gap` still wins; `pre` on a line adds a held pause before a reveal.
      if (i > 0) t += s.gap ?? D.gapAfter?.[s.lines[i - 1].text.trim().slice(-1)] ?? gap;
      t += l.pre ?? 0;
      const start = t;
      t += take.dur;
      return { start, end: t, take, text: l.text, say: l.say, chunks: chunkTimes(l, take, start) };
    });
    const dur = Math.max(s.minDur ?? 0, (s.lines?.length ? t : 0) + tail, s.fixedDur ?? 0);
    out.push({ id: s.id, start: t0, dur: Number(dur.toFixed(3)), lines });
    t0 += dur;
  }
  return out;
}

function chunkTimes(line, take, start) {
  const disp = line.text.split("|").map((x) => x.trim());
  const say = line.say.split("|").map((x) => x.trim());
  const weights = (say.length === disp.length ? say : disp).map((x) => x.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const res = [];
  let acc = 0;
  disp.forEach((text, k) => {
    let rel = (acc / total) * take.dur;
    if (k > 0 && take.pauses?.length) {
      // snap to the nearest silence in the take, if one is close
      const mids = take.pauses.map(([a, b]) => (a + b) / 2);
      const near = mids.reduce((m, x) => (Math.abs(x - rel) < Math.abs(m - rel) ? x : m), Infinity);
      if (Math.abs(near - rel) < 0.7) rel = near;
    }
    res.push({ text, start: start + rel });
    acc += weights[k];
  });
  return res;
}

// ------------------------------------------------------------------------------------------ in-page helpers

/** Installed in every recorded page: camera zoom (a transform on <body>), highlight boxes, eased scrolling. */
export function pageHelpers() {
  if (window.__v) return;
  const st = { s: 1, tx: 0, ty: 0 };
  const body = () => document.body;
  const apply = (ms) => {
    const b = body();
    b.style.transformOrigin = "0 0";
    b.style.transition = ms ? `transform ${ms}ms cubic-bezier(.25,.7,.25,1)` : "none";
    b.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
  };
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + scrollX - st.tx) / st.s,
      y: (r.top + scrollY - st.ty) / st.s,
      w: r.width / st.s,
      h: r.height / st.s,
    };
  };
  window.__v = {
    init() {
      document.documentElement.style.scrollBehavior = "auto";
      // A transform on <body> makes fixed and sticky bars scroll with the page anyway; pin them to the top of the
      // document instead, so a zoom never shows a nav bar floating mid-page.
      for (const el of document.body.querySelectorAll("*")) {
        if (el.closest("#__wal, .__vbox")) continue;
        const p = getComputedStyle(el).position;
        if (p === "sticky") el.style.position = "relative";
        if (p === "fixed") el.style.position = "absolute";
        if (p === "sticky" || p === "fixed") el.style.top = el.style.top || "";
      }
      apply(0);
    },
    leaf(src, flags, nth = 0, within) {
      const re = new RegExp(src, flags);
      const root = within ? document.querySelector(within) : document.body;
      const all = [...root.querySelectorAll("*")].filter(
        (el) =>
          !el.closest("#__vbox") && re.test((el.textContent || "").trim()) && el.getClientRects().length,
      );
      const leaves = all.filter((el) => ![...el.children].some((c) => all.includes(c)));
      return leaves[nth] ?? null;
    },
    rect(el) {
      return docRect(el);
    },
    union(rects) {
      const x = Math.min(...rects.map((r) => r.x)),
        y = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.w)),
        y2 = Math.max(...rects.map((r) => r.y + r.h));
      return { x, y, w: x2 - x, h: y2 - y };
    },
    zoom(el, s = 1.5, ms = 420, fy = null) {
      this.zoomRect(el.getBoundingClientRect ? docRect(el) : el, s, ms, fy);
    },
    zoomRect(r, s = 1.5, ms = 420, fy = null) {
      const cx = r.x + r.w / 2,
        cy = r.y + r.h / 2;
      const vy = fy ?? window.__vCenterY ?? 465;
      st.s = s;
      st.tx = Math.min(0, Math.max(innerWidth - innerWidth * s, innerWidth / 2 - s * cx));
      const docH = Math.max(body().scrollHeight, body().offsetHeight);
      st.ty = Math.min(scrollY, Math.max(innerHeight + scrollY - s * docH, vy + scrollY - s * cy));
      apply(ms);
    },
    unzoom(ms = 420) {
      st.s = 1;
      st.tx = 0;
      st.ty = 0;
      apply(ms);
    },
    box(el, opts = {}) {
      const pad = opts.pad ?? 10;
      const r = el.getBoundingClientRect ? docRect(el) : el;
      const b = body();
      const d = document.createElement("div");
      d.className = "__vbox";
      d.id = "__vbox";
      const color = opts.color ?? "#f2a93b";
      Object.assign(d.style, {
        position: "absolute",
        zIndex: 2147483000,
        pointerEvents: "none",
        left: `${r.x - pad}px`,
        top: `${r.y - pad}px`,
        width: `${r.w + 2 * pad}px`,
        height: `${r.h + 2 * pad}px`,
        border: `4px solid ${color}`,
        borderRadius: "10px",
        boxShadow: `0 0 0 9999px rgba(0,0,0,${opts.dim ?? 0.28}), 0 0 24px ${color}`,
        opacity: "0",
        transition: "opacity 300ms ease",
      });
      if (getComputedStyle(b).position === "static") b.style.position = "relative";
      b.appendChild(d);
      requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = "1")));
    },
    unbox() {
      document.querySelectorAll(".__vbox").forEach((d) => {
        d.style.opacity = "0";
        setTimeout(() => d.remove(), 320);
      });
    },
    scrollTo(y, ms = 1200) {
      return new Promise((res) => {
        const html = document.documentElement;
        html.style.scrollBehavior = "auto";
        const max = html.scrollHeight - innerHeight;
        const target = Math.max(0, Math.min(max, y));
        const start = scrollY,
          d = target - start,
          t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          window.scrollTo(0, start + d * ease(t));
          if (t < 1) requestAnimationFrame(step);
          else res();
        };
        if (ms <= 0) {
          window.scrollTo(0, target);
          res();
        } else requestAnimationFrame(step);
      });
    },
    top(el) {
      return docRect(el).y;
    },
  };
}

/** Scene helpers on the scene clock. */
function sceneHelpers(page, clock, tl) {
  const toArg = (target) =>
    target instanceof RegExp
      ? { src: target.source, flags: target.flags }
      : typeof target === "string"
        ? { src: `^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, flags: "i" }
        : null;
  /** Run fn(el, arg) in the page on a Locator or on the smallest element whose text matches a string/RegExp. */
  const onEl = async (target, fn, arg, within) => {
    const pat = toArg(target);
    if (pat)
      return page.evaluate(
        ([p, w, fnSrc, a]) => {
          const el = window.__v.leaf(p.src, p.flags, 0, w);
          if (!el) throw new Error(`no element matches /${p.src}/`);
          return new Function("el", "a", `return (${fnSrc})(el, a)`)(el, a);
        },
        [pat, within ?? null, fn.toString(), arg],
      );
    return target.evaluate(
      (el, [fnSrc, a]) => new Function("el", "a", `return (${fnSrc})(el, a)`)(el, a),
      [fn.toString(), arg],
    );
  };
  const h = {
    page,
    tl,
    now: () => clock.now(),
    /** Wait until `t` seconds on the scene clock. */
    async at(t) {
      const ms = (t - clock.now()) * 1000;
      if (ms > 0) await sleep(ms);
    },
    /** Wait for line i (plus dt seconds). */
    async cue(i, dt = 0) {
      const line = tl.lines[i];
      if (!line) throw new Error(`no line ${i}`);
      await h.at(line.start + dt);
    },
    /** Wait for caption chunk k of line i. */
    async chunk(i, k, dt = 0) {
      await h.at(tl.lines[i].chunks[k].start + dt);
    },
    async zoom(target, opts = {}) {
      await onEl(
        target,
        (el, a) => window.__v.zoom(el, a.s, a.ms, a.fy),
        { s: opts.scale ?? 1.5, ms: opts.ms ?? 420, fy: opts.y ?? null },
        opts.within,
      );
    },
    async unzoom(ms = 420) {
      await page.evaluate((m) => window.__v.unzoom(m), ms);
      await sleep(ms + 60); // positions are read untransformed only after the transition ends
    },
    async box(target, opts = {}) {
      await onEl(
        target,
        (el, a) => window.__v.box(el, a),
        { pad: opts.pad, color: opts.color, dim: opts.dim },
        opts.within,
      );
    },
    async unbox() {
      await page.evaluate(() => window.__v.unbox());
    },
    /** Scroll so the target's top sits `offset` px below the viewport top. */
    async scrollTo(target, opts = {}) {
      const offset = opts.offset ?? 140;
      const ms = opts.ms ?? 1200;
      const y =
        typeof target === "number"
          ? target
          : await onEl(target, (el) => window.__v.top(el), null, opts.within);
      await page.evaluate(([y, ms]) => window.__v.scrollTo(y, ms), [y - offset, ms]);
    },
    async expectText(text, timeout = 30_000) {
      await page
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout })
        .catch(() => {
          throw new Error(`expected "${text}" on ${page.url()}`);
        });
    },
  };
  return h;
}

// ------------------------------------------------------------------------------------------ recording

export function videoDuration(path) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-f", "null", "-"], { encoding: "utf8" });
  const times = [...(r.stderr ?? "").matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
}

export async function recordScene(browser, scene, tl, work, env) {
  const dir = join(work, "raw", scene.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "light",
    timezoneId: scene.timezoneId ?? "UTC", // a scene may show the app in a viewer's own time zone
    bypassCSP: true,
    recordVideo: { dir, size: { width: W, height: H } },
    ...(scene.userAgent ? { userAgent: scene.userAgent, locale: "en-US" } : {}),
  });
  // explorers behind a bot check (Arbiscan) render for a browser that does not announce automation
  if (scene.userAgent)
    await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("strike.ack.v1", "1"); // the first-visit eligibility notice
    } catch {}
  });
  await ctx.addInitScript(pageHelpers);
  await ctx.addInitScript((y) => (window.__vCenterY = y), VIEW_CENTER_Y);
  if (scene.context) await scene.context(ctx, env);
  const t0 = Date.now();
  const marks = {};
  const since = () => (Date.now() - t0) / 1000;
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log(`  [${scene.id}] page error: ${e.message.slice(0, 160)}`));
  if (scene.kind === "replay" || scene.kind === "three") {
    // replay.html: terminal, evidence and closing cards; three.html: the three.js scenes
    const file = scene.kind === "three" ? "video/three.html" : "video/replay.html";
    const html = readFileSync(join(ROOT, file), "utf8").replace(
      "/*__DATA__*/ null",
      JSON.stringify(scene.kind === "three" ? scene.three : scene.replay),
    );
    await page.route("https://video.strike.local/**", (r) =>
      r.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto("https://video.strike.local/card");
    await page.waitForFunction(() => window.__prepare, null, { timeout: 60_000 });
    await page.evaluate(() => window.__prepare());
  }
  if (scene.prepare) await scene.prepare(page, env);
  await page.evaluate(() => window.__v?.init());
  await sleep(400);
  marks.start = since();
  const clock = { now: () => since() - marks.start };
  const h = sceneHelpers(page, clock, tl);
  if (scene.run) await scene.run(h, env);
  await h.at(tl.dur + 0.2);
  marks.end = since();
  const video = page.video();
  marks.close = since();
  await ctx.close();
  const path = await video.path();
  const shift = Math.max(0, marks.close - videoDuration(path));
  // negative when the recording began after the scene clock started: segment() pads the first frame
  const meta = { path, start: marks.start - shift, dur: tl.dur, hash: timingHash(tl) };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 1));
  log(`  ${scene.id}: ${tl.dur.toFixed(1)} s recorded (video starts ${shift.toFixed(2)} s late)`);
  return meta;
}

export const timingHash = (tl) =>
  createHash("sha1")
    .update(JSON.stringify([tl.dur.toFixed(2), tl.lines.map((l) => [l.start.toFixed(2), l.text])]))
    .digest("hex")
    .slice(0, 12);

// ------------------------------------------------------------------------------------------ captions

function captionHtml(tag, lines) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&display=block" rel="stylesheet">
<style>html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
#bar{position:absolute;left:0;right:0;bottom:0;height:${BAR}px;background:rgba(13,13,13,.95);border-top:4px solid #75d0cb;
display:flex;align-items:center;gap:30px;padding:0 90px;box-sizing:border-box}
.tag{flex:none;width:190px;font:700 16px/1.2 "Inter Tight",sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#75d0cb}
.txt{font:600 42px/1.2 "Inter Tight",sans-serif;letter-spacing:-.005em;color:#f1f0ed}</style></head>
<body>${lines === null ? "" : `<div id="bar"><div class="tag">${esc(tag ?? "")}</div><div class="txt">${lines.map(esc).join("<br>")}</div></div>`}</body></html>`;
}

/** Caption states on the final timeline: [{from, to, tag, text}] (text null = no bar). */
export function captionStates(scenes, tls) {
  const states = [];
  tls.forEach((tl, i) => {
    const s = scenes[i];
    const chunks = tl.lines.flatMap((l) => l.chunks);
    if (s.bar === false || !chunks.length) {
      states.push({ from: tl.start, to: tl.start + tl.dur, tag: null, text: null });
      return;
    }
    chunks.forEach((c, k) => {
      const from = tl.start + (k === 0 ? 0 : c.start - 0.12);
      const to = k + 1 < chunks.length ? tl.start + chunks[k + 1].start - 0.12 : tl.start + tl.dur;
      states.push({ from, to, tag: s.tag, text: c.text });
    });
  });
  return states;
}

/** SRT cues: each chunk from when it is spoken until the next one starts (or 0.8 s after its line ends). */
export function srt(tls) {
  const cues = [];
  for (const tl of tls)
    for (const l of tl.lines)
      l.chunks.forEach((c, k) => {
        const next = l.chunks[k + 1];
        cues.push({
          from: tl.start + c.start,
          to: tl.start + (next ? next.start : l.end + 0.5),
          text: c.text,
        });
      });
  for (let i = 0; i + 1 < cues.length; i++) cues[i].to = Math.min(cues[i].to, cues[i + 1].from - 0.05);
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const lines = cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${wrap2(c.text).join("\n")}\n`);
  return { text: lines.join("\n"), cues };
}

/** Check the caption rules: two lines of about 42 characters, at most 20 characters a second. */
export function captionReport(tls) {
  const bad = [];
  for (const tl of tls)
    for (const l of tl.lines)
      l.chunks.forEach((c, k) => {
        wrap2(c.text);
        const next = l.chunks[k + 1];
        const d = (next ? next.start : l.end + 0.5) - c.start;
        const cps = c.text.length / d;
        if (cps > 20) bad.push(`${tl.id}: ${cps.toFixed(1)} cps "${c.text}"`);
      });
  return bad;
}

export async function renderCaptions(browser, states, dir) {
  mkdirSync(dir, { recursive: true });
  const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
  const files = new Map();
  let n = 0;
  for (const s of states) {
    const key = JSON.stringify([s.tag, s.text]);
    if (files.has(key)) {
      s.png = files.get(key);
      continue;
    }
    const png = join(dir, `cap-${String(n++).padStart(3, "0")}.png`);
    await page.setContent(captionHtml(s.tag, s.text === null ? null : wrap2(s.text)), {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: png, omitBackground: true });
    files.set(key, png);
    s.png = png;
  }
  await page.context().close();
}

// ------------------------------------------------------------------------------------------ ffmpeg

export function ff(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${r.stderr}`);
}

const FADE = 0.18;
/** One scene's picture, exactly tl.dur long, 30 fps, with a short fade at each end. */
export function segment(scene, tl, src, out) {
  if (src.shots) return footageSegment(tl, src.shots, out);
  const dur = tl.dur.toFixed(3);
  const fades = `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(tl.dur - FADE).toFixed(3)}:d=${FADE}`;
  const enc = [
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    "-an",
    out,
  ];
  if (src.image) {
    ff([
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      src.image,
      "-t",
      dur,
      "-vf",
      `scale=${W}:${H},format=yuv420p,${fades}`,
      ...enc,
    ]);
    return;
  }
  const pad = `tpad=stop_mode=clone:stop_duration=${Math.ceil(tl.dur + 2)}`;
  // a pre-recorded clip may play faster than it was recorded (scene.clipSpeed), e.g. the signing take's block waits
  const speed = src.speed ?? 1;
  const fast = speed !== 1 ? `setpts=PTS/${speed},` : "";
  // a recording that began after the scene clock: hold its first frame for the missing time
  const late = src.start < 0 ? `tpad=start_mode=clone:start_duration=${(-src.start).toFixed(3)},` : "";
  ff([
    "-ss",
    Math.max(0, src.start).toFixed(3),
    "-i",
    src.path,
    "-t",
    (tl.dur * speed).toFixed(3),
    "-vf",
    `${fast}fps=30,scale=${W}:${H}:flags=lanczos,${late}${pad},trim=duration=${dur},format=yuv420p,${fades}`,
    ...enc,
  ]);
}

/** A scene cut from stock footage (video/footage.json, downloaded by video/footage.mjs): each shot from its cue, with
 *  short cross-fades, a slow drift and a light grade so the clips sit together. */
function footageSegment(tl, shots, out) {
  const meta = JSON.parse(readFileSync(join(ROOT, "video/footage.json"), "utf8")).clips;
  const XF = 0.45;
  const offs = shots.map((s, i) => (i === 0 ? 0 : Math.max(0, s.at - XF / 2)));
  const args = [];
  const chains = [];
  shots.forEach((s, i) => {
    const file = join(ROOT, "video/.out/footage", `${s.name}.mp4`);
    if (!existsSync(file)) throw new Error(`missing ${file}: run node video/footage.mjs`);
    const m = meta.find((c) => c.name === s.name) ?? {};
    const len = i + 1 < shots.length ? offs[i + 1] - offs[i] + XF : tl.dur - offs[i];
    const z = m.zoom ?? 1.1;
    const W2 = Math.round((W * z) / 2) * 2,
      H2 = Math.round((H * z) / 2) * 2;
    const yy = Math.round((H2 - H) * (m.y ?? 0.5));
    args.push("-ss", String(m.from ?? 0.5), "-t", (len + 0.1).toFixed(3), "-i", file);
    chains.push(
      `[${i}:v]fps=30,scale=${W2}:${H2},crop=${W}:${H}:x='(${W2 - W})*(0.15+0.7*t/${len.toFixed(3)})':y=${yy},` +
        `eq=saturation=0.86:contrast=1.04:brightness=-0.02,setpts=PTS-STARTPTS,trim=duration=${len.toFixed(3)}[s${i}]`,
    );
  });
  let last = "s0";
  for (let i = 1; i < shots.length; i++) {
    chains.push(`[${last}][s${i}]xfade=transition=fade:duration=${XF}:offset=${offs[i].toFixed(3)}[x${i}]`);
    last = `x${i}`;
  }
  const fades = `fade=t=in:st=0:d=0.5,fade=t=out:st=${(tl.dur - FADE).toFixed(3)}:d=${FADE}`;
  chains.push(
    `[${last}]tpad=stop_mode=clone:stop_duration=2,trim=duration=${tl.dur.toFixed(3)},format=yuv420p,${fades}[v]`,
  );
  ff([
    ...args,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[v]",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    "-an",
    out,
  ]);
}

export function concatList(files, out) {
  writeFileSync(out, files.map((f) => `file '${f}'`).join("\n"));
}

/** Final picture: the joined scenes with the caption track overlaid. */
export function finalVideo(joined, states, work, out, crf) {
  const list = join(work, "captions.txt");
  const lines = [];
  for (const s of states) lines.push(`file '${s.png}'`, `duration ${(s.to - s.from).toFixed(3)}`);
  lines.push(`file '${states.at(-1).png}'`);
  writeFileSync(list, lines.join("\n"));
  ff([
    "-i",
    joined,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-filter_complex",
    "[1:v]fps=30,format=rgba[c];[0:v][c]overlay=0:0:shortest=0:eof_action=pass,format=yuv420p[v]",
    "-map",
    "[v]",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-tune",
    "stillimage",
    "-profile:v",
    "high",
    "-movflags",
    "+faststart",
    "-an",
    out,
  ]);
}

/** The voice track, with an optional music bed (video/narration/music.py) ducked under it; stereo, -16 LUFS. */
export function mixAudio(tls, total, work, music = null) {
  const plan = { duration: total, clips: [] };
  for (const tl of tls)
    for (const l of tl.lines) plan.clips.push({ path: l.take.path, t: tl.start + l.start });
  if (music) {
    const bed = join(ROOT, "video/.out/music", `bed-${music.seed}-${Math.ceil(total)}.wav`);
    if (!existsSync(bed)) {
      mkdirSync(dirname(bed), { recursive: true });
      const r = spawnSync(
        PY,
        [join(ROOT, "video/narration/music.py"), String(Math.ceil(total)), bed, String(music.seed)],
        {
          encoding: "utf8",
        },
      );
      if (r.status !== 0) throw new Error(`music.py failed\n${r.stderr}`);
    }
    plan.music = { path: bed, ...music };
  }
  const p = join(work, "mix-plan.json");
  writeFileSync(p, JSON.stringify(plan, null, 1));
  const wav = join(work, "narration.wav");
  const r = spawnSync(PY, [join(ROOT, "video/narration/mix.py"), p, wav], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mix.py failed\n${r.stderr}`);
  log(`  ${r.stdout.trim()}`);
  return wav;
}

/** Picture and voice in one file; a -2 dB limiter before AAC, whose encoding can push a -1.5 dBFS sample peak over
 *  -1.5 dBTP. */
export function mux(video, wav, out) {
  ff([
    "-i",
    video,
    "-i",
    wav,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-af",
    "alimiter=limit=0.79:attack=5:release=60:level=disabled",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    "-movflags",
    "+faststart",
    out,
  ]);
}

export const mb = (p) => `${(statSync(p).size / 1e6).toFixed(2)} MB`;
export { copyFileSync, execFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, join };
