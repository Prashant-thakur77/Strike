// The 2-minute pitch: slides from the deck (video/deck, copied from the deck artifact) with narration and captions.
// Each scene is one slide; its length comes from its narration. Numbers come from README.md (facts).
// Script and reasons: docs/submission/pitch-script.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { L, ROOT, log } from "./lib/engine.mjs";
import { sayDec, sayInt, sayUsd } from "./lib/facts.mjs";

const U = "U S D G";
const DECK = join(ROOT, "video/deck");

export const timing = { lead: 0.3, gap: 0.32, tail: 0.35 };
export const outputs = {
  narrated: "strike-pitch.mp4",
  srt: "strike-pitch.srt",
  poster: "strike-pitch-poster.png",
};
export const poster = { scene: "cover", at: 1 };
export const crf = 22;
/** The music bed (video/narration/music.py, CC0): ducked under the voice, -16 LUFS overall. */
export const music = { seed: 7, speech_lufs: -31, gap_db: 5, fade_in: 2, fade_out: 3 };

const TITLES = {
  cover: "Slide 1: Strike",
  problem: "Slide 2: Stock tokens sit idle",
  traps: "Slide 3: Four traps",
  whynow: "Slide 4: Why now, why this chain",
  agents: "Slide 5: Agents propose, the contract decides",
  traction: "Slide 9: Traction, on-chain",
  competition: "Slide 12: Competition",
  business: "Slide 13: Paid only when depositors win",
  safety: "Slide 14: Evidence, not claims",
  ask: "Slide 16: The ask",
};
const slide = (id, tag, lines, extra = {}) => ({
  id,
  tag,
  kind: "slide",
  slide: id,
  title: TITLES[id],
  lines,
  ...extra,
});

export function scenes(f, live) {
  return [
    slide("cover", "Strike", [
      L(
        "This is Strike, by Prashant Thakur: | weekly options vaults for Robinhood Chain stock tokens, | run by AI agents the contract holds to a mandate.",
        "This is Strike, by Prashant Thaakoor: | weekly options vaults for Robinhood Chain stock tokens, | run by AI agents the contract holds to a mandate.",
      ),
    ]),
    slide("problem", "Problem", [
      L(
        "A stock token earns nothing extra while it sits in a wallet. | On Wall Street, holders sell covered calls for that.",
      ),
    ]),
    slide("traps", "Traps", [
      L(
        "Stock tokens also have traps: | a multiplier that is easy to apply twice, | weekend price freezes, and two pause layers. | Strike's contracts handle each one.",
      ),
    ]),
    slide("whynow", "Why this chain", [
      L(
        "Robinhood Chain, an Arbitrum chain, now has every piece: | stock tokens, Chainlink stock feeds, USDG, | and ERC-8004 agent identity.",
        `Robinhood Chain, an Arbitrum chain, now has every piece: | stock tokens, Chainlink stock feeds, ${U}, | and E R C eighty oh four agent identity.`,
      ),
      L(
        `And Stylus makes solving the strike on-chain ${f.stylusTxX} times cheaper per proposal.`,
        `And Stylus makes solving the strike on-chain ${sayDec(f.stylusTxX)} times cheaper per proposal.`,
      ),
    ]),
    slide("agents", "Agents", [
      L(
        "Each week an agent proposes a strike, but never touches the funds. | The contract checks it against the vault's fixed mandate.",
      ),
      L(
        `On September 29, a reckless at-the-money put was rejected, | and ${f.slash} USDG of its bond went to depositors.`,
        `On September twenty-ninth, a reckless at-the-money put was rejected, | and ${sayInt(f.slash)} ${U} of its bond went to depositors.`,
      ),
    ]),
    slide("traction", "Traction", [
      L(
        `It is live on Robinhood Chain testnet and Arbitrum Sepolia, | with ${f.contractsVerified} contracts verified, | and a buyer agent that paid ${f.premium} USDG of premium.`,
        `It is live on Robinhood Chain testnet and Arbitrum Sepolia, | with ${sayInt(f.contractsVerified)} contracts verified, | and a buyer agent that paid ${sayDec(f.premium)} ${U} of premium.`,
        { seeds: [11] }, // pinned take (both takes transcribe correctly on their own)
      ),
      L("On Arbitrum, Claude planned the accepted proposal."),
    ]),
    slide("competition", "Competition", [
      L(
        "Stonkhouse and Archer Markets let traders pick strikes. | In Strike, a bonded agent proposes and the contract checks.",
      ),
    ]),
    slide("business", "Business", [
      L(
        `We take ${f.feePct}% of a week's positive net premium, half to the agent, | and nothing on a losing week.`,
        `We take ${sayInt(f.feePct)} percent of a week's positive net premium, half to the agent, | and nothing on a losing week.`,
      ),
    ]),
    slide("safety", "Evidence", [
      L(
        `Behind it: ${Number(f.testsTotal).toLocaleString("en-US")} tests and proofs, ${f.coverage}% line coverage, | ${sayInt(f.halmos)} properties proven with Halmos, | and all ${f.reviewFindings} internal-review findings fixed.`,
        `Behind it: ${sayInt(f.testsTotal)} tests and proofs, ${sayDec(f.coverage)} percent line coverage, | ${sayInt(f.halmos)} properties proven with Halmos, | and all ${sayInt(f.reviewFindings)} internal review findings fixed.`,
      ),
      L(
        `CI re-checks all ${live.claims.cited} transactions the docs cite, on-chain. | It is not audited yet.`,
        `C I re-checks all ${sayInt(live.claims.cited)} transactions the docs cite, on-chain. | It is not audited yet.`,
      ),
    ]),
    slide(
      "ask",
      "The ask",
      [
        L(
          "We are building Strike as a company on Robinhood Chain and Arbitrum. | Funding buys an external audit and the first capped mainnet vault. | We are asking for a place at Founder House Singapore, | and introductions to wallets and market makers.",
        ),
        L(
          "Try the playground at strike-options.vercel.app.",
          "Try the playground at strike dash options dot vercel dot app.",
        ),
      ],
      { tail: 1.6 },
    ),
  ];
}

/** Read before narrating: the live claims test (every transaction the docs and the app cite, checked on its chain). */
export async function probe() {
  const { claimsCheck } = await import("./lib/facts.mjs");
  return { claims: claimsCheck(ROOT) };
}

/** The pitch opens with the founder's own intro (video/founder.mjs; its word-by-word captions are burned in). */
export async function intro() {
  const { INTRO, founderSrt } = await import("./founder.mjs");
  if (!existsSync(INTRO.path)) throw new Error(`no ${INTRO.path}: run node video/founder.mjs first`);
  return {
    ...INTRO,
    cues: founderSrt(),
    screen:
      "The founder, Prashant Thakur, to camera ([strike-founder.mp4](../media/strike-founder.mp4) before its end card), with word-by-word captions, his name and school in a lower third, and four short cut-aways from the live site: a decision page's specialist stages, the rejected proposal's failing rule, the two testnets on the proof page and the waitlist.",
  };
}

// ------------------------------------------------------------------------------------------ slides

/** Fixes for the video render only (the deck artifact is unchanged): current numbers and no placeholders. */
function patch(id, html, f) {
  if (id === "safety") {
    const ev = JSON.parse(readFileSync(join(ROOT, "docs/evidence/facts.json"), "utf8"));
    html = html
      .replace(/>99% line coverage/, `>${f.coverage}% line coverage`)
      .replace(/>99%</, `>${f.coverage}%<`)
      // the first tile: the total the narration says (README and docs/evidence/facts.json), not the deck's old count
      .replace(
        /(<p style="[^"]*">)477(<\/p>\s*<p style="[^"]*">)Foundry tests: unit, fuzz, integration, every custom error/,
        `$1${Number(f.testsTotal).toLocaleString("en-US")}$2tests and proofs: Foundry (${f.foundry}), fork, differential, Halmos, Rust, TypeScript, subgraph, Playwright`,
      )
      .replace(/Threat model: \d+ threats/, `Threat model: ${ev.threats} threats`);
    if (/>477</.test(html)) throw new Error("slide safety: the tests tile was not replaced");
  }
  if (id === "traction")
    html = html.replace(
      /<p style="([^"]*)">\[__\]<\/p><p style="([^"]*)">testers through the feedback form<\/p>/,
      '<p style="$1">Open</p><p style="$2">any agent can register, bond USDG and run a vault, no permission needed</p>',
    );
  if (/\[[_A-Za-z ]+\]/.test(html.replace(/<aside>[\s\S]*<\/aside>/, "")))
    throw new Error(`slide ${id}: placeholder left`);
  return html;
}

export async function slideImage(browser, scene, work) {
  const out = join(work, `slide-${scene.slide}.png`);
  const f = (await import("./lib/facts.mjs")).readmeFacts(ROOT);
  const frag = patch(scene.slide, readFileSync(join(DECK, `${scene.slide}.html`), "utf8"), f);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=block" rel="stylesheet">
<style>*{box-sizing:border-box}html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:#121212}
h1,h2,h3,p{margin:0}section{position:relative;width:1920px;height:1080px;overflow:hidden}aside{display:none}
table{border-collapse:collapse;width:100%}th{font-weight:800;padding:0 16px 18px 0;border-bottom:2px solid currentColor}
td{padding:18px 16px 18px 0;border-bottom:1px solid rgba(0,0,0,.15);vertical-align:top;line-height:1.35}</style></head>
<body>${frag}</body></html>`;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // the caption bar covers the bottom 150 px: a slide with text there is scaled down from the top to clear it,
  // on its own background
  const scaled = await page.evaluate((limit) => {
    const sec = document.querySelector("section");
    const bottom = Math.max(
      ...[...sec.querySelectorAll("*")]
        .filter((el) => el.children.length === 0 && el.textContent.trim() && el.getClientRects().length)
        .map((el) => el.getBoundingClientRect().bottom),
    );
    if (bottom <= limit) return null;
    const k = limit / bottom;
    const bg = getComputedStyle(sec).backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) document.body.style.background = bg;
    Object.assign(sec.style, { transform: `scale(${k})`, transformOrigin: "50% 0" });
    return k.toFixed(3);
  }, 915);
  if (scaled) log(`  slide ${scene.slide}: scaled to ${scaled} to clear the caption bar`);
  await page.screenshot({ path: out });
  await ctx.close();
  return out;
}

export const scriptDoc = {
  path: "docs/submission/pitch-script.md",
  head: ({ total, narration, words, wpm, mmss, intro }) => `# Pitch video script (${mmss(total)})

${intro ? `[docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (${total.toFixed(1)} s) opens with the founder's own intro (${intro.duration.toFixed(1)} s, the standalone cut is [strike-founder.mp4](../media/strike-founder.mp4), edited by [video/founder.mjs](../../video/founder.mjs) from [video/founder.json](../../video/founder.json)), then the narration (${narration.toFixed(1)} s)` : `The narration of [docs/media/strike-pitch.mp4](../media/strike-pitch.mp4) (${total.toFixed(1)} s)`}, over slides of the deck in the order of [deck-outline.md](deck-outline.md). It is rendered by \`node video/record.mjs pitch\` from [video/pitch.mjs](../../video/pitch.mjs) and the slide copies in [video/deck](../../video/deck), and this file is written by the same run. Timed captions are in [strike-pitch.srt](../media/strike-pitch.srt).

The voice is Chatterbox TTS with a synthetic reference voice, over a quiet synthesised music bed (CC0, [credits](../media/CREDITS.md)): ${words} words in ${narration.toFixed(0)} s (${wpm} words a minute); the founder's intro has no music. Every number is read from README.md at render time, and the count of verified transactions from a live run of \`scripts/check-claims.mjs\`. The product itself is in the separate demo video; slides 6 to 8, 10, 11 and 15 of the deck are left out to keep the slides near two minutes.`,
};
