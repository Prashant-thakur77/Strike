"""Place narration takes on a timeline and write one loudness-normalised track.

usage: python3 mix.py plan.json out.wav
plan.json: {"duration": seconds, "clips": [{"path": "<24 kHz take>", "t": start_seconds}, ...],
            "music": {"path": "<48 kHz stereo bed>", "speech_lufs": -31, "gap_db": 5, "fade_in": 2, "fade_out": 3}}
Each take gets 20 ms fades and is resampled to 48 kHz; the voice is normalised to -16 LUFS. With "music", the bed is
set to `speech_lufs` while the voice speaks and ducked up by `gap_db` in the gaps (a side-chain envelope from the
voice: 150 ms down, 900 ms back up), with fades at both ends. The stereo programme is normalised to -16 LUFS
integrated and passed through a -1.5 dBFS limiter. Writes 16-bit stereo; prints the measured loudness and peak.
"""
import json, subprocess, sys, os, warnings
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, pyloudnorm as pyln, librosa

plan = json.load(open(sys.argv[1]))
SR = 48000
total = np.zeros(int(plan["duration"] * SR) + SR, dtype=np.float32)
f = int(0.02 * SR)
ramp = np.sin(np.linspace(0, np.pi / 2, f)) ** 2
meter = pyln.Meter(SR)
for c in plan["clips"]:
    y, sr = sf.read(c["path"], dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = librosa.resample(y, orig_sr=sr, target_sr=SR).astype(np.float32)
    y = pyln.normalize.loudness(y, meter.integrated_loudness(y), -16.0).astype(np.float32)
    y[:f] *= ramp; y[-f:] *= ramp[::-1]
    a = int(round(c["t"] * SR))
    total[a:a + len(y)] += y[: max(0, len(total) - a)]
total = total[: int(plan["duration"] * SR)]
total = pyln.normalize.loudness(total, meter.integrated_loudness(total), -16.0).astype(np.float32)
mix = np.stack([total, total], axis=1)
mus = plan.get("music")
if mus:
    from scipy.ndimage import maximum_filter1d
    m, msr = sf.read(mus["path"], dtype="float32", always_2d=True)
    if msr != SR:
        m = librosa.resample(m.T, orig_sr=msr, target_sr=SR).T
    if m.shape[1] == 1:
        m = np.repeat(m, 2, axis=1)
    N = len(total)
    if len(m) < N:
        raise SystemExit(f"music bed is {len(m) / SR:.1f} s, the programme {N / SR:.1f} s")
    m = m[:N].astype(np.float64)
    # bed level while speaking
    m *= 10 ** ((mus.get("speech_lufs", -31) - meter.integrated_loudness(m)) / 20)
    # side-chain: voice activity per 10 ms hop, widened a little each side, then smoothed
    hop = SR // 100
    frames = np.abs(total[: N // hop * hop]).reshape(-1, hop).max(axis=1)
    active = (frames > 10 ** (-40 / 20)).astype(np.float64)
    active = maximum_filter1d(active, size=61, origin=15)  # from 0.15 s before the voice to 0.45 s after
    target = np.where(active > 0, 0.0, mus.get("gap_db", 5.0))
    g = np.empty_like(target)
    cur = target[0]
    for i, x in enumerate(target):
        k = 1 - np.exp(-0.01 / (0.15 if x < cur else 0.9))
        cur += (x - cur) * k
        g[i] = cur
    gain = 10 ** (np.repeat(g, hop) / 20)
    gain = np.concatenate([gain, np.full(N - len(gain), gain[-1])])
    fi, fo = int(mus.get("fade_in", 2) * SR), int(mus.get("fade_out", 3) * SR)
    gain[:fi] *= np.linspace(0, 1, fi)
    gain[-fo:] *= np.linspace(1, 0, fo)
    mix = mix + (m * gain[:, None]).astype(np.float32)
    mix = pyln.normalize.loudness(mix, meter.integrated_loudness(mix), -16.0).astype(np.float32)
tmp = sys.argv[2] + ".raw.wav"
sf.write(tmp, mix, SR, subtype="FLOAT")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-af", "alimiter=limit=0.84:attack=2:release=50:level=disabled",
                "-c:a", "pcm_s16le", sys.argv[2]], check=True)
os.remove(tmp)
y, _ = sf.read(sys.argv[2], dtype="float32")
print(f"loudness {meter.integrated_loudness(y):.2f} LUFS, peak {20 * np.log10(np.abs(y).max() + 1e-9):.2f} dBFS, {y.shape[1] if y.ndim > 1 else 1} ch")
