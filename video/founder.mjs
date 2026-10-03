#!/usr/bin/env node
// The founder's intro: the owner's own recording, cut tight, with word-by-word captions, a lower third, four short
// cut-aways from the live site and an end card. No music: the founder talking, as YC asks of founder videos.
//
//   node video/founder.mjs        # -> docs/media/strike-founder.mp4 (16:9), strike-founder-vertical.mp4 (9:16),
//                                 #    strike-founder.srt, and video/.out/founder/intro.mp4 (16:9, no end card) that
//                                 #    the pitch opens with (video/pitch.mjs, `intro`)
//
// The raw recording is not in the repository: FOUNDER_RAW (default ~/.cache/strike-founder/raw.mp4). The cut, the words
// and the cut-away windows are data in video/founder.json, in seconds of the raw file. Captions: ASS rendered by libass,
// one event per spoken word (the word in the site's mint with a short scale pop, key phrases in mint for the whole
// chunk), in Inter Tight ExtraBold (FOUNDER_FONTS, default ~/.cache/strike-founder/fonts, the static fontsource TTFs).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, chromium, ff, log, pageHelpers } from "./lib/engine.mjs";

const CFG = JSON.parse(readFileSync(join(ROOT, "video/founder.json"), "utf8"));
const RAW = process.env.FOUNDER_RAW ?? join(homedir(), ".cache/strike-founder/raw.mp4");
const FONTS = process.env.FOUNDER_FONTS ?? join(homedir(), ".cache/strike-founder/fonts");
const NOTE = process.env.FOUNDER_NOTE ?? join(homedir(), ".cache/strike-founder/note.ogg");
const SPLICE = CFG.splice ?? null;
const APP = "https://strike-options.vercel.app";
const WORK = join(ROOT, "video/.out/founder");
const MEDIA = join(ROOT, "docs/media");
const FPS = 30;
const MINT = "#75d0cb";
const ASS_MINT = "&H00CBD075&"; // ASS colours are &HAABBGGRR
const ASS_WHITE = "&H00FFFFFF&";

// ------------------------------------------------------------------------------------------ the cut

/** The kept intervals of the raw file: [in, out] minus the removed pauses. */
function keptSegments() {
  const segs = [];
  let t = CFG.in;
  for (const [a, b] of CFG.remove) {
    segs.push([t, a]);
    t = b;
  }
  segs.push([t, CFG.out]);
  // the re-recorded sentence takes the place of the kept interval it replaces (times in the voice note)
  return segs.map(([a, b]) =>
    SPLICE && Math.abs(a - SPLICE.raw[0]) < 1e-6 && Math.abs(b - SPLICE.raw[1]) < 1e-6
      ? [SPLICE.from, SPLICE.to, "note"]
      : [a, b, "raw"],
  );
}
const SEGS = keptSegments();
if (SPLICE && !SEGS.some((s) => s[2] === "note"))
  throw new Error("founder.json: splice.raw is not a kept interval");
/** A raw time on the edited timeline. */
function edited(t) {
  let out = 0;
  for (const [a, b, src] of SEGS) {
    if (src === "raw") {
      if (t <= a) return out;
      if (t <= b) return out + (t - a);
    }
    out += b - a;
  }
  return out;
}
/** Where the voice note starts on the edited timeline. */
const NOTE_AT = (() => {
  let out = 0;
  for (const [a, b, src] of SEGS) {
    if (src === "note") return out;
    out += b - a;
  }
  return null;
})();
const SPEECH = SEGS.reduce((s, [a, b]) => s + (b - a), 0);
const inSplice = (t) => SPLICE && t >= SPLICE.raw[0] && t <= SPLICE.raw[1];
export const WORDS = [
  ...CFG.words.filter(([a]) => !inSplice(a)).map(([a, b, text]) => ({ a: edited(a), b: edited(b), text })),
  ...(SPLICE?.words ?? []).map(([a, b, text]) => ({
    a: NOTE_AT + a - SPLICE.from,
    b: NOTE_AT + b - SPLICE.from,
    text,
  })),
].sort((x, y) => x.a - y.a);
const BROLL = CFG.broll
  .map((r) =>
    r.splice
      ? { ...r, a: NOTE_AT, b: NOTE_AT + SPLICE.to - SPLICE.from }
      : { ...r, a: edited(r.from), b: edited(r.to) },
  )
  .sort((x, y) => x.a - y.a);

/** The intro the pitch opens with: the founder's cut before its end card (docs/media/strike-founder.mp4). */
export const INTRO = {
  path: join(MEDIA, "strike-founder.mp4"),
  duration: SPEECH,
  title: "Founder intro",
  text: WORDS.map((w) => w.text).join(" "),
};

// ------------------------------------------------------------------------------------------ captions

/** Chunks of 1 to 4 words: a break after a sentence or a comma, before a pause, or past the width limit. */
function chunks(maxChars) {
  const out = [];
  let cur = [];
  const flush = () => cur.length && (out.push(cur), (cur = []));
  WORDS.forEach((w, i) => {
    const next = WORDS[i + 1];
    const len = [...cur, w].map((x) => x.text).join(" ").length;
    if (cur.length && (cur.length >= 4 || len > maxChars)) flush();
    cur.push(w);
    if (/[.,!?]$/.test(w.text) || !next || next.a - w.b > 0.35) flush();
  });
  flush();
  return out;
}

/** Word indices inside the key phrases (shown in mint for the whole chunk). */
function keywordSet() {
  const set = new Set();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
  for (const phrase of CFG.keywords) {
    const p = phrase.split(/\s+/).map(norm);
    for (let i = 0; i + p.length <= WORDS.length; i++)
      if (p.every((x, k) => norm(WORDS[i + k].text) === x)) for (let k = 0; k < p.length; k++) set.add(i + k);
  }
  return set;
}

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assEsc = (s) => s.replace(/[{}]/g, "").replace(/\\/g, "");

/** An ASS file: one event per spoken word, the chunk on screen with that word in mint and popping (108% for 60 ms,
 *  back to 100% by 140 ms). */
function assFile({ w, h, size, x, y, maxChars, end }) {
  const keys = keywordSet();
  const index = new Map(WORDS.map((wd, i) => [wd, i]));
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Inter Tight ExtraBold,${size},&H00FFFFFF,&H00FFFFFF,&H500D0D0D,&H90000000,0,0,0,0,100,100,0,0,1,${(size / 20).toFixed(1)},${(size / 24).toFixed(1)},5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  const cs = chunks(maxChars);
  cs.forEach((c, ci) => {
    const next = cs[ci + 1];
    const last = c.at(-1);
    const chunkEnd = Math.min(end, next ? Math.min(next[0].a - 0.02, last.b + 0.6) : last.b + 0.6);
    c.forEach((wd, k) => {
      const from = k === 0 ? Math.max(0, wd.a - 0.05) : wd.a;
      const to = k + 1 < c.length ? c[k + 1].a : chunkEnd;
      if (to <= from) return;
      const text = c
        .map((o) => {
          const base = keys.has(index.get(o)) ? ASS_MINT : ASS_WHITE;
          const t = assEsc(o.text);
          if (o !== wd) return `{\\1c${base}}${t}`;
          return `{\\1c${ASS_MINT}\\t(0,60,\\fscx108\\fscy108)\\t(60,140,\\fscx100\\fscy100)}${t}{\\fscx100\\fscy100}`;
        })
        .join(" ");
      const fade = k === 0 ? "\\fad(70,0)" : "";
      lines.push(
        `Dialogue: 0,${assTime(from)},${assTime(to)},Word,,0,0,0,,{\\an5\\pos(${x},${y})\\blur1.2${fade}}${text}`,
      );
    });
  });
  return head + lines.join("\n") + "\n";
}

/** SRT of the same chunks (for the pitch's captions file and players that show their own). */
export function founderSrt(offset = 0) {
  return chunks(28).map((c, i, all) => {
    const next = all[i + 1];
    const to = next ? Math.min(next[0].a - 0.02, c.at(-1).b + 0.6) : c.at(-1).b + 0.6;
    return { from: offset + c[0].a, to: offset + Math.min(to, SPEECH), text: c.map((w) => w.text).join(" ") };
  });
}

// ------------------------------------------------------------------------------------------ cut-aways

/** Each cut-away: a page of the live site, what to box, and the screenshot's focus rectangle (viewport pixels). */
const SHOTS = {
  // covered calls against holding, from the backtest (the sentence is about covered-call funds)
  market: {
    path: "/app/backtest",
    ready: (p) => p.locator('[data-metric="cagr"]').first().waitFor({ timeout: 60_000 }),
    focus: () => [
      document.querySelector('[data-metric="cagr"]'),
      document.querySelector('[data-metric="vol"]'),
    ],
  },
  stages: {
    path: "/app/decision/46630/2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run-2?dry=1",
    ready: (p) =>
      p
        .getByText(/stages ran/)
        .first()
        .waitFor({ timeout: 60_000 }),
    focus: () => {
      const v = window.__v;
      const strip = document.querySelector('ol[class*="decision_strip"]');
      const line = v.leaf("^4 of 5 stages ran", "");
      return [strip, line];
    },
  },
  rejected: {
    path: "/app/decision/46630/2026-10-01-sTSLA-CSP",
    ready: (p) => p.getByText("NOT REACHED", { exact: false }).first().waitFor({ timeout: 60_000 }),
    focus: () => {
      const li = window.__v.leaf("^Delta band", "").closest("li");
      return [li, li.nextElementSibling ?? li];
    },
  },
  testnets: {
    path: "/app/proof",
    ready: (p) =>
      p
        .getByText(/rounds match Robinhood Chain mainnet Chainlink/)
        .first()
        .waitFor({ timeout: 90_000 }),
    // the two testnets' headers on "Running by itself": each chain's name and its "Prices in step" badge
    focus: () => {
      const v = window.__v;
      const a = v.leaf("^Robinhood Chain testnet$", "").closest("header");
      const b = [...document.querySelectorAll("h3")]
        .find((h) => /^Arbitrum Sepolia$/.test(h.textContent.trim()))
        .closest("header");
      return [a, b];
    },
  },
  waitlist: {
    path: "/waitlist",
    ready: (p) =>
      p
        .getByText(/^Join the waitlist$/i)
        .first()
        .waitFor({ timeout: 60_000 }),
    focus: () => {
      const v = window.__v;
      const title = v.leaf("^Strike on Robinhood Chain mainnet$", "");
      const button = [...document.querySelectorAll("a,button")].find((e) =>
        /^Join the waitlist$/i.test(e.textContent.trim()),
      );
      return [title, button];
    },
  },
};

async function captureShots(browser) {
  const out = {};
  for (const r of BROLL) {
    const shot = SHOTS[r.id];
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: "UTC" });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("strike.ack.v1", "1");
      } catch {}
    });
    await ctx.addInitScript(pageHelpers);
    const page = await ctx.newPage();
    await page.goto(`${APP}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await shot.ready(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const rect = await page.evaluate((src) => {
      const v = window.__v;
      v.init();
      const els = new Function(`return (${src})()`)().filter(Boolean);
      const r = v.union(els.map((e) => v.rect(e)));
      window.scrollTo(0, Math.max(0, r.y + r.h / 2 - 470));
      v.box(r, { pad: 12, dim: 0.22 });
      return { x: r.x - scrollX, y: r.y - scrollY, w: r.w, h: r.h };
    }, shot.focus.toString());
    await page.waitForTimeout(900);
    const png = join(WORK, `shot-${r.id}.png`);
    await page.screenshot({ path: png });
    out[r.id] = { png, rect };
    await ctx.close();
    log(`  cut-away ${r.id}: ${shot.path}`);
  }
  return out;
}

/** A still with a slow push-in (100% to 104%), `dur` seconds, at w x h; `shade` darkens the bottom (a soft gradient,
 *  not a box) so the captions read over a light page. */
function pushIn(png, dur, w, h, out, crop = null, shade = null) {
  const n = Math.round(dur * FPS);
  const pre = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  const zoom = `${pre}scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='1+0.04*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${n}:s=${w}x${h}:fps=${FPS}`;
  ff([
    "-loop",
    "1",
    "-i",
    png,
    ...(shade ? ["-loop", "1", "-i", shade] : []),
    shade ? "-filter_complex" : "-vf",
    shade
      ? `[0:v]${zoom}[z];[1:v]format=rgba[g];[z][g]overlay=0:0:shortest=1,format=yuv420p`
      : `${zoom},format=yuv420p`,
    "-frames:v",
    String(n),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "14",
    out,
  ]);
}

// ------------------------------------------------------------------------------------------ cards

const FONT_CSS = `<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;700;800&family=JetBrains+Mono:wght@500;700&display=block" rel="stylesheet">`;

async function renderHtml(browser, html, w, h, out, transparent = true) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: transparent });
  await ctx.close();
}

/** The lower third: a dark panel with the site's mint rule, name and role, then the school. */
function lowerThirdHtml(w, h, x, y, maxW) {
  const lt = CFG.lowerThird;
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_CSS}<style>
html,body{margin:0;width:${w}px;height:${h}px;background:transparent}
.lt{position:absolute;left:${x}px;top:${y}px;max-width:${maxW}px;background:rgba(13,13,13,.86);border-left:6px solid ${MINT};
padding:16px 24px 15px 20px;box-sizing:border-box;border-radius:4px}
.n{font:700 32px/1.12 "Inter Tight",sans-serif;letter-spacing:-.01em;color:#f1f0ed;white-space:nowrap}
.s{margin-top:7px;font:700 17px/1 "Inter Tight",sans-serif;letter-spacing:.16em;text-transform:uppercase;color:${MINT}}
</style></head><body><div class="lt"><div class="n">${lt.name}</div><div class="s">${lt.line2}</div></div></body></html>`;
}

function endCardHtml(w, h) {
  const logo = readFileSync(join(MEDIA, "brand/strike-wordmark-white.png")).toString("base64");
  const vertical = h > w;
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_CSS}<style>
html,body{margin:0;width:${w}px;height:${h}px;background:#111111;overflow:hidden}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${vertical ? 54 : 40}px;text-align:center}
img{width:${vertical ? 620 : 520}px}
.u{font:700 ${vertical ? 54 : 50}px/1 "JetBrains Mono",monospace;color:#f1f0ed;letter-spacing:-.01em}
.w{font:600 ${vertical ? 38 : 32}px/1.35 "Inter Tight",sans-serif;color:${MINT};max-width:${vertical ? 900 : 1500}px}
.w b{color:#f1f0ed;font-weight:700}
</style></head><body><div class="c"><img src="data:image/png;base64,${logo}">
<div class="u">strike-options.vercel.app</div>
<div class="w">Join the waitlist:${vertical ? "<br>" : " "}<b>strike-options.vercel.app/waitlist</b></div></div></body></html>`;
}

// ------------------------------------------------------------------------------------------ build

/** The founder's picture and voice, cut: one ffmpeg concat of the kept intervals; the voice cleaned and set to
 *  -16 LUFS (true peak -2 dBTP before AAC, so the file stays at or under -1.5): high-pass, light FFT denoise, gentle compression, two-pass loudnorm. */
function cutAroll(crop, w, h, out, wav) {
  const [cx, cy, cw, ch] = crop;
  const parts = [];
  const labels = [];
  SEGS.forEach(([a, b, src], i) => {
    // the voice note's picture is the camera's own frames from where the sentence was (a cut-away covers them)
    const [va, vb] = src === "note" ? [SPLICE.raw[0], SPLICE.raw[0] + (b - a)] : [a, b];
    parts.push(
      `[0:v:0]trim=start=${va.toFixed(3)}:end=${vb.toFixed(3)},setpts=PTS-STARTPTS,crop=${cw}:${ch}:${cx}:${cy},scale=${w}:${h}:flags=lanczos,setsar=1,eq=contrast=1.03:saturation=0.97,unsharp=5:5:0.35[v${i}]`,
    );
    // 8 ms fades at each cut, so a jump cut never clicks
    parts.push(
      src === "note"
        ? `[1:a:0]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`
        : `[0:a:0]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.008,afade=t=out:st=${(b - a - 0.008).toFixed(3)}:d=0.008[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${SEGS.length}:v=1:a=1[v][a]`);
  ff([
    "-i",
    RAW,
    ...(SPLICE ? ["-i", join(WORK, "note-matched.wav")] : []),
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "pcm_s16le",
    out,
  ]);
  if (!wav) return;
  const chain =
    "highpass=f=80,afftdn=nr=6:nf=-50,acompressor=threshold=-21dB:ratio=2.5:attack=8:release=160:makeup=1.5";
  const r = ffOut([
    "-i",
    out,
    "-vn",
    "-af",
    `${chain},loudnorm=I=-16:TP=-2:LRA=11:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const m = JSON.parse(r.match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
  ff([
    "-i",
    out,
    "-vn",
    "-af",
    `${chain},loudnorm=I=-16:TP=-2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
}

/** The voice note, matched to the camera's voice: the EQ (with the camera audio's bandwidth), the level, the camera's
 *  room tone under it, 30 ms fades. Written as 48 kHz stereo, exactly to - from seconds long. */
function matchNote() {
  if (!existsSync(NOTE)) throw new Error(`no voice note at ${NOTE} (set FOUNDER_NOTE)`);
  const len = SPLICE.to - SPLICE.from;
  const eq = SPLICE.eq.map(([f, g]) => `entry(${f},${g})`).join(";");
  const [ra, rb] = SPLICE.roomTone;
  ff([
    "-i",
    NOTE,
    "-i",
    RAW,
    "-filter_complex",
    [
      `[0:a]atrim=start=${SPLICE.from}:end=${SPLICE.to},asetpts=PTS-STARTPTS,aresample=48000,${SPLICE.denoise ?? "anull"},firequalizer=gain_entry='${eq}',volume=${SPLICE.gainDb}dB,aformat=channel_layouts=stereo[v]`,
      `[1:a]atrim=start=${ra}:end=${rb},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,aloop=loop=-1:size=${Math.round((rb - ra) * 48000)},atrim=duration=${len.toFixed(3)}[room]`,
      `[v][room]amix=inputs=2:normalize=0:duration=first,afade=t=in:d=0.02,afade=t=out:st=${(len - 0.03).toFixed(3)}:d=0.03,atrim=duration=${len.toFixed(3)}[out]`,
    ].join(";"),
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    join(WORK, "note-matched.wav"),
  ]);
}

function ffOut(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}

/** One cut: picture with cut-aways, lower third and captions; optional end card; voice muxed; AAC 48 kHz stereo. */
function compose({ base, wav, shots, lt, ass, endCard, w, h, out, vertical }) {
  const inputs = ["-i", base];
  const f = [];
  let cur = "[0:v]";
  let n = 1;
  if (vertical) {
    // the founder stays behind each cut-away, blurred and dimmed; the page sits inside the frame
    f.push(
      `${cur}split=2[base][bgsrc]`,
      `[bgsrc]boxblur=28:2,eq=brightness=-0.22:saturation=0.7,split=${BROLL.length}${BROLL.map((_, i) => `[bg${i + 1}]`).join("")}`,
    );
    cur = "[base]";
  }
  for (const r of BROLL) {
    inputs.push("-i", shots[r.id]);
    const delay = r.a.toFixed(3);
    if (vertical) {
      f.push(
        `[bg${n}]trim=start=${delay}:duration=${(r.b - r.a).toFixed(3)},setpts=PTS-STARTPTS+${delay}/TB[bgw${n}]`,
      );
      f.push(`${cur}[bgw${n}]overlay=0:0:eof_action=pass[u${n}]`);
      f.push(`[${n}:v]setpts=PTS-STARTPTS+${delay}/TB[s${n}]`);
      f.push(`[u${n}][s${n}]overlay=0:${VCARD_Y}:eof_action=pass[o${n}]`);
    } else {
      f.push(`[${n}:v]setpts=PTS-STARTPTS+${delay}/TB[s${n}]`);
      f.push(`${cur}[s${n}]overlay=0:0:eof_action=pass[o${n}]`);
    }
    cur = `[o${n}]`;
    n++;
  }
  inputs.push("-loop", "1", "-t", (CFG.lowerThird.to + 0.5).toFixed(2), "-i", lt);
  const L = CFG.lowerThird;
  f.push(
    `[${n}:v]format=rgba,fade=t=in:st=${L.from}:d=0.3:alpha=1,fade=t=out:st=${(L.to - 0.3).toFixed(2)}:d=0.3:alpha=1[lt]`,
    `${cur}[lt]overlay=0:0:eof_action=pass,ass=${ass}:fontsdir=${FONTS},setsar=1,format=yuv420p[pic]`,
  );
  n++;
  let vOut = "[pic]";
  let total = SPEECH;
  if (endCard) {
    inputs.push("-loop", "1", "-t", String(CFG.endCard), "-i", endCard);
    f.push(
      `[${n}:v]fps=${FPS},setsar=1,format=yuv420p,fade=t=in:d=0.25[ec]`,
      `[pic][ec]concat=n=2:v=1:a=0[vv]`,
    );
    vOut = "[vv]";
    total += CFG.endCard;
    n++;
  }
  inputs.push("-i", wav);
  f.push(`[${n}:a]apad=whole_dur=${total.toFixed(3)}[aa]`);
  ff([
    ...inputs,
    "-filter_complex",
    f.join(";"),
    "-map",
    vOut,
    "-map",
    "[aa]",
    "-t",
    total.toFixed(3),
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    out,
  ]);
}

const VCARD_Y = 400; // the cut-away card's top in the vertical frame (1080 x 760)

async function main() {
  if (!existsSync(RAW)) throw new Error(`no raw recording at ${RAW} (set FOUNDER_RAW)`);
  if (!existsSync(join(FONTS, "InterTight-800.ttf"))) throw new Error(`no Inter Tight ExtraBold in ${FONTS}`);
  mkdirSync(WORK, { recursive: true });
  log(
    `founder: ${SEGS.length} kept intervals, ${SPEECH.toFixed(2)} s of the ${CFG.source.duration} s recording`,
  );
  for (const r of BROLL) log(`  cut-away ${r.id} ${r.a.toFixed(2)}-${r.b.toFixed(2)} s`);
  const onCamera = SPEECH - BROLL.reduce((s, r) => s + (r.b - r.a), 0);
  log(`  founder on camera ${((onCamera / SPEECH) * 100).toFixed(0)}% of the speech`);

  if (SPLICE) matchNote();
  // the founder, both framings, and the cleaned voice
  const wav = join(WORK, "voice.wav");
  cutAroll(CFG.crop.wide, 1920, 1080, join(WORK, "aroll-wide.mkv"), wav);
  cutAroll(CFG.crop.vertical, 1080, 1920, join(WORK, "aroll-vertical.mkv"), null);

  const browser = await chromium.launch();
  const shots = await captureShots(browser);
  const shade = join(WORK, "shade.png");
  await renderHtml(
    browser,
    `<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:transparent"><div style="position:absolute;left:0;right:0;bottom:0;height:330px;background:linear-gradient(to bottom,rgba(7,17,17,0),rgba(7,17,17,.62))"></div></body></html>`,
    1920,
    1080,
    shade,
  );
  const wide = {};
  const tall = {};
  for (const r of BROLL) {
    const dur = r.b - r.a;
    wide[r.id] = join(WORK, `broll-${r.id}-wide.mp4`);
    pushIn(shots[r.id].png, dur, 1920, 1080, wide[r.id], null, shade);
    // vertical: the boxed part of the page, 1080 x 760, inside the frame
    const fr = shots[r.id].rect;
    const ar = 1080 / 760;
    let cw = Math.min(1920, Math.max(fr.w + 120, (fr.h + 120) * ar));
    let ch = Math.round(cw / ar);
    if (ch > 1080) ((ch = 1080), (cw = Math.round(ch * ar)));
    const cx = Math.round(Math.min(1920 - cw, Math.max(0, fr.x + fr.w / 2 - cw / 2)));
    const cy = Math.round(Math.min(1080 - ch, Math.max(0, fr.y + fr.h / 2 - ch / 2)));
    tall[r.id] = join(WORK, `broll-${r.id}-vertical.mp4`);
    pushIn(shots[r.id].png, dur, 1080, 760, tall[r.id], { x: cx, y: cy, w: Math.round(cw), h: ch });
  }
  const ltWide = join(WORK, "lower-third-wide.png");
  const ltTall = join(WORK, "lower-third-vertical.png");
  await renderHtml(browser, lowerThirdHtml(1920, 1080, 40, 742, 600), 1920, 1080, ltWide);
  await renderHtml(browser, lowerThirdHtml(1080, 1920, 60, 1640, 960), 1080, 1920, ltTall);
  const ecWide = join(WORK, "end-wide.png");
  const ecTall = join(WORK, "end-vertical.png");
  await renderHtml(browser, endCardHtml(1920, 1080), 1920, 1080, ecWide, false);
  await renderHtml(browser, endCardHtml(1080, 1920), 1080, 1920, ecTall, false);
  await browser.close();

  // captions: wide at 89% of the height (the founder's mouth sits at 64%, his chin at up to 84%), vertical at 78%
  const assWide = join(WORK, "captions-wide.ass");
  const assTall = join(WORK, "captions-vertical.ass");
  writeFileSync(assWide, assFile({ w: 1920, h: 1080, size: 74, x: 960, y: 962, maxChars: 24, end: SPEECH }));
  writeFileSync(assTall, assFile({ w: 1080, h: 1920, size: 80, x: 540, y: 1500, maxChars: 17, end: SPEECH }));

  const base = { wav, w: 1920, h: 1080 };
  compose({
    ...base,
    base: join(WORK, "aroll-wide.mkv"),
    shots: wide,
    lt: ltWide,
    ass: assWide,
    endCard: ecWide,
    out: join(MEDIA, "strike-founder.mp4"),
  });
  compose({
    ...base,
    base: join(WORK, "aroll-wide.mkv"),
    shots: wide,
    lt: ltWide,
    ass: assWide,
    endCard: null,
    out: join(WORK, "intro.mp4"),
  });
  compose({
    ...base,
    w: 1080,
    h: 1920,
    base: join(WORK, "aroll-vertical.mkv"),
    shots: tall,
    lt: ltTall,
    ass: assTall,
    endCard: ecTall,
    out: join(MEDIA, "strike-founder-vertical.mp4"),
    vertical: true,
  });
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const p = (x, n = 2) => String(x).padStart(n, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  writeFileSync(
    join(MEDIA, "strike-founder.srt"),
    founderSrt()
      .map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${c.text}\n`)
      .join("\n"),
  );
  writeFileSync(join(WORK, "intro.json"), JSON.stringify({ duration: SPEECH }, null, 1));
  log(
    `founder: ${(SPEECH + CFG.endCard).toFixed(1)} s with the end card; intro for the pitch ${SPEECH.toFixed(1)} s`,
  );
}

if (process.argv[1]?.endsWith("founder.mjs"))
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
