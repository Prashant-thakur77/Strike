// The opening hook of both videos: a question to the people Strike is for (holders of stock tokens who want income
// without trusting a manager), then the answer. Big kinetic type in the site's typography, one beat per caption chunk;
// the scene has no caption bar because the words on screen are the words spoken.
import { L } from "./engine.mjs";

/** Each line's caption chunks are the beats; `accent` marks words (by index in the chunk) shown in mint. */
const BEATS = [
  { text: "Own stock tokens", accent: [1, 2] },
  { text: "that just sit in your wallet?", accent: [2] },
  { text: "What if they earned income every week,", accent: [4, 5, 6] },
  { text: "under rules the agent can't break?", accent: [4, 5] },
  { brand: true, pre: "That's" },
];

export function hookScene({ chapter = null } = {}) {
  return {
    id: "hook",
    ...(chapter ? { chapter } : {}),
    kind: "replay",
    bar: false,
    tag: "Strike",
    screen:
      "Kinetic type on the site's dark teal: each phrase slams in word by word as it is said, key words in mint (stock tokens, sit, income every week, can't break), then the wordmark.",
    replay: { mode: "hook", beats: BEATS },
    lines: [
      L("Own stock tokens | that just sit in your wallet?"),
      L("What if they earned income every week, | under rules the agent can't break?"),
      L("That's Strike."),
    ],
    tail: 0.5,
    async run(h) {
      const chunks = h.tl.lines.flatMap((l) => l.chunks);
      if (chunks.length !== BEATS.length)
        throw new Error(`hook: ${chunks.length} chunks, ${BEATS.length} beats`);
      for (let i = 0; i < chunks.length; i++) {
        await h.at(Math.max(0, chunks[i].start - 0.12));
        await h.page.evaluate((k) => window.__hook.beat(k), i);
      }
    },
  };
}
