#!/usr/bin/env node
// Publishes @strike/sdk and @strike/mcp to npm as @strike-options/sdk and @strike-options/mcp.
//
// Inside the monorepo the packages keep their workspace names (@strike/sdk, @strike/mcp, workspace:* deps). This
// script builds both, copies each package's publishable output into a staging directory, writes a package.json for
// the npm name, rewrites the "@strike/sdk" import specifiers in the built JS and .d.ts to "@strike-options/sdk", sets
// the version constants (STRIKE_SDK_VERSION, the MCP SERVER_VERSION) to the published version, and checks the result.
// The MCP build keeps @strike/sdk external, so @strike-options/mcp depends on @strike-options/sdk instead of bundling
// a second copy of it.
//
//   node scripts/publish-npm.mjs                 # build and stage only
//   node scripts/publish-npm.mjs --pack          # ... and write the two .tgz files (npm pack) into the stage dir
//   node scripts/publish-npm.mjs --dry-run       # ... and npm publish --dry-run for both
//   node scripts/publish-npm.mjs --publish       # ... and publish: the SDK first, then the MCP server
//
// Options: --out <dir> (default ~/.cache/strike-npm, or STRIKE_NPM_STAGE), --skip-build, --version <x.y.z>
// (default: the latest vX.Y.Z git tag). npm credentials come from your own ~/.npmrc; this script never reads them.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SCOPE = "@strike-options";
const REPO = "https://github.com/Prashant-thakur77/Strike";
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", cwd: root, ...opts });

function latestTagVersion() {
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  if (!tags[0]) throw new Error("no vX.Y.Z git tag: pass --version");
  return tags[0].slice(1);
}

const version = option("--version") ?? latestTagVersion();
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`bad --version ${version}`);
const stage = option("--out") ?? process.env.STRIKE_NPM_STAGE ?? join(homedir(), ".cache", "strike-npm");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const engines = rootPkg.engines ?? { node: ">=22" };

const common = {
  version,
  license: "MIT",
  author: "Prashant Thakur",
  homepage: `${REPO}#install-from-npm`,
  bugs: { url: `${REPO}/issues` },
  publishConfig: { access: "public" },
  engines,
};

const packages = [
  {
    dir: "sdk",
    source: "@strike/sdk",
    name: `${SCOPE}/sdk`,
    keywords: [
      "strike",
      "options",
      "covered-call",
      "cash-secured-put",
      "vault",
      "erc-4626",
      "viem",
      "robinhood-chain",
      "arbitrum",
      "stock-tokens",
      "usdg",
      "ai-agents",
    ],
    extra: [],
  },
  {
    dir: "mcp",
    source: "@strike/mcp",
    name: `${SCOPE}/mcp`,
    keywords: [
      "strike",
      "mcp",
      "model-context-protocol",
      "mcp-server",
      "ai-agents",
      "claude",
      "options",
      "vault",
      "robinhood-chain",
      "arbitrum",
      "stock-tokens",
      "usdg",
    ],
    // The strike://skill resource: the server reads STRIKE_SKILL.md from its package root.
    extra: [["docs/STRIKE_SKILL.md", "STRIKE_SKILL.md"]],
  },
];

/** Workspace names → npm names, for dependencies and import specifiers. */
const renames = Object.fromEntries(packages.map((p) => [p.source, p.name]));

/** Drop the monorepo-only "strike-source" condition (it points at src/, which is not published). */
function publicExports(exports) {
  if (typeof exports !== "object" || exports === null) return exports;
  const out = {};
  for (const [k, v] of Object.entries(exports)) {
    if (k === "strike-source") continue;
    out[k] = typeof v === "object" && v !== null ? publicExports(v) : v;
  }
  return out;
}

function publicDependencies(deps = {}) {
  const out = {};
  for (const [name, range] of Object.entries(deps)) {
    if (renames[name]) out[renames[name]] = `^${version}`;
    else if (String(range).startsWith("workspace:"))
      throw new Error(`unhandled workspace dependency ${name}`);
    else out[name] = range;
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Rewrite "@strike/sdk" (and subpaths) to the npm name, and the version constants, in built JS and .d.ts. */
function rewriteBuild(distDir) {
  const specifier = /(["'])@strike\/(sdk|mcp)(\/[^"']*)?\1/g;
  const versionConst = /\b(STRIKE_SDK_VERSION|SERVER_VERSION) = "[^"]*"/g;
  let versions = 0;
  for (const file of walk(distDir)) {
    if (!/\.(m?js|d\.ts)$/.test(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = before
      .replace(specifier, (_, q, pkg, sub = "") => `${q}${SCOPE}/${pkg}${sub}${q}`)
      .replace(versionConst, (_, name) => {
        versions++;
        return `${name} = "${version}"`;
      });
    if (/["']@strike\/(sdk|mcp)/.test(after)) throw new Error(`${file}: an @strike/ specifier was left`);
    if (after !== before) writeFileSync(file, after);
  }
  return versions;
}

function stagePackage(p) {
  const src = join(root, p.dir);
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  if (pkg.name !== p.source) throw new Error(`${p.dir}/package.json is ${pkg.name}, expected ${p.source}`);
  const out = join(stage, p.dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  cpSync(join(src, "dist"), join(out, "dist"), { recursive: true });
  const readme = join(src, "README.md");
  if (!existsSync(readme)) throw new Error(`${p.dir}/README.md is missing`);
  copyFileSync(readme, join(out, "README.md"));
  copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
  for (const [from, to] of p.extra) copyFileSync(join(root, from), join(out, to));

  const versions = rewriteBuild(join(out, "dist"));
  if (versions === 0) throw new Error(`${p.dir}: no version constant found in the build`);

  const files = ["dist", ...p.extra.map(([, to]) => to)];
  const manifest = {
    name: p.name,
    version,
    description: pkg.description,
    keywords: p.keywords,
    license: common.license,
    author: common.author,
    homepage: common.homepage,
    bugs: common.bugs,
    repository: { type: "git", url: `git+${REPO}.git`, directory: p.dir },
    type: pkg.type,
    ...(pkg.main ? { main: pkg.main } : {}),
    ...(pkg.types ? { types: pkg.types } : {}),
    exports: publicExports(pkg.exports),
    // npm normalises bin paths without "./" (and warns when it has to), so write them that way.
    ...(pkg.bin
      ? { bin: Object.fromEntries(Object.entries(pkg.bin).map(([k, v]) => [k, v.replace(/^\.\//, "")])) }
      : {}),
    files,
    engines: common.engines,
    dependencies: publicDependencies(pkg.dependencies),
    publishConfig: common.publishConfig,
  };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The bin must start with a shebang and be executable for `npx @strike-options/mcp`.
  for (const bin of Object.values(pkg.bin ?? {})) {
    const file = join(out, bin);
    if (!readFileSync(file, "utf8").startsWith("#!/usr/bin/env node\n"))
      throw new Error(`${bin}: no node shebang`);
    chmodSync(file, 0o755);
  }

  // Nothing private or machine-specific in the package.
  for (const file of walk(out)) {
    const rel = relative(out, file);
    if (/(^|\/)\.env|\.(key|pem|map)$|(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(rel)) {
      throw new Error(`${p.name}: ${rel} must not be published`);
    }
    const text = readFileSync(file, "utf8");
    if (text.includes(root) || text.includes(homedir()))
      throw new Error(`${p.name}: ${rel} has a local path`);
    if (/PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}/.test(text)) throw new Error(`${p.name}: ${rel} has a key`);
  }
  console.log(`staged ${p.name}@${version} in ${out}`);
  return out;
}

if (!flag("--skip-build")) {
  for (const p of packages) run("corepack", ["pnpm", "--filter", p.source, "build"]);
}
mkdirSync(stage, { recursive: true });
const dirs = packages.map(stagePackage);

if (flag("--pack")) {
  for (const dir of dirs) run("npm", ["pack", "--pack-destination", stage], { cwd: dir });
}
if (flag("--dry-run")) {
  for (const dir of dirs) run("npm", ["publish", "--dry-run", "--access", "public"], { cwd: dir });
}
if (flag("--publish")) {
  // The SDK first: the MCP server depends on it.
  for (const dir of dirs) run("npm", ["publish", "--access", "public"], { cwd: dir });
}
