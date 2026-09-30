"""Build the pitch video: timeline, narration track, caption frames list, SRT, then the video.

usage: python3 build_pitch.py plan     -> pitch/frames.json, pitch/narration.wav, strike-pitch.srt, pitch/timeline.json
       python3 build_pitch.py video    -> docs/media/strike-pitch.mp4 (after node render_slides.mjs pitch/frames.json)
"""
import json, os, subprocess, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, pyloudnorm as pyln, librosa
from pitch_lines import SLIDES

MEDIA = "/home/prashant/projects/strike/docs/media"
LEAD, TAIL, GAP, XF, SILENT, END_HOLD = 0.3, 0.45, 0.2, 0.3, 3.0, 1.0
SKIP = {"users"}  # not in the pitch script; skipped to keep the video under 2:00
SR_IN, SR, FADE, TARGET = 24000, 48000, 0.15, -16.0
order = json.load(open("/tmp/claude-1000/-home-prashant-projects-protocol-monorepo-main/68215a13-3f30-42ad-8faa-6d807a26a9ec/scratchpad/deck-all/project/deck.json"))["order"]
assert [s for s, _, _ in SLIDES] == order, "pitch_lines must follow deck.json order"

def srt_ts(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def plan():
    syn = json.load(open("pitch_out.json"))
    slides = [x for x in SLIDES if x[0] not in SKIP]
    tl, off = [], 0.0
    for n, (sid, tag, lines) in enumerate(slides):
        sents = syn.get(sid, [])
        wavs = [sf.read(s["path"], dtype="float32")[0] for s in sents]
        speech = sum(len(w) for w in wavs) / SR_IN + GAP * max(0, len(wavs) - 1)
        tail = END_HOLD if n == len(slides) - 1 else TAIL
        dur = LEAD + speech + tail if wavs else SILENT
        tl.append({"slide": sid, "tag": tag, "start": off, "dur": dur, "sents": sents, "wavs": wavs})
        off += dur - XF
    total = tl[-1]["start"] + tl[-1]["dur"]
    audio = np.zeros(int(total * SR) + SR, np.float32)
    meter = pyln.Meter(SR)
    frames, cues = [], []
    for n, s in enumerate(tl):
        if not s["wavs"]:
            frames.append({"slide": s["slide"], "out": f"pitch/frames/{n:02d}_{s['slide']}_0.png", "hold": s["dur"]})
            continue
        parts, t, marks = [], 0.0, []
        for i, w in enumerate(s["wavs"]):
            marks.append((t, t + len(w) / SR_IN)); parts.append(w); t += len(w) / SR_IN
            if i < len(s["wavs"]) - 1:
                parts.append(np.zeros(int(GAP * SR_IN), np.float32)); t += GAP
        y = librosa.resample(np.concatenate(parts), orig_sr=SR_IN, target_sr=SR).astype(np.float32)
        y = pyln.normalize.loudness(y, meter.integrated_loudness(y), TARGET).astype(np.float32)
        clip = np.concatenate([np.zeros(int(0.15 * SR), np.float32), y, np.zeros(int(0.15 * SR), np.float32)])
        f = int(FADE * SR); ramp = np.sin(np.linspace(0, np.pi / 2, f)) ** 2
        clip[:f] *= ramp; clip[-f:] *= ramp[::-1]
        a = int((s["start"] + LEAD - 0.15) * SR)
        audio[a:a + len(clip)] += clip
        # captions: each sentence shows from just before it is spoken until the next one (or the slide's end)
        starts = [0.0] + [LEAD + m0 - 0.12 for m0, _ in marks[1:]]
        for i, (sent, (m0, m1)) in enumerate(zip(s["sents"], marks)):
            hold = (starts[i + 1] if i + 1 < len(starts) else s["dur"]) - starts[i]
            frames.append({"slide": s["slide"], "out": f"pitch/frames/{n:02d}_{s['slide']}_{i}.png",
                           "caption": sent["display"], "tag": s["tag"], "hold": round(hold, 3)})
            cues.append((s["start"] + LEAD + m0, s["start"] + LEAD + m1, sent["display"]))
    audio = audio[: int(total * SR)]
    sf.write("pitch/raw.wav", audio, SR, subtype="FLOAT")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", "pitch/raw.wav", "-af",
                    "alimiter=limit=0.80:attack=2:release=50:level=disabled", "-c:a", "pcm_s16le", "pitch/narration.wav"], check=True)
    os.remove("pitch/raw.wav")
    os.makedirs("pitch/frames", exist_ok=True)
    json.dump(frames, open("pitch/frames.json", "w"), indent=1)
    json.dump([{k: v for k, v in s.items() if k not in ("wavs", "sents")} for s in tl], open("pitch/timeline.json", "w"), indent=1)
    with open(f"{MEDIA}/strike-pitch.srt", "w") as fh:
        for i, (a, b, txt) in enumerate(cues, 1):
            fh.write(f"{i}\n{srt_ts(a)} --> {srt_ts(b)}\n{txt}\n\n")
    for s in tl:
        print(f"{s['slide']:12s} start={s['start']:6.2f} dur={s['dur']:5.2f}")
    print(f"total {total:.2f}s, {len(cues)} cues")

def video():
    frames = json.load(open("pitch/frames.json"))
    tl = json.load(open("pitch/timeline.json"))
    os.makedirs("pitch/seg", exist_ok=True)
    segs = []
    for n, s in enumerate(tl):
        fl = [f for f in frames if f["out"].startswith(f"pitch/frames/{n:02d}_")]
        lst = f"pitch/seg/{n:02d}.txt"
        with open(lst, "w") as fh:
            for f in fl:
                fh.write(f"file '{os.path.abspath(f['out'])}'\nduration {f['hold']:.3f}\n")
            fh.write(f"file '{os.path.abspath(fl[-1]['out'])}'\n")
        out = f"pitch/seg/{n:02d}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-vf", "fps=30,format=yuv420p",
                        "-t", f"{s['dur']:.3f}", "-c:v", "libx264", "-crf", "12", "-preset", "fast", out], check=True)
        segs.append(out)
    inputs, fg, prev = [], [], "[0:v]"
    for sgm in segs:
        inputs += ["-i", sgm]
    for n in range(1, len(segs)):
        off = tl[n]["start"]
        lab = f"[v{n}]"
        fg.append(f"{prev}[{n}:v]xfade=transition=fade:duration={XF}:offset={off:.3f}{lab}")
        prev = lab
    total = tl[-1]["start"] + tl[-1]["dur"]
    cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-i", "pitch/narration.wav", "-filter_complex", ";".join(fg),
           "-map", prev, "-map", f"{len(segs)}:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-tune", "stillimage",
           "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", f"{total:.3f}",
           "-movflags", "+faststart", f"{MEDIA}/strike-pitch.mp4"]
    subprocess.run(cmd, check=True)

{"plan": plan, "video": video}[sys.argv[1]]()
