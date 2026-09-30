"""Place narration takes on a timeline and write one loudness-normalised track.

usage: python3 mix.py plan.json out.wav
plan.json: {"duration": seconds, "clips": [{"path": "<24 kHz take>", "t": start_seconds}, ...]}
Each take gets 20 ms fades and is resampled to 48 kHz; the whole programme is then normalised to -16 LUFS integrated
and passed through a -1.5 dBTP brick-wall limiter. Prints the measured loudness.
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
tmp = sys.argv[2] + ".raw.wav"
sf.write(tmp, total, SR, subtype="FLOAT")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-af", "alimiter=limit=0.84:attack=2:release=50:level=disabled",
                "-c:a", "pcm_s16le", sys.argv[2]], check=True)
os.remove(tmp)
y, _ = sf.read(sys.argv[2], dtype="float32")
print(f"loudness {meter.integrated_loudness(y):.2f} LUFS, peak {20 * np.log10(np.abs(y).max() + 1e-9):.2f} dBFS")
