#!/usr/bin/env node
// Runs the matchstick binary directly. Use it where `graph test` refuses the host: graph-cli 0.98 only maps
// Ubuntu 22/24 and macOS to a matchstick build ("Unsupported platform: Linux x64 26" on Ubuntu 26.04).
// The Linux binary needs libpq.so.5 (Ubuntu/Debian: `sudo apt install libpq5`).
//
//   node scripts/matchstick.mjs [suite...] [-c] [-r]      (same arguments as the matchstick binary)
//   MATCHSTICK_BIN=/path/to/binary node scripts/matchstick.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const subgraphDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.MATCHSTICK_VERSION ?? "0.6.0";
const asset =
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? "binary-macos-12-m1"
      : "binary-macos-12"
    : "binary-linux-22";
const bin =
  process.env.MATCHSTICK_BIN ??
  join(subgraphDir, "node_modules", ".cache", "matchstick", `${version}-${asset}`);

if (!existsSync(bin)) {
  const url = `https://github.com/LimeChain/matchstick/releases/download/${version}/${asset}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Download failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, Buffer.from(await response.arrayBuffer()));
  chmodSync(bin, 0o755);
}

const result = spawnSync(bin, process.argv.slice(2), { cwd: subgraphDir, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
