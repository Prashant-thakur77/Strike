// Render deck slides (HTML <section> fragments) to 1920x1080 PNGs, optionally with a caption bar.
// usage: node render_slides.mjs frames.json
// frames.json: [{ "slide": "cover", "out": "pitch/frames/cover_0.png", "caption": "...", "tag": "Problem" }]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("/home/prashant/projects/strike/app/package.json");
const { chromium } = require("@playwright/test");

const SLIDES = "/tmp/claude-1000/-home-prashant-projects-protocol-monorepo-main/68215a13-3f30-42ad-8faa-6d807a26a9ec/scratchpad/deck-all/project/slides";
const SHOTS = "/home/prashant/projects/strike/docs/screenshots";
const frames = JSON.parse(readFileSync(process.argv[2], "utf8"));

// Content fixes for the video render only (the deck artifact itself is unchanged; see the report).
function patch(id, html) {
  if (id === "demo") {
    const shots = ["desktop-landing.png", "desktop-vault.png", "desktop-agents.png"];
    let i = 0;
    html = html.replace(/src="\/_blob\/[0-9a-f]+"/g, () => `src="data:image/png;base64,${readFileSync(`${SHOTS}/${shots[i++]}`).toString("base64")}"`);
  }
  if (id === "safety") {
    // README: 11 internal-review findings (1 High, 3 Medium, 4 Low, 3 Info), all fixed
    html = html.replace(">8 / 8<", ">11 / 11<").replace("(1 High, 3 Medium, 4 Low)", "(1 High, 3 Medium, 4 Low, 3 Info)");
  }
  if (id === "traction") {
    // the tester count is still a placeholder: show the open agent market instead of "[__]"
    html = html.replace(
      /<p style="([^"]*)">\[__\]<\/p><p style="([^"]*)">testers through the feedback form<\/p>/,
      '<p style="$1">Open</p><p style="$2">any agent can register, bond USDG and run a vault, no permission needed</p>',
    );
  }
  if (id === "roadmap") {
    // team line and video URL are placeholders: leave them out of the video
    html = html.replace(" · [demo video URL]", "");
    html = html.replace(/<div style="flex:1; display:flex; flex-direction:column; gap:12px">\s*<p[^>]*>Team<\/p>[\s\S]*?<\/div>/, "");
  }
  if (/\[[_A-Za-z ]+\]/.test(html.replace(/<aside>[\s\S]*<\/aside>/, ""))) console.warn(`WARN ${id}: placeholder left`);
  return html;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function page(id, caption, tag) {
  const frag = patch(id, readFileSync(`${SLIDES}/${id}.html`, "utf8"));
  const bar = caption
    ? `<div id="cap"><div class="tag">${esc(tag || "")}</div><div class="txt">${esc(caption)}</div></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:#121212}
h1,h2,h3,p{margin:0}
section{position:relative;width:1920px;height:1080px;box-sizing:border-box;overflow:hidden}
aside{display:none}
table{border-collapse:collapse;width:100%}
th{font-weight:800;padding:0 16px 18px 0;border-bottom:2px solid currentColor}
td{padding:18px 16px 18px 0;border-bottom:1px solid rgba(0,0,0,.15);vertical-align:top;line-height:1.35}
#cap{position:fixed;left:0;right:0;bottom:0;z-index:10;background:#0d0d0d;border-top:4px solid #75d0cb;
  padding:22px 96px 26px;display:flex;align-items:center;gap:28px;min-height:104px;box-shadow:0 -20px 50px rgba(0,0,0,.18)}
#cap .tag{flex:none;font:700 15px/1 "Inter Tight",sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#75d0cb;min-width:150px}
#cap .txt{font:600 34px/1.22 "Inter Tight",sans-serif;letter-spacing:-.01em;color:#f1f0ed}
</style></head><body>${frag}${bar}</body></html>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
for (const f of frames) {
  await p.setContent(page(f.slide, f.caption, f.tag), { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  const fonts = await p.evaluate(() => [...document.fonts].filter((x) => x.status === "loaded").map((x) => `${x.family} ${x.weight}`));
  const overflow = await p.evaluate(() => {
    const s = document.querySelector("section");
    const bad = [];
    for (const el of s.querySelectorAll("*")) {
      if (el.closest("aside")) continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > 1920.5 || r.bottom > 1080.5)) bad.push(`${el.tagName}:${Math.round(r.right)}x${Math.round(r.bottom)}`);
    }
    return bad.slice(0, 5);
  });
  await p.screenshot({ path: f.out, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  console.log(f.out, "fonts:", [...new Set(fonts)].join(","), overflow.length ? `OVERFLOW ${overflow}` : "");
}
await browser.close();
