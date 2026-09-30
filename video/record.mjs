#!/usr/bin/env node
// Renders the demo and pitch videos from their scene lists:
//
//   node video/record.mjs demo       # video/demo.mjs  -> docs/media/strike-demo.mp4 (captions only),
//                                    #   strike-demo-narrated.mp4, strike-demo.srt, -poster.png, .gif, -narration.txt
//   node video/record.mjs pitch      # video/pitch.mjs -> docs/media/strike-pitch.mp4, strike-pitch.srt, -poster.png
//
// Options: --only a,b (re-record only these scenes; the others reuse their recordings in video/.out if the timing
// did not change), --plan (narrate and print the timing, record nothing), --live-sign (record the wallet-signing
// scene for real with the throwaway key in video/.out/wallet/key.json and save it to video/clips/).
//
// Needs: Node 22+, `pnpm install` (Playwright from app/), ffmpeg, and Python 3.10 with chatterbox-tts,
// faster-whisper, pyloudnorm, librosa and soundfile (video/narration). The app is the live site unless APP_URL is
// set. Numbers are read from README.md at render time (video/lib/facts.mjs).
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
  writeFileSync,
} from "./lib/engine.mjs";
import { readmeFacts } from "./lib/facts.mjs";

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
function scriptDoc(doc, scenes, tls, total, words) {
  const parts = [doc.head({ total, words, wpm: Math.round((words / total) * 60), mmss })];
  scenes.forEach((s, i) => {
    const tl = tls[i];
    parts.push(`## ${mmss(tl.start)} to ${mmss(tl.start + tl.dur)} · ${s.title ?? s.tag}`);
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
  const browser = await chromium.launch();
  const env = { EXPLORER: "https://explorer.testnet.chain.robinhood.com", epoch: epochLog(), facts };
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

  const narr = narrate(scenes, WORK, SETTINGS);
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
    if (s.kind === "clip" && !LIVE_SIGN) {
      srcs.push({ path: join(ROOT, s.clip), start: 0 });
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
  const wav = mixAudio(tls, total2, WORK);
  mux(picture, wav, join(MEDIA, out.narrated));
  if (out.silent) copyFileSync(picture, join(MEDIA, out.silent));
  const s = srt(tls);
  writeFileSync(join(MEDIA, out.srt), s.text);
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
    ff(["-t", "12", "-i", src, "-vf", `${gf},palettegen=max_colors=128:stats_mode=diff`, pal]);
    ff([
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
    writeFileSync(join(ROOT, def.scriptDoc.path), scriptDoc(def.scriptDoc, scenes, tls, total, nw));
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
  log(`duration ${total.toFixed(1)} s, ${nw} words, ${((nw / total) * 60).toFixed(0)} wpm`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
