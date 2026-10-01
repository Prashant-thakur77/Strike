#!/usr/bin/env node
// Downloads the stock footage the demo's problem scene uses (video/footage.json) into video/.out/footage/<name>.mp4,
// from each clip's Pexels download link, as a browser on pexels.com would (the site sits behind a bot check). The
// clips are free to use under the Pexels License (https://www.pexels.com/license/); credits are in
// docs/media/CREDITS.md. The files are not committed; run this once before `node video/record.mjs demo`.
//   node video/footage.mjs [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(ROOT, "app", "package.json"))("@playwright/test");
const clips = JSON.parse(readFileSync(join(ROOT, "video/footage.json"), "utf8")).clips;
const OUT = join(ROOT, "video/.out/footage");
mkdirSync(OUT, { recursive: true });
const force = process.argv.includes("--force");

const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-US",
  acceptDownloads: true,
});
await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
const page = await ctx.newPage();
for (const c of clips) {
  const dest = join(OUT, `${c.name}.mp4`);
  if (existsSync(dest) && !force) continue;
  await page.goto(c.page, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 10 && /moment/i.test(await page.title()); i++) await page.waitForTimeout(2500);
  const id = c.page.match(/-(\d+)\/?$/)[1];
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.evaluate((u) => {
      const a = document.createElement("a");
      a.href = u;
      document.body.appendChild(a);
      a.click();
    }, `https://www.pexels.com/download/video/${id}/`),
  ]);
  const raw = `${dest}.src`;
  await dl.saveAs(raw);
  // 1080p, 30 fps, H.264, no audio: what the segment builder expects
  const r = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    raw,
    "-t",
    "20",
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    dest,
  ]);
  if (r.status !== 0) throw new Error(`ffmpeg ${c.name}: ${r.stderr}`);
  spawnSync("rm", ["-f", raw]);
  console.log(`footage: ${c.name} <- ${c.page} (${dl.url().split("?")[0]})`);
  writeFileSync(join(OUT, `${c.name}.url`), dl.url() + "\n");
}
await browser.close();
