#!/usr/bin/env node
// One real starter-gas drip through the deployed app, as a new user's browser does it (D49): GET /api/gas-drip for
// the wallet, solve the proof-of-work, POST, then read the chain to confirm the GasDrip `Dripped` event and the new
// balance. With --usdg (Robinhood Chain testnet only) the wallet then spends that gas on its own UsdgDrip.drip(), the
// next step of the first-run path, to show the starter gas is enough to start.
//
//   node scripts/gas-drip-qa.mjs --chain 421614 --wallet qa2
//   node scripts/gas-drip-qa.mjs --chain 46630 --fresh --usdg
//   node scripts/gas-drip-qa.mjs --chain 46630 --address 0x… (no key needed: drip only)
//
// --wallet <name> uses a wallet from .internal/qa-wallets.json (gitignored); it must hold less than 0.0001 ETH on
// the chain and never have dripped. --fresh makes a new wallet and appends it to that file (mode 600). Keys are never
// printed. --app defaults to strike.config.json's services.app. Exit code 0 only when the drip landed on chain.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const appRequire = createRequire(join(ROOT, "app/package.json"));
const viem = await import(pathToFileURL(appRequire.resolve("viem")).href);
const accounts = await import(pathToFileURL(appRequire.resolve("viem/accounts")).href);
const {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  parseAbi,
  parseEventLogs,
  formatEther,
} = viem;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const config = JSON.parse(readFileSync(join(ROOT, "strike.config.json"), "utf8"));
const chainId = Number(opt("chain") ?? 46630);
const app = (opt("app") ?? config.services.app).replace(/\/$/, "");
const chainCfg = config.chains[String(chainId)];
if (!chainCfg) throw new Error(`chain ${chainId} is not in strike.config.json`);
const rpc = opt("rpc") ?? chainCfg.rpc.public;
const explorer = chainCfg.explorer;

const walletsPath = join(ROOT, ".internal/qa-wallets.json");
let account = null;
let address = opt("address");
if (flag("fresh")) {
  const key = accounts.generatePrivateKey();
  account = accounts.privateKeyToAccount(key);
  const list = existsSync(walletsPath) ? JSON.parse(readFileSync(walletsPath, "utf8")) : [];
  const name = `qa${list.length + 1}`;
  list.push({
    name,
    address: account.address,
    privateKey: key,
    label: `gas-drip QA (${new Date().toISOString().slice(0, 10)})`,
  });
  writeFileSync(walletsPath, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  chmodSync(walletsPath, 0o600);
  console.log(`new QA wallet ${name}: ${account.address} (saved to .internal/qa-wallets.json)`);
} else if (opt("wallet")) {
  const list = JSON.parse(readFileSync(walletsPath, "utf8"));
  const w = list.find((x) => x.name === opt("wallet"));
  if (!w) throw new Error(`no wallet named ${opt("wallet")} in .internal/qa-wallets.json`);
  account = accounts.privateKeyToAccount(w.privateKey);
}
address = account?.address ?? address;
if (!address) throw new Error("give --wallet <name>, --fresh or --address 0x…");

const pub = createPublicClient({ transport: http(rpc) });
const before = await pub.getBalance({ address });
console.log(`${app} · chain ${chainId} · ${address} holds ${formatEther(before)} ETH`);

const status = await (await fetch(`${app}/api/gas-drip?chainId=${chainId}&address=${address}`)).json();
console.log(
  `drip ${status.drip}: ${status.dripsLeftToday} of ${status.dailyCap} left today, ${formatEther(BigInt(status.remaining ?? 0))} ETH in it, available=${status.available}`,
);
if (!status.eligible) {
  console.error(`not eligible: ${status.reason} (${status.message})`);
  process.exit(1);
}

const zeroBits = (hash) => {
  let bits = 0;
  for (const ch of hash.slice(2)) {
    const v = parseInt(ch, 16);
    if (v === 0) bits += 4;
    else return bits + Math.clz32(v) - 28;
  }
  return bits;
};
const t0 = Date.now();
let nonce = 0;
while (zeroBits(keccak256(stringToHex(`${status.challenge}:${nonce}`))) < status.difficulty) nonce++;
console.log(
  `proof of work: nonce ${nonce} at ${status.difficulty} bits in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);

const res = await fetch(`${app}/api/gas-drip`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chainId, address, nonce, website: "" }),
});
const result = await res.json();
if (!result.ok) {
  console.error(`refused (${res.status}): ${result.reason}: ${result.message}`);
  process.exit(1);
}
console.log(`relayed: ${explorer}/tx/${result.txHash}`);

const receipt = await pub.waitForTransactionReceipt({ hash: result.txHash });
const dripAbi = parseAbi(["event Dripped(address indexed to, address indexed relayer, uint256 amount)"]);
const events = parseEventLogs({ abi: dripAbi, logs: receipt.logs }).filter(
  (e) =>
    e.address.toLowerCase() === status.drip.toLowerCase() &&
    e.args.to.toLowerCase() === address.toLowerCase(),
);
const after = await pub.getBalance({ address });
console.log(
  `block ${receipt.blockNumber}: Dripped(${events[0]?.args.to}, relayer ${events[0]?.args.relayer}, ${formatEther(events[0]?.args.amount ?? 0n)} ETH); balance ${formatEther(before)} → ${formatEther(after)} ETH`,
);
if (receipt.status !== "success" || events.length !== 1 || after - before !== BigInt(result.amount)) {
  console.error("the drip did not land as expected");
  process.exit(1);
}

if (flag("usdg")) {
  if (!account) throw new Error("--usdg needs --wallet or --fresh (it signs)");
  const dep = JSON.parse(readFileSync(join(ROOT, `contracts/deployments/${chainId}.json`), "utf8"));
  if (!dep.usdgDrip) throw new Error(`no UsdgDrip on chain ${chainId}`);
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const hash = await wallet.writeContract({
    address: dep.usdgDrip,
    abi: parseAbi(["function drip()"]),
    functionName: "drip",
    chain: {
      id: chainId,
      name: chainCfg.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  const usdg = await pub.readContract({
    address: dep.usdg,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address],
  });
  const left = await pub.getBalance({ address });
  console.log(
    `then 10 USDG with the starter gas: ${explorer}/tx/${hash} (${r.status}); wallet holds ${Number(usdg) / 1e6} USDG and ${formatEther(left)} ETH`,
  );
  if (r.status !== "success") process.exit(1);
}
