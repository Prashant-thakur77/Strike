#!/usr/bin/env node
// Checks every relative link and anchor in README.md, CHANGELOG.md and docs/**/*.md against the files git tracks
// (so a link to an untracked or ignored file counts as broken). External URLs are not fetched.
// Usage: node scripts/check-links.mjs   (exit 1 if anything is broken)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean),
);
const dirs = new Set();
for (const f of tracked) for (let d = dirname(f); d !== "."; d = dirname(d)) dirs.add(d);

const sources = [...tracked].filter(
  (f) => f === "README.md" || f === "CHANGELOG.md" || /^docs\/.+\.md$/.test(f),
);

// GitHub's heading slugs: rendered text, lowercased, punctuation dropped, spaces to hyphens, duplicates numbered.
function slug(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  }
  anchorCache.set(file, out);
  return out;
}

function linksOf(file) {
  const links = [];
  let fence = false;
  readFileSync(join(root, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return;
      const text = line.replace(/``[^`]*``/g, "");
      for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) links.push([i + 1, m[1]]);
      for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) links.push([i + 1, m[1]]);
      for (const m of text.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g))
        links.push([i + 1, m[1].split(/\s/)[0]]);
    });
  return links;
}

const broken = [];
let checked = 0;
for (const file of sources) {
  for (const [line, raw] of linksOf(file)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue; // http(s), mailto, etc.
    checked++;
    const [pathPart, anchor] = raw.split("#", 2);
    let target = file;
    if (pathPart) {
      let p;
      try {
        p = decodeURIComponent(pathPart.split("?")[0]);
      } catch {
        p = pathPart;
      }
      target = normalize(join(dirname(file), p)).replace(/\/$/, "");
      if (!tracked.has(target) && !dirs.has(target)) {
        broken.push(`${file}:${line}: ${raw} (no such tracked file)`);
        continue;
      }
    }
    if (anchor && target.endsWith(".md") && tracked.has(target) && !anchorsOf(target).has(anchor))
      broken.push(`${file}:${line}: ${raw} (no heading #${anchor} in ${target})`);
  }
}

for (const b of broken) console.log(b);
console.log(`${sources.length} files, ${checked} relative links checked, ${broken.length} broken`);
process.exit(broken.length ? 1 : 0);
