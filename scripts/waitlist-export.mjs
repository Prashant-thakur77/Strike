#!/usr/bin/env node
// Exports the mainnet waitlist (D46) to a CSV, or deletes one person's entry. Runs on the team's machine: it reads the
// private Vercel Blob store "strike-waitlist" with the read-write token and decrypts each entry with the team's
// private key, which never leaves .internal/ (gitignored) and is never committed.
//
// Setup, once per run (the env file holds secrets: keep it in .internal/, which git ignores, and delete it after):
//   1. Pull the production env into a temporary file. `vercel env pull` needs a directory linked to the project, so
//      link a scratch one and remove it afterwards:
//        d=$(mktemp -d -p ~/.cache) && (cd "$d" && vercel link --yes --project strike-options >/dev/null \
//          && vercel env pull "$OLDPWD/.internal/waitlist.env" --environment=production --yes >/dev/null); rm -rf "$d"
//      The file gets BLOB_READ_WRITE_TOKEN (read and write the store) and WAITLIST_SALT (only --delete needs it).
//   2. Export:
//        node --no-warnings --env-file=.internal/waitlist.env scripts/waitlist-export.mjs
//      writes .internal/waitlist-<YYYY-MM-DD>.csv (mode 600), one row per person, and prints only the count.
//   3. Remove someone who asked (by reply or on Telegram):
//        node --no-warnings --env-file=.internal/waitlist.env scripts/waitlist-export.mjs --delete someone@example.com
//      The email is lowercased and HMAC'd with WAITLIST_SALT to find waitlist/<hmac>.json, which is deleted.
//      Delete any CSV exported before the removal too.
//   4. rm .internal/waitlist.env
//
// Options: --key <path> (default .internal/waitlist-key.pem), --out <path> (default
// .internal/waitlist-<date>.csv). Prints no email, token, salt or key.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The same encryption code as the route (Node strips its types), and @vercel/blob from the app's dependencies.
const { BLOB_PREFIX, decryptJson, entryPath } = await import(
  pathToFileURL(join(ROOT, "app/src/lib/waitlistCrypto.ts")).href
);
const blob = await import(createRequire(join(ROOT, "app/package.json")).resolve("@vercel/blob"));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) die(`${name} needs a value`);
  return v;
}

function die(msg) {
  console.error(`waitlist-export: ${msg}`);
  process.exit(1);
}

const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
if (!token) die("BLOB_READ_WRITE_TOKEN is not set (see the setup at the top of this file)");

if (process.argv.includes("--delete")) {
  const email = arg("--delete");
  const salt = process.env.WAITLIST_SALT?.trim();
  if (!salt) die("--delete needs WAITLIST_SALT (see the setup at the top of this file)");
  const path = await entryPath(email, salt);
  const found = await blob.get(path, { access: "private", useCache: false, token });
  if (!found) {
    console.log(`No entry for that email (${path}). Nothing deleted.`);
    process.exit(0);
  }
  await blob.del(path, { token });
  const after = await blob.get(path, { access: "private", useCache: false, token });
  if (after) die(`${path} is still there after the delete; try again`);
  console.log(`Deleted ${path}. Delete any CSV exported before this too.`);
  process.exit(0);
}

const keyPath = arg("--key") ?? join(ROOT, ".internal/waitlist-key.pem");
if (!existsSync(keyPath)) die(`no private key at ${relative(ROOT, keyPath)}`);
const privatePem = readFileSync(keyPath, "utf8");

const blobs = [];
let cursor;
do {
  const page = await blob.list({ prefix: BLOB_PREFIX, cursor, limit: 1000, token });
  blobs.push(...page.blobs.filter((b) => b.pathname.endsWith(".json")));
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

const rows = [];
const failed = [];
for (const b of blobs) {
  try {
    const res = await blob.get(b.pathname, { access: "private", useCache: false, token });
    if (!res || res.statusCode !== 200) throw new Error("not found");
    const stored = JSON.parse(await new Response(res.stream).text());
    const e = await decryptJson(stored, privatePem);
    rows.push({
      email: e.email,
      name: e.name,
      telegram: e.telegram,
      wallet: e.wallet,
      interests: e.interests.join(" "),
      note: e.note,
      not_us_person: e.notUsPerson,
      consent: e.consent,
      consent_text: e.consentText,
      created: stored.created,
      updated: stored.updated,
      key_id: stored.kid,
      blob: b.pathname,
    });
  } catch (err) {
    failed.push(`${b.pathname} (${err instanceof Error ? err.name : "error"})`);
  }
}
rows.sort((a, b) => a.created.localeCompare(b.created));

// CSV with every cell quoted; free text that a spreadsheet would run as a formula gets a leading apostrophe.
const FORMULA = /^[=+\-@\t\r]/;
const cell = (v, free) => {
  let s = String(v ?? "");
  if (free && FORMULA.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const FREE = new Set(["email", "name", "note"]);
const cols = [
  "email",
  "name",
  "telegram",
  "wallet",
  "interests",
  "note",
  "not_us_person",
  "consent",
  "consent_text",
  "created",
  "updated",
  "key_id",
  "blob",
];
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c], FREE.has(c))).join(","))].join(
  "\n",
);
const out = arg("--out") ?? join(ROOT, `.internal/waitlist-${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(out, `${csv}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`${rows.length} of ${blobs.length} entries decrypted, written to ${relative(ROOT, out)}`);
if (failed.length) {
  console.log(`Could not read or decrypt ${failed.length}: ${failed.join(", ")}`);
  process.exit(2);
}
