"""Check a rendered video against its script: Whisper transcript, pace, word match and the risky words.

usage: python3 check.py video.mp4 script.txt [must-hear words, comma separated]
Prints words per minute (Whisper words / video length), the word-level match with the script, each must-hear phrase
found or MISSING, and writes <video>.transcript.txt next to the script.
"""
import sys, re, difflib, subprocess, json, os, warnings
warnings.filterwarnings("ignore")
from faster_whisper import WhisperModel

video, script = sys.argv[1], sys.argv[2]
must = [m.strip() for m in (sys.argv[3] if len(sys.argv) > 3 else "").split(",") if m.strip()]
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                           capture_output=True, text=True).stdout)
m = WhisperModel("small.en", device="cpu", compute_type="int8")
segs, _ = m.transcribe(video, beam_size=5, language="en")
segs = list(segs)
text = " ".join(s.text.strip() for s in segs)

def norm(t):
    t = t.lower().replace("-", " ").replace("%", " percent").replace("$", "").replace("×", " times")
    t = re.sub(r"(?<=\d),(?=\d)", "", t)
    t = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", t).replace("robin hood", "robinhood")
    t = re.sub(r"[^a-z0-9. ]", " ", t)
    t = re.sub(r"(?<![0-9])\.|\.(?![0-9])", " ", t)
    return t.split()

ref = open(script).read()
a, b = norm(ref), norm(text)
ratio = difflib.SequenceMatcher(None, a, b).ratio()
out = os.path.splitext(script)[0] + ".transcript.txt"
with open(out, "w") as fh:
    for s in segs:
        fh.write(f"[{s.start:6.1f}-{s.end:6.1f}] {s.text.strip()}\n")
print(f"duration {dur:.1f} s, Whisper words {len(text.split())}, {len(text.split()) / dur * 60:.0f} wpm; script words {len(ref.split())}")
print(f"word match with the script: {ratio:.3f}")
hay = " ".join(b)
for w in must:
    print(f"  {'ok     ' if ' '.join(norm(w)) in hay else 'MISSING'} {w}")
sm = difflib.SequenceMatcher(None, a, b)
for op, i1, i2, j1, j2 in sm.get_opcodes():
    if op != "equal":
        print(f"  {op:8s} script: {' '.join(a[i1:i2])!r:50s} heard: {' '.join(b[j1:j2])!r}")
print(f"transcript: {out}")
