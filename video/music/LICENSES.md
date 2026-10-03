# Music candidates: sources and licences

Candidate tracks for the videos, picked to match the music measured in the reference videos (see "Background music targets" in `.internal/docs/reference-videos.md`). None of them is used in a render yet. Add a track to [`docs/media/CREDITS.md`](../../docs/media/CREDITS.md) only when a render uses it.

Every track below is CC0 1.0 (public domain dedication): free to use in videos, commercially or not, with no fee and no attribution required. We credit them anyway. Licences were checked on 3 October 2026 on each OpenGameArt page (the page's licence field reads "CC0", and Holizna's pages also say "This music is public domain CC0, so use it how you want"). Downloads need no login.

**Rule:** never rip or reuse music from the reference videos, or from any video. It is almost always copyrighted. Also check that the uploader is the composer: OpenGameArt's "Progress" (josepharaoh99) was rejected because its page says "I DID NOT MAKE THIS!! This was composed by Tripcore".

| File                                                | Role                                    | Title · artist                                   | Source (licence page)                                                | Licence | Measured                                                              |
| --------------------------------------------------- | --------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| `hook-holizna-make-money.mp3`                       | Energetic hook and intro                | "Make Money" · HoliznaCC0 (Funk collection)      | https://opengameart.org/content/funk-collection                      | CC0 1.0 | 129 BPM, bright (centroid 1.9 kHz), busy (5.2 onsets/s), 3:44         |
| `hook-holizna-sleep.mp3`                            | Hook, alternative                       | "Sleep" · HoliznaCC0 (Funk collection)           | https://opengameart.org/content/funk-collection                      | CC0 1.0 | 117 BPM, mid (1.2 kHz), 3:18                                          |
| `bed-holizna-opinions.mp3`                          | Calm, confident bed under narration     | "Opinions" · HoliznaCC0 (Chill Beats)            | https://opengameart.org/content/chill-beats-collection               | CC0 1.0 | 81 BPM (Ramp-like half-time), light beat, soft keys (1.2 kHz), 2:48   |
| `bed-holizna-poor-but-happy.mp3`                    | Bed, alternative                        | "Poor, But Happy" · HoliznaCC0 (Happy Lo-Fi)     | https://opengameart.org/content/happy-lo-fi-lofi-collection          | CC0 1.0 | 89 BPM (the Claude computer-use tempo), dark and warm (0.6 kHz), 2:08 |
| `swell-antonioraymond71-rise-of-the-early-dawn.mp3` | Cinematic swell for the reveal or close | "Rise of the Early Dawn" · antonioraymond71      | https://opengameart.org/content/rise-of-the-early-dawn               | CC0 1.0 | Orchestral, no drums (percussive share 0.02), 1:42                    |
| `swell-nene-adventure-intro-title.wav`              | Short swell or end card                 | "Adventure Intro Title [Cinematic, Epic]" · nene | https://opengameart.org/content/adventure-intro-title-cinematic-epic | CC0 1.0 | 37 s, builds from silence, no drums                                   |

Measurements: librosa tempo (median onset tempo), harmonic/percussive split, spectral centroid and onset rate on the first 150 s. A CLAP zero-shot tagger heard the Holizna tracks as "lo-fi hip hop beat" (0.63–0.87) with "funk" or "upbeat corporate" second, the same tag it gave most reference beds. Nobody has listened to them yet: the owner should listen before choosing.

**Fallback:** [`../narration/music.py`](../narration/music.py) synthesises an original CC0 ambient bed locally (the current one). Pixabay Music (Pixabay Content License) is also fee-free, but its pages sit behind a Cloudflare check that blocks scripted downloads, so its tracks need a manual download in a browser.

SHA-256 (first 16 hex digits) of the files as downloaded: make-money 3f10f346e5ab4c4c, sleep 9980347d761c6923, opinions d17fb6c6fd6aa643, poor-but-happy 813e975208dfebca, rise-of-the-early-dawn 7fe65bcf3caca704, adventure-intro-title 28249188861c9c75.
