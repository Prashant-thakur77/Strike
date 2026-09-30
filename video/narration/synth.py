"""Chatterbox narration synthesiser with caching and best-of-N selection by Whisper.

usage: python3 synth.py job.json out.json
job.json: {"settings": {...}, "items": [{"id": "hook", "lines": [[display, tts, seeds?], ...]}, ...]}
Each [display, tts] pair is one sentence. The tts string is what Chatterbox reads (numbers spelled out, risky words
respelled); the display string is the caption, and the Whisper transcript of each take is scored against it.
Writes one trimmed 24 kHz wav per take to <cache>/<hash>.wav and prints duration, transcript and score.

settings: voice (reference wav for Chatterbox's voice cloning; None = its built-in voice), exaggeration, cfg_weight,
temperature, seeds, min_score, min_cands, cache, asr_model, target_cps and max_cps (characters of the tts text per
second: a take above max_cps is slowed with Rubber Band, by at most 12%).
"""
import hashlib, json, os, re, sys, difflib, warnings, contextlib, io, subprocess
warnings.filterwarnings("ignore")
import numpy as np, soundfile as sf, torch, librosa

job = json.load(open(sys.argv[1]))
S = {"voice": None, "exaggeration": 0.35, "cfg_weight": 0.3, "temperature": 0.7, "seeds": [11, 23, 37],
     "min_score": 0.9, "min_cands": 2, "target_cps": 14.5, "max_cps": 15.5, "cache": "tts/cache", "asr_model": "small.en"}
S.update(job.get("settings", {}))
CACHE = S["cache"]; os.makedirs(CACHE, exist_ok=True)
VOICE = os.path.expanduser(S["voice"]) if S["voice"] else None
VOICE_ID = hashlib.sha1(open(VOICE, "rb").read()).hexdigest()[:12] if VOICE else "builtin"

NUM = {"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
       "eight": "8", "nine": "9", "ten": "10"}

def norm(t):
    t = t.lower().replace("-", " ").replace("%", " percent").replace("$", "").replace("×", " times")
    t = re.sub(r"(?<=\d),(?=\d)", "", t)
    t = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", t).replace("robin hood", "robinhood")
    t = re.sub(r"[^a-z0-9. ]", " ", t)
    t = re.sub(r"(?<![0-9])\.|\.(?![0-9])", " ", t)
    return " ".join(NUM.get(w, w) for w in t.split())

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
        _asr = WhisperModel(S["asr_model"], device="cpu", compute_type="int8")
    segs, _ = _asr.transcribe(path, beam_size=5, language="en")
    return " ".join(s.text.strip() for s in segs)

def gen(text, seed):
    key = hashlib.sha1(json.dumps([text, seed, S["exaggeration"], S["cfg_weight"], S["temperature"], VOICE_ID]).encode()).hexdigest()[:16]
    path = f"{CACHE}/{key}.wav"
    if not os.path.exists(path):
        m = tts()
        torch.manual_seed(seed)
        kw = dict(exaggeration=S["exaggeration"], cfg_weight=S["cfg_weight"], temperature=S["temperature"])
        if VOICE:
            kw["audio_prompt_path"] = VOICE
        with contextlib.redirect_stderr(io.StringIO()):
            w = m.generate(text, **kw)
        w = w.squeeze(0).numpy().astype(np.float32)
        _, (a, b) = librosa.effects.trim(w, top_db=40, frame_length=1024, hop_length=256)
        pad = int(0.03 * m.sr)
        w = w[max(0, a - pad): min(len(w), b + pad)]
        sf.write(path, w, m.sr, subtype="FLOAT")
    info = sf.info(path)
    return path, info.frames / info.samplerate

asr_cache_path = f"{CACHE}/asr.json"
asr_cache = json.load(open(asr_cache_path)) if os.path.exists(asr_cache_path) else {}

out = {}
for it in job["items"]:
    res = []
    for line in it["lines"]:
        disp, text = line[0], line[1]
        seeds = line[2] if len(line) > 2 and line[2] else S["seeds"]  # optional per-sentence seeds for a cleaner take
        cands = []
        for seed in seeds:
            p, d = gen(text, seed)
            k = f'{os.path.basename(p)}:{S["asr_model"]}'
            if k not in asr_cache:
                asr_cache[k] = asr(p)
                json.dump(asr_cache, open(asr_cache_path, "w"), indent=0)
            hyp = asr_cache[k]
            sc = score(disp, hyp)
            # a runaway generation shows as far too long for the text: penalise it
            rate = len(text) / max(d, 0.1)
            cands.append({"path": os.path.abspath(p), "dur": round(d, 3), "asr": hyp, "score": round(sc, 3), "cps": round(rate, 1), "seed": seed})
            if sc >= S["min_score"] and len(cands) >= S["min_cands"]:
                break
        ok = [c for c in cands if 9 <= c["cps"] <= 22] or cands
        # best transcript first; among equals, the calmest take (closest to the target pace)
        best = max(ok, key=lambda c: (round(c["score"], 2), -abs(c["cps"] - S["target_cps"])))
        best = dict(best)
        if best["cps"] > S["max_cps"]:
            # still too quick: slow it down with Rubber Band (formants kept), at most 12%
            tempo = max(0.88, S["max_cps"] / best["cps"])
            slow = best["path"].replace(".wav", f"_t{tempo:.3f}.wav")
            if not os.path.exists(slow):
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", best["path"], "-af", f"rubberband=tempo={tempo:.4f}:formant=preserved",
                                "-c:a", "pcm_f32le", slow], check=True)
            best["path"], best["dur"], best["cps"] = slow, round(best["dur"] / tempo, 3), round(best["cps"] * tempo, 1)
        # silent gaps inside the take (>= 0.12 s): caption chunk boundaries snap to them
        y, sr = sf.read(best["path"], dtype="float32")
        iv = librosa.effects.split(y, top_db=32, frame_length=1024, hop_length=256)
        pauses = [[round(a / sr, 3), round(b / sr, 3)] for (_, a), (b, _) in zip(iv[:-1], iv[1:]) if (b - a) / sr >= 0.12]
        res.append({"display": disp, "tts": text, **best, "pauses": pauses, "alts": len(cands)})
        print(f'{it["id"]} {best["dur"]:5.2f}s sc={best["score"]:.2f} cps={best["cps"]} | {best["asr"]}', flush=True)
    out[it["id"]] = res
json.dump(out, open(sys.argv[2], "w"), indent=1)
