"""Place synthesized narration on a timeline.

usage: python3 assemble.py <plan.json> <synth_out.json> <out.wav> <timings.json>
plan.json: {"duration": total_seconds, "scenes": [{"id", "start", "end"}]}
Each scene's sentences are joined with a gap (0.12 to 0.35 s, spread to fill the window), sped up with
rubberband only if they still do not fit (never above 1.10x), normalised to -16 LUFS, given 150 ms fades
and placed at the scene start, so no clip can cross into the next scene.
"""
import json, subprocess, sys, os, warnings
warnings.filterwarnings('ignore')
import numpy as np, soundfile as sf, pyloudnorm as pyln, librosa

plan = json.load(open(sys.argv[1])); syn = json.load(open(sys.argv[2]))
SR_IN, SR = 24000, 48000
LEAD, TAIL, FADE, TARGET = 0.12, 0.2, 0.15, -16.0
GMIN, GMAX = 0.12, 0.35
total = np.zeros(int(plan["duration"] * SR) + SR, dtype=np.float32)
meter = pyln.Meter(SR)
timings = []
for sc in plan["scenes"]:
    sents = syn[sc["id"]]
    wavs = [sf.read(s["path"], dtype="float32")[0] for s in sents]
    speech = sum(len(w) for w in wavs) / SR_IN
    avail = (sc["end"] - sc["start"]) - LEAD - TAIL
    n = len(wavs)
    gap = GMIN if n == 1 else min(GMAX, max(GMIN, (avail - speech) / (n - 1)))
    joined, marks, t = [], [], 0.0
    for i, w in enumerate(wavs):
        marks.append((t, t + len(w) / SR_IN)); joined.append(w); t += len(w) / SR_IN
        if i < n - 1:
            joined.append(np.zeros(int(gap * SR_IN), np.float32)); t += gap
    y = np.concatenate(joined)
    length = len(y) / SR_IN
    tempo = 1.0
    if length > avail:
        tempo = length / avail
        if tempo > 1.10:
            sys.exit(f"{sc['id']}: needs {tempo:.3f}x, shorten the text")
        src, dst = f"tmp_{sc['id']}_in.wav", f"tmp_{sc['id']}_out.wav"
        sf.write(src, y, SR_IN)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-af", f"rubberband=tempo={tempo:.5f}:formant=preserved", dst], check=True)
        y = sf.read(dst, dtype="float32")[0]; os.remove(src); os.remove(dst)
    y = librosa.resample(y, orig_sr=SR_IN, target_sr=SR).astype(np.float32)
    y = pyln.normalize.loudness(y, meter.integrated_loudness(y), TARGET).astype(np.float32)
    # a roomy scene starts a little later, so its slack is split between both ends instead of one long gap
    extra = avail - len(y) / SR
    shift = min(0.9, 0.4 * extra) if extra > 0.8 else 0.0
    lead = np.zeros(int((LEAD + shift) * SR), np.float32)
    clip = np.concatenate([lead, y, np.zeros(int(0.12 * SR), np.float32)])
    f = int(FADE * SR)
    ramp = np.sin(np.linspace(0, np.pi / 2, f)) ** 2
    clip[:f] *= ramp; clip[-f:] *= ramp[::-1]
    a = int(sc["start"] * SR)
    assert (len(clip) / SR) <= (sc["end"] - sc["start"]) + 1e-6, sc["id"]
    total[a:a + len(clip)] += clip
    for s, (m0, m1) in zip(sents, marks):
        timings.append({"scene": sc["id"], "start": round(sc["start"] + LEAD + shift + m0 / tempo, 2),
                        "end": round(sc["start"] + LEAD + shift + m1 / tempo, 2), "text": s["display"]})
    print(f"{sc['id']} shift={shift:.2f} speech={length:5.2f}s avail={avail:5.2f}s gap={gap:.2f} tempo={tempo:.3f} clip={len(clip)/SR:5.2f}s win={sc['end']-sc['start']:5.2f}s")
total = total[: int(plan["duration"] * SR)]
sf.write("tmp_raw.wav", total, SR, subtype="FLOAT")
# brick-wall limiter as a safety net for true peaks (speech is already at -16 LUFS)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", "tmp_raw.wav", "-af",
                "alimiter=limit=0.80:attack=2:release=50:level=disabled", "-c:a", "pcm_s16le", sys.argv[3]], check=True)
os.remove("tmp_raw.wav")
json.dump(timings, open(sys.argv[4], "w"), indent=1)
