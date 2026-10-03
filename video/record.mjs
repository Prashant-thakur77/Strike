#!/usr/bin/env node
// Renders the demo and pitch videos from their scene lists:
//
//   node video/record.mjs demo       # video/demo.mjs  -> docs/media/strike-demo.mp4 (narrated, with music),
//                                    #   strike-demo-silent.mp4 (captions only), strike-demo.srt, -poster.png, .gif,
//                                    #   -narration.txt
//   node video/record.mjs pitch      # video/pitch.mjs -> docs/media/strike-pitch.mp4, strike-pitch.srt, -poster.png
//
// Options: --only a,b (re-record only these scenes; the others reuse their recordings in video/.out if the timing
// did not change), --plan (narrate and print the timing, record nothing), --live-sign (record the wallet-signing
// scene for real with the throwaway key in video/.out/wallet/key.json and save it to video/clips/).
//
// Needs: Node 22+, `pnpm install` (Playwright from app/), ffmpeg, and Python 3.10 with chatterbox-tts,
// faster-whisper, pyloudnorm, librosa and soundfile (video/narration). The app is the live site unless APP_URL is
// set. Numbers are read from README.md and the epoch logs at render time (video/lib/facts.mjs). Scenes of kind "three"
// are three.js pages (video/three.html) rendered on the GPU; the music bed is synthesised by video/narration/music.py.
import { readFileSync } from "node:fs";
import {
  ROOT,
  captionReport,
  captionStates,
  chromium,
  concatList,
  copyFileSync,
  existsSync,
  ff,
  finalVideo,
  join,
  log,
  mb,
  mixAudio,
  mkdirSync,
  mux,
  narrate,
  recordScene,
  renderCaptions,
  rmSync,
  segment,
  srt,
  timeline,
  timingHash,
  wrap2,
  writeFileSync,
} from "./lib/engine.mjs";
import { chainConfig } from "./lib/config.mjs";
import { arbFacts, readmeFacts } from "./lib/facts.mjs";

const KIND = process.argv[2];
if (!["demo", "pitch"].includes(KIND)) {
  console.error("usage: node video/record.mjs demo|pitch [--only a,b] [--plan] [--live-sign]");
  process.exit(2);
}
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? (process.argv[i + 1] ?? true) : null;
};
const ONLY = arg("--only") ? new Set(String(arg("--only")).split(",")) : null;
const PLAN = process.argv.includes("--plan");
const LIVE_SIGN = process.argv.includes("--live-sign");
const PREVIEW = process.argv.includes("--preview"); // with --only: record and assemble just those scenes, into video/.out
const WORK = join(ROOT, "video", ".out", KIND);
const MEDIA = join(ROOT, "docs", "media");
mkdirSync(WORK, { recursive: true });

export const SETTINGS = {
  voice: join(ROOT, "video/narration/voice-ref.wav"),
  exaggeration: 0.35,
  cfg_weight: 0.3,
  temperature: 0.7,
  seeds: [11, 23, 37],
  min_score: 0.93,
  min_cands: 2,
  cache: join(ROOT, "video/.out/tts"),
  asr_model: "small.en",
  target_cps: 14.5,
  max_cps: 17,
};

/** The live run's agent output from the epoch log, split by its "== ..." headers. */
function epochLog() {
  const md = readFileSync(join(ROOT, "docs/testnet-epochs/2026-09-29.md"), "utf8");
  const block = md.match(/```\n([\s\S]*?)\n```/)?.[1];
  const parts = {};
  let cur = null;
  for (const line of block.split("\n")) {
    const h = line.match(/^== (\w+)/);
    if (h) parts[(cur = h[1])] = [];
    else if (cur) parts[cur].push(line);
  }
  for (const k of Object.keys(parts)) while (parts[k].at(-1) === "") parts[k].pop();
  return {
    seller: { lines: parts.seller },
    reckless: { lines: parts.reckless },
    buyer: { lines: parts.buyer },
  };
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
/** docs/submission/<kind>-script.md, written from the same scene list and timeline as the video. */
function scriptDoc(doc, scenes, tls, total, words, intro = null) {
  const off = intro?.duration ?? 0;
  const chapters = scenes
    .map((s, i) => (s.chapter ? `${mmss(off + tls[i].start)} ${s.chapter}` : null))
    .filter(Boolean);
  if (intro) chapters.unshift(`0:00 ${intro.title}`);
  const parts = [
    doc.head({
      total: total + off,
      narration: total,
      words,
      wpm: Math.round((words / total) * 60),
      mmss,
      chapters,
      intro,
    }),
  ];
  if (intro) {
    parts.push(`## 0:00 to ${mmss(off)} · ${intro.title}`);
    if (intro.screen) parts.push(`Screen: ${intro.screen}`);
    parts.push(`> ${intro.text}`);
  }
  scenes.forEach((s, i) => {
    const tl = tls[i];
    parts.push(`## ${mmss(off + tl.start)} to ${mmss(off + tl.start + tl.dur)} · ${s.title ?? s.tag}`);
    if (s.screen) parts.push(`Screen: ${s.screen}`);
    parts.push(tl.lines.map((l) => `> ${l.text.replace(/\s*\|\s*/g, " ")}`).join("\n>\n"));
  });
  if (doc.tail) parts.push(doc.tail);
  return parts.join("\n\n") + "\n";
}

async function main() {
  const def = await import(`./${KIND}.mjs`);
  const facts = readmeFacts(ROOT);
  log("README facts", JSON.stringify(facts));
  facts.arb = arbFacts(ROOT, facts);
  const { record: _r, reasoning: _w, ...arbLog } = facts.arb;
  log("Arbitrum Sepolia facts", JSON.stringify(arbLog));
  // the GPU for the three.js scenes; no automation banner for explorers behind a bot check
  const browser = await chromium.launch({
    args: [
      "--use-angle=vulkan",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const env = { EXPLORER: chainConfig(46630).explorer, epoch: epochLog(), facts };
  const live = def.probe ? await def.probe(browser) : {};
  if (Object.keys(live).length) log("live", JSON.stringify(live));
  let scenes = def.scenes(facts, live);
  // The signing scene plays a clip recorded once with a real signature; without one, it is left out.
  scenes = scenes.filter((s) => {
    if (s.kind !== "clip" || LIVE_SIGN || existsSync(join(ROOT, s.clip))) return true;
    log(`no ${s.clip}: leaving out "${s.id}" (record it with --live-sign)`);
    return false;
  });
  if (LIVE_SIGN) {
    const { walletEnv } = await import("./lib/wallet.mjs");
    env.wallet = walletEnv();
    log(`test wallet ${env.wallet.account.address} on ${env.wallet.rpc}`);
  }

  // a video can override the voice settings (the demo reads a little faster than the pitch)
  const narr = narrate(scenes, WORK, { ...SETTINGS, ...(def.tts ?? {}) });
  const tls = timeline(scenes, narr, def.timing ?? {});
  const total = tls.reduce((a, t) => a + t.dur, 0);
  const words = (s) => s.replace(/\|/g, " ").split(/\s+/).filter(Boolean).length;
  let nw = 0;
  for (const tl of tls) {
    const w = tl.lines.reduce((a, l) => a + words(l.text), 0);
    nw += w;
    log(
      `${tl.id.padEnd(11)} ${tl.start.toFixed(1).padStart(6)} +${tl.dur.toFixed(1).padStart(5)} s  ${w} words, ${((w / tl.dur) * 60).toFixed(0)} wpm`,
    );
  }
  log(`total ${total.toFixed(1)} s, ${nw} words, ${((nw / total) * 60).toFixed(0)} wpm`);
  for (const b of captionReport(tls)) log(`caption: ${b}`);
  for (const tl of tls)
    for (const l of tl.lines)
      if (l.take.score < 0.9) log(`low Whisper score ${l.take.score}: "${l.text}" heard "${l.take.asr}"`);
  writeFileSync(join(WORK, "timeline.json"), JSON.stringify(tls, null, 1));
  if (PLAN) return browser.close();
  if (PREVIEW) {
    if (!ONLY) throw new Error("--preview needs --only");
    const keep = scenes.map((s, i) => [s, tls[i]]).filter(([s]) => ONLY.has(s.id));
    scenes = keep.map(([s]) => s);
    let t = 0;
    tls.length = 0;
    for (const [, tl] of keep) {
      tls.push({ ...tl, start: t });
      t += tl.dur;
    }
  }

  // ---------------------------------------------------------------- record
  const srcs = [];
  for (const [i, s] of scenes.entries()) {
    const tl = tls[i];
    if (s.kind === "slide") {
      srcs.push({ image: await def.slideImage(browser, s, WORK) });
      continue;
    }
    if (s.kind === "footage") {
      // stock footage, cut on the narration: shot [name, line, chunk] starts on that caption chunk
      srcs.push({
        shots: s.shots.map(([name, li, k]) => ({
          name,
          at: li === 0 && k === 0 ? 0 : tl.lines[li].chunks[k].start - 0.1,
        })),
      });
      continue;
    }
    if (s.kind === "clip" && !LIVE_SIGN) {
      srcs.push({ path: join(ROOT, s.clip), start: 0, speed: s.clipSpeed ?? 1 });
      continue;
    }
    const metaPath = join(WORK, "raw", s.id, "meta.json");
    const reuse =
      ONLY &&
      !ONLY.has(s.id) &&
      existsSync(metaPath) &&
      JSON.parse(readFileSync(metaPath, "utf8")).hash === timingHash(tl);
    if (reuse) {
      srcs.push(JSON.parse(readFileSync(metaPath, "utf8")));
      continue;
    }
    if (ONLY && !ONLY.has(s.id)) log(`  ${s.id}: no reusable recording (timing changed), recording it`);
    // live pages (and the public RPC) fail now and then: try a scene up to three times, never the live signature
    let meta;
    for (let attempt = 1; ; attempt++) {
      try {
        meta = await recordScene(
          browser,
          { kind: "page", ...s, kind: s.kind === "clip" ? "page" : s.kind },
          tl,
          WORK,
          env,
        );
        break;
      } catch (e) {
        if (s.kind === "clip" || attempt >= 3) throw e;
        log(`  ${s.id}: attempt ${attempt} failed (${e.message.split("\n")[0]}), retrying`);
      }
    }
    srcs.push(meta);
    if (s.kind === "clip") {
      // a rehearsal against a fork (SIGN_RPC) never replaces the committed clip
      const clip = process.env.SIGN_RPC ? join(WORK, "signing-rehearsal.mp4") : join(ROOT, s.clip);
      mkdirSync(join(ROOT, "video/clips"), { recursive: true });
      ff([
        "-ss",
        meta.start.toFixed(3),
        "-i",
        meta.path,
        "-t",
        tl.dur.toFixed(3),
        "-vf",
        "fps=30",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        "-an",
        clip,
      ]);
      writeFileSync(
        clip.replace(/\.mp4$/, ".json"),
        JSON.stringify(
          {
            recorded: new Date().toISOString(),
            wallet: env.wallet.account.address,
            rpc: env.wallet.rpc,
            transactions: env.wallet.sent,
            duration: tl.dur,
            lines: tl.lines.map((l) => [Number(l.start.toFixed(2)), l.text]),
          },
          null,
          1,
        ) + "\n",
      );
      srcs[srcs.length - 1] = { path: clip, start: 0 };
      log(`  saved ${s.clip}; transactions: ${env.wallet.sent.join(", ")}`);
    }
  }

  // ---------------------------------------------------------------- assemble
  log("assemble");
  const seg = join(WORK, "seg");
  rmSync(seg, { recursive: true, force: true });
  mkdirSync(seg, { recursive: true });
  const files = scenes.map((s, i) => {
    const out = join(seg, `${String(i).padStart(2, "0")}-${s.id}.mp4`);
    segment(s, tls[i], srcs[i], out);
    return out;
  });
  concatList(files, join(seg, "list.txt"));
  const joined = join(WORK, "joined.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", join(seg, "list.txt"), "-c", "copy", joined]);
  const states = captionStates(scenes, tls);
  await renderCaptions(browser, states, join(WORK, "captions"));
  await browser.close();

  const total2 = tls.reduce((a, t) => a + t.dur, 0);
  const out = PREVIEW
    ? {
        narrated: "../../video/.out/preview.mp4",
        srt: "../../video/.out/preview.srt",
        poster: "../../video/.out/preview.png",
      }
    : def.outputs;
  const picture = join(WORK, "picture.mp4");
  finalVideo(joined, states, WORK, picture, def.crf ?? 23);
  const wav = mixAudio(tls, total2, WORK, def.music ?? null);
  // a video may open with a recorded intro (the pitch: the founder's own clip, video/founder.mjs)
  const intro = def.intro && !PREVIEW ? await def.intro() : null;
  if (intro) {
    const body = join(WORK, "body.mp4");
    mux(picture, wav, body);
    prependIntro(intro, body, join(MEDIA, out.narrated));
    log(`  opens with ${intro.path.replace(ROOT + "/", "")} (${intro.duration.toFixed(1)} s)`);
  } else mux(picture, wav, join(MEDIA, out.narrated));
  if (out.silent) copyFileSync(picture, join(MEDIA, out.silent));
  const s = srt(tls);
  writeFileSync(
    join(MEDIA, out.srt),
    intro ? srtText([...intro.cues, ...shiftCues(s.cues, intro.duration)]) : s.text,
  );
  writeFileSync(
    join(WORK, "script.txt"),
    tls.map((t) => t.lines.map((l) => l.text.replace(/\s*\|\s*/g, " ")).join(" ")).join("\n\n") + "\n",
  );
  if (out.transcript) copyFileSync(join(WORK, "script.txt"), join(MEDIA, out.transcript));
  // poster: a clean frame (no captions) of the chosen scene
  const pi = Math.max(
    0,
    scenes.findIndex((x) => x.id === def.poster.scene),
  );
  ff([
    "-ss",
    String(PREVIEW ? 1 : (def.poster.at ?? tls[pi].dur / 2)),
    "-i",
    files[pi],
    "-frames:v",
    "1",
    join(MEDIA, out.poster),
  ]);
  if (out.gif) {
    const pal = join(WORK, "palette.png");
    const src = join(MEDIA, out.silent);
    const gf = "fps=10,scale=960:-1:flags=lanczos";
    // 12 s from the start of def.gifScene (the opening by default)
    const gi = def.gifScene ? scenes.findIndex((x) => x.id === def.gifScene) : 0;
    const gs = String(Math.max(0, gi >= 0 ? tls[gi].start + 0.5 : 0));
    ff(["-ss", gs, "-t", "12", "-i", src, "-vf", `${gf},palettegen=max_colors=128:stats_mode=diff`, pal]);
    ff([
      "-ss",
      gs,
      "-t",
      "12",
      "-i",
      src,
      "-i",
      pal,
      "-lavfi",
      `${gf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      join(MEDIA, out.gif),
    ]);
  }
  if (PREVIEW) return log(`preview: video/.out/preview.mp4, ${total2.toFixed(1)} s`);
  if (def.scriptDoc)
    writeFileSync(join(ROOT, def.scriptDoc.path), scriptDoc(def.scriptDoc, scenes, tls, total, nw, intro));
  writeFileSync(
    join(WORK, "report.json"),
    JSON.stringify(
      {
        total,
        words: nw,
        wpm: (nw / total) * 60,
        scenes: tls.map((t) => ({ id: t.id, start: t.start, dur: t.dur })),
      },
      null,
      1,
    ),
  );
  for (const k of Object.values(out)) if (existsSync(join(MEDIA, k))) log(`${k}  ${mb(join(MEDIA, k))}`);
  log(
    `duration ${(total + (intro?.duration ?? 0)).toFixed(1)} s${intro ? ` (intro ${intro.duration.toFixed(1)} s)` : ""}, ${nw} words, ${((nw / total) * 60).toFixed(0)} wpm`,
  );
}

/** The intro's first `duration` seconds, then the rendered body; one encode, 30 fps, AAC 48 kHz stereo, a -2 dB
 *  limiter so the joined, re-encoded audio stays under -1.5 dBTP. */
function prependIntro(intro, body, out) {
  const norm = (i) =>
    `[${i}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`;
  ff([
    "-t",
    intro.duration.toFixed(3),
    "-i",
    intro.path,
    "-i",
    body,
    "-filter_complex",
    `${norm(0)};${norm(1)};[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][ac];[ac]alimiter=limit=0.79:attack=5:release=60:level=disabled[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
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
    "160k",
    "-movflags",
    "+faststart",
    out,
  ]);
}

const shiftCues = (cues, by) => cues.map((c) => ({ ...c, from: c.from + by, to: c.to + by }));
function srtText(cues) {
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${wrap2(c.text).join("\n")}\n`)
    .join("\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
