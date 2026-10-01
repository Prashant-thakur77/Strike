# Media credits

What the videos in this folder use that the project did not write itself, and under which licence.

## Music

| Track                                                                                                   | Source                                                                                                                                                                  | Licence                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| "Strike ambient bed" (soft pads in D major, sine sub-bass, a sparse plucked arpeggio, synthetic reverb) | Synthesised at render time by [`video/narration/music.py`](../../video/narration/music.py), seed 7, from sine waves and filtered noise; no samples or third-party audio | Original work of this project, dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The bed sits about 15 dB under the voice (−31 LUFS while the narrator speaks, 5 dB higher in pauses), with a 2 s fade-in and a 3 s fade-out; the mix is −16 LUFS integrated with peaks under −1 dBFS ([`video/narration/mix.py`](../../video/narration/mix.py)).

## Voice

Chatterbox TTS ([resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox), MIT licence), run locally, with the synthetic reference voice in [`video/narration/voice-ref.wav`](../../video/narration/voice-ref.wav).

## Stock footage (demo, "The problem")

All clips are from [Pexels](https://www.pexels.com) under the [Pexels License](https://www.pexels.com/license/): free to use and modify, attribution not required. We credit them anyway. They were downloaded from each clip's page with [`video/footage.mjs`](../../video/footage.mjs) (list: [`video/footage.json`](../../video/footage.json)) and are not stored in the repository.

| Clip    | Pexels page                                                                                                                                        | Used for                            | Licence        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------- |
| floor   | [finance-nyse-wall-street-new-york-city-4319342](https://www.pexels.com/video/finance-nyse-wall-street-new-york-city-4319342/)                     | Millions of people own stocks       | Pexels License |
| phone   | [person-using-stock-market-app-7578628](https://www.pexels.com/video/person-using-stock-market-app-7578628/)                                       | they can now hold them as tokens    | Pexels License |
| idle    | [analyzing-cryptocurrency-charts-on-smartphone-34953965](https://www.pexels.com/video/analyzing-cryptocurrency-charts-on-smartphone-34953965/)     | a token earns nothing while it sits | Pexels License |
| screens | [a-man-in-corporate-attire-talking-on-the-phone-4993130](https://www.pexels.com/video/a-man-in-corporate-attire-talking-on-the-phone-4993130/)     | On Wall Street                      | Pexels License |
| chart   | [close-up-video-of-a-paper-7580445](https://www.pexels.com/video/close-up-video-of-a-paper-7580445/)                                               | someone has to pick the strike      | Pexels License |
| worried | [business-man-removing-his-eyeglasses-8425703](https://www.pexels.com/video/business-man-removing-his-eyeglasses-8425703/)                         | trust them with your shares         | Pexels License |
| ticker  | [close-up-of-numbers-on-display-monitor-7578632](https://www.pexels.com/video/close-up-of-numbers-on-display-monitor-7578632/)                     | On-chain, it is harder still        | Pexels License |
| candles | [dynamic-stock-market-trading-screen-with-charts-38222819](https://www.pexels.com/video/dynamic-stock-market-trading-screen-with-charts-38222819/) | prices that freeze on weekends      | Pexels License |
| waiting | [close-up-view-of-man-looking-stressed-7535068](https://www.pexels.com/video/close-up-view-of-man-looking-stressed-7535068/)                       | the tokens sit idle                 | Pexels License |

## Everything else

The app pages, explorer pages (Robinhood Chain explorer, Arbiscan), terminal replays, cards and 3D scenes (three.js, MIT licence, loaded from cdnjs) are screen recordings and renders made by the pipeline in [`video/`](../../video/).
