// A throwaway local Strike deployment for end-to-end tests: anvil at a Monday during NYSE hours, then the real
// Foundry Deploy and Seed scripts. Plain JavaScript so packages without Node types can use it (see devnet.d.mts).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Mon 2026-10-05 15:00 UTC: the NYSE is open, the week's expiry is Fri 2026-10-09 20:00 UTC. */
export const DEVNET_TIMESTAMP = 1_791_212_400;
/** Anvil's well-known dev keys (accounts 0-2). Account 0 deploys, curates and is the agent signer. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "../../contracts");

function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Why the devnet cannot start here (null when it can). Set STRIKE_DEVNET=0 to skip on purpose. */
export function devnetUnavailableReason(dir = contractsDir) {
  if (process.env.STRIKE_DEVNET === "0") return "STRIKE_DEVNET=0";
  if (!has("anvil") || !has("forge")) return "anvil and forge are not on PATH (install Foundry)";
  if (!existsSync(join(dir, "lib/forge-std/src"))) return `${dir}/lib submodules are not initialised`;
  return null;
}

/**
 * The `contracts/` directory of a checkout of the `v3-contracts` branch: STRIKE_V3_CONTRACTS, else a git worktree of
 * this repository on that branch (`git worktree add <dir> v3-contracts`). Null when there is none.
 */
export function v3ContractsDir() {
  const fromEnv = process.env.STRIKE_V3_CONTRACTS;
  if (fromEnv) return existsSync(join(fromEnv, "script/Deploy.s.sol")) ? fromEnv : null;
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: contractsDir, encoding: "utf8" });
  if (list.status !== 0) return null;
  for (const block of list.stdout.split("\n\n")) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    if (dir && /^branch refs\/heads\/v3-contracts$/m.test(block)) {
      const contracts = join(dir, "contracts");
      return existsSync(join(contracts, "script/Deploy.s.sol")) ? contracts : null;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForRpc(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start at ${url}`);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} failed (${code}):\n${out}`)),
    );
  });
}

/**
 * Start anvil on a free port and deploy Strike with `script/Deploy.s.sol` and `script/Seed.s.sol`, then the test-USDG
 * faucet with `script/DeployUsdgDrip.s.sol` (1,000,000 TestUSDG, `usdgDrip` in 31337.json). Addresses on 31337 are
 * deterministic. Call `stop()` when done. `contractsDir` deploys another checkout (for example v3 from
 * {@link v3ContractsDir}); its deployment files are written to that checkout's gitignored `deployments/31337*.json`.
 */
export async function startDevnet(opts = {}) {
  const dir = opts.contractsDir ?? contractsDir;
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(
    "anvil",
    ["--port", String(port), "--timestamp", String(DEVNET_TIMESTAMP), "--silent"],
    {
      stdio: "ignore",
    },
  );
  const stop = () => {
    if (anvil.exitCode === null) anvil.kill();
  };
  // Never leak the node, even if the test run is interrupted before stop() is called.
  process.once("exit", stop);
  try {
    await waitForRpc(rpcUrl);
    const env = { ...process.env, PRIVATE_KEY: ANVIL_KEYS[0] };
    // The test-USDG faucet (UsdgDrip) where the checkout has it (main; the v3-contracts branch does not).
    const scripts = ["script/Deploy.s.sol", "script/Seed.s.sol", "script/DeployUsdgDrip.s.sol"].filter((s) =>
      existsSync(join(dir, s)),
    );
    for (const script of scripts) {
      await run(
        "forge",
        ["script", script, "--rpc-url", rpcUrl, "--broadcast", "--silent", "--skip", "test"],
        {
          cwd: dir,
          env,
        },
      );
    }
    const read = (f) => JSON.parse(readFileSync(join(dir, "deployments", f), "utf8"));
    return { rpcUrl, port, deployment: read("31337.json"), vaults: read("31337-vaults.json"), stop };
  } catch (err) {
    stop();
    throw err;
  }
}
