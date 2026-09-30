"""Chatterbox narration synthesiser with caching and best-of-N selection.

usage: python3 synth.py job.json out.json
job.json: {"settings": {...}, "items": [{"id": "s01", "lines": [[display, tts], ...]}, ...]}
Each [display, tts] pair is one sentence. The tts string is what Chatterbox reads (numbers spelled out);
the display string is the reference the Whisper transcript is compared against.
Writes one trimmed 24 kHz wav per sentence to tts/cache/<hash>.wav and reports duration, transcript, score.
"""
import hashlib, json, os, re, sys, difflib, warnings, contextlib, io
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, torch, librosa

job = json.load(open(sys.argv[1]))
S = {"exaggeration": 0.45, "cfg_weight": 0.5, "temperature": 0.7, "seeds": [11, 23, 37], "min_score": 0.86}
S.update(job.get("settings", {}))
CACHE = "tts/cache"; os.makedirs(CACHE, exist_ok=True)

def norm(t):
    t = t.lower().replace("-", " ")
    t = re.sub(r"[^a-z0-9. ]", " ", t)
    t = re.sub(r"(?<![0-9])\.|\.(?![0-9])", " ", t)
    return re.sub(r"\s+", " ", t).strip()

def score(ref, hyp):
    return difflib.SequenceMatcher(None, norm(ref).split(), norm(hyp).split()).ratio()

_tts = None
def tts():
    global _tts
    if _tts is None:
        from chatterbox.tts import ChatterboxTTS
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                _tts = ChatterboxTTS.from_pretrained(device="cuda")
            except torch.cuda.OutOfMemoryError:
                _tts = ChatterboxTTS.from_pretrained(device="cpu")
    return _tts

_asr = None
def asr(path):
    global _asr
    if _asr is None:
        from faster_whisper import WhisperModel
        _asr = WhisperModel("base.en", device="cpu", compute_type="int8")
    segs, _ = _asr.transcribe(path, beam_size=5, language="en")
    return " ".join(s.text.strip() for s in segs)

def gen(text, seed):
    key = hashlib.sha1(json.dumps([text, seed, S["exaggeration"], S["cfg_weight"], S["temperature"]]).encode()).hexdigest()[:16]
    path = f"{CACHE}/{key}.wav"
    if not os.path.exists(path):
        m = tts()
        torch.manual_seed(seed)
        with contextlib.redirect_stderr(io.StringIO()):
            w = m.generate(text, exaggeration=S["exaggeration"], cfg_weight=S["cfg_weight"], temperature=S["temperature"])
        w = w.squeeze(0).numpy().astype(np.float32)
        _, (a, b) = librosa.effects.trim(w, top_db=40, frame_length=1024, hop_length=256)
        pad = int(0.03 * m.sr)
        w = w[max(0, a - pad): min(len(w), b + pad)]
        sf.write(path, w, m.sr, subtype="FLOAT")
    info = sf.info(path)
    return path, info.frames / info.samplerate

out = {}
for it in job["items"]:
    res = []
    for line in it["lines"]:
        disp, text = line[0], line[1]
        seeds = line[2] if len(line) > 2 else S["seeds"]  # optional per-sentence seeds for a cleaner take
        cands = []
        for seed in seeds:
            p, d = gen(text, seed)
            hyp = asr(p)
            sc = score(disp, hyp)
            # a runaway generation shows as far too long for the text: penalise it
            rate = len(text) / max(d, 0.1)
            cands.append({"path": p, "dur": round(d, 3), "asr": hyp, "score": round(sc, 3), "cps": round(rate, 1), "seed": seed})
            if sc >= S["min_score"] and len(cands) >= S.get("min_cands", 2):
                break
        ok = [c for c in cands if 9 <= c["cps"] <= 22] or cands
        best = max(ok, key=lambda c: (round(c["score"], 2), -c["dur"]))
        res.append({"display": disp, "tts": text, **best, "alts": len(cands)})
        print(f'{it["id"]} {best["dur"]:5.2f}s sc={best["score"]:.2f} cps={best["cps"]} | {best["asr"]}', flush=True)
    out[it["id"]] = res
json.dump(out, open(sys.argv[2], "w"), indent=1)
