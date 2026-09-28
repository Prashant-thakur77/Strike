#!/usr/bin/env node
// Fills a local Strike devnet (Deploy.s.sol + Seed.s.sol already run) with a realistic history, so the app has
// something to show: deposits, one settled epoch per vault, a live series per vault, agent rejections and slashes,
// queued requests. Uses anvil time travel, so run it on a throwaway anvil only.
//
//   RPC_URL=http://127.0.0.1:8555 node scripts/demo-chain.mjs
//
// Accounts are anvil's default unlocked accounts:
//   #0 deployer / curator / agent 1   #1 depositor ("you" in the screenshots)   #2 option buyer
//   #3 agent 2 (ERC-8004 id 1137)     #4 agent 3 (reckless, ends up suspended)
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  formatUnits,
} from "viem";
import { foundry } from "viem/chains";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const EPOCH_MANAGER = process.env.EPOCH_MANAGER ?? "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";

const A = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

const emAbi = parseAbi([
  "function usdg() view returns (address)",
  "function agents() view returns (address)",
  "function oracle() view returns (address)",
  "function vaultCount() view returns (uint256)",
  "function allVaults(uint256) view returns (address)",
  "function epochs(address) view returns (uint8 state, uint64 openedAt, uint256 seriesId)",
  "function openEpoch(address vault)",
  "function proposeSeries(address vault, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps) returns (bool, uint256)",
  "function previewProposal(address vault, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps) view returns (uint8 reason, uint256 fairValue, int256 delta, uint256 capacity)",
  "function buy(uint256 seriesId, uint256 amount, uint256 maxPremium, address to) returns (uint256)",
  "function settle(address vault, uint80 roundId)",
  "function setVaultAgent(address vault, uint256 agentId)",
  "function spot(address token) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function underlying() view returns (address)",
  "function isCall() view returns (bool)",
  "function asset() view returns (address)",
  "function currentEpoch() view returns (uint64)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function requestDeposit(uint256 assets, address receiver)",
  "function requestRedeem(uint256 shares)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const stockAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const usdgAbi = parseAbi(["function faucet(uint256 amount)"]);
const registryAbi = parseAbi([
  "function register(address signer, address payout, uint256 erc8004Id) returns (uint256)",
  "function postBond(uint256 agentId, uint256 amount)",
  "function agentOfSigner(address) view returns (uint256)",
  "function agentCount() view returns (uint256)",
]);
const oracleAbi = parseAbi([
  "function feedConfig(address token) view returns ((address feed, uint32 maxPriceAge, uint32 corporateActionGrace, uint8 feedDecimals))",
  "function calendar() view returns (address)",
]);
const feedAbi = parseAbi([
  "function push(int256 answer, uint64 updatedAt) returns (uint80)",
  "function latestRound() view returns (uint80)",
]);
const calendarAbi = parseAbi([
  "function isTradingDay(uint256 day) view returns (bool)",
  "function sessionOf(uint256 day) view returns (uint256 open, uint256 close)",
]);

const chain = { ...foundry, rpcUrls: { default: { http: [RPC_URL] } } };
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC_URL) });
const wallets = A.map((account) => createWalletClient({ account, chain, transport: http(RPC_URL) }));

const read = (address, abi, functionName, args = []) =>
  pub.readContract({ address, abi, functionName, args });

async function send(who, address, abi, functionName, args = []) {
  const hash = await wallets[who].writeContract({ address, abi, functionName, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

async function warp(timestamp) {
  const block = await pub.getBlock();
  if (BigInt(timestamp) <= block.timestamp) return;
  await test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  await test.mine({ blocks: 1 });
}

const WAD = 10n ** 18n;
const usd = (n) => parseUnits(String(n), 6);
const tok = (n) => parseUnits(String(n), 18);
const DAY = 86400;

async function main() {
  const code = await pub.getCode({ address: EPOCH_MANAGER });
  if (!code || code === "0x") {
    console.error(
      `No EpochManager at ${EPOCH_MANAGER} on ${RPC_URL}. Run Deploy.s.sol and Seed.s.sol first.`,
    );
    process.exit(1);
  }
  const usdg = await read(EPOCH_MANAGER, emAbi, "usdg");
  const registry = await read(EPOCH_MANAGER, emAbi, "agents");
  const oracle = await read(EPOCH_MANAGER, emAbi, "oracle");
  const calendar = await read(oracle, oracleAbi, "calendar");
  const count = await read(EPOCH_MANAGER, emAbi, "vaultCount");
  const vaults = [];
  for (let i = 0n; i < count; i++) vaults.push(await read(EPOCH_MANAGER, emAbi, "allVaults", [i]));
  let callVault, putVault;
  for (const v of vaults) {
    if (await read(v, vaultAbi, "isCall")) callVault ??= v;
    else putVault ??= v;
  }
  if (!callVault || !putVault) throw new Error("need a call and a put vault (run Seed.s.sol)");
  if ((await read(callVault, vaultAbi, "currentEpoch")) > 0n) {
    console.log("Demo history already present; nothing to do.");
    return;
  }
  const stock = await read(callVault, vaultAbi, "underlying");
  const { feed } = await read(oracle, oracleAbi, "feedConfig", [stock]);

  const now = Number((await pub.getBlock()).timestamp);
  // Next Monday that is a trading day, and the Friday close of that week.
  async function week(fromDay) {
    for (let d = fromDay; d < fromDay + 21; d++) {
      if ((d + 3) % 7 !== 0) continue; // day 0 (1970-01-01) was a Thursday
      if (!(await read(calendar, calendarAbi, "isTradingDay", [BigInt(d)]))) continue;
      const [open] = await read(calendar, calendarAbi, "sessionOf", [BigInt(d)]);
      const [, close] = await read(calendar, calendarAbi, "sessionOf", [BigInt(d + 4)]);
      return { day: d, open: Number(open) + 300, expiry: Number(close) };
    }
    throw new Error("no trading Monday found");
  }
  const today = Math.floor(now / DAY);
  let w1 = await week(today);
  if (w1.open <= now) w1 = await week(today + 1);
  const w2 = await week(w1.day + 1);
  console.log("epoch 1 opens", new Date(w1.open * 1000).toISOString(), "expires", new Date(w1.expiry * 1000));
  console.log("epoch 2 opens", new Date(w2.open * 1000).toISOString(), "expires", new Date(w2.expiry * 1000));

  // ---- funding, agents, deposits
  for (const who of [1, 2, 3, 4]) await send(who, usdg, usdgAbi, "faucet", [usd(1_000_000)]);
  await send(0, stock, stockAbi, "mint", [A[0], tok(200)]);
  await send(0, stock, stockAbi, "mint", [A[1], tok(120)]);
  for (const who of [0, 1, 2, 3, 4]) {
    await send(who, usdg, erc20Abi, "approve", [EPOCH_MANAGER, maxUint256]);
    await send(who, usdg, erc20Abi, "approve", [registry, maxUint256]);
    await send(who, usdg, erc20Abi, "approve", [putVault, maxUint256]);
    await send(who, stock, erc20Abi, "approve", [callVault, maxUint256]);
  }
  await send(0, registry, registryAbi, "postBond", [1n, usd(100)]);
  if ((await read(registry, registryAbi, "agentOfSigner", [A[3]])) === 0n) {
    await send(3, registry, registryAbi, "register", [A[3], A[3], 1137n]);
  }
  if ((await read(registry, registryAbi, "agentOfSigner", [A[4]])) === 0n) {
    await send(4, registry, registryAbi, "register", [A[4], A[4], 0n]);
  }
  const agent2 = await read(registry, registryAbi, "agentOfSigner", [A[3]]);
  const agent3 = await read(registry, registryAbi, "agentOfSigner", [A[4]]);
  await send(3, registry, registryAbi, "postBond", [agent2, usd(100)]);
  await send(4, registry, registryAbi, "postBond", [agent3, usd(150)]);

  await send(0, callVault, vaultAbi, "deposit", [tok(60), A[0]]);
  await send(1, callVault, vaultAbi, "deposit", [tok(25), A[1]]);
  await send(0, putVault, vaultAbi, "deposit", [usd(15_000), A[0]]);
  await send(1, putVault, vaultAbi, "deposit", [usd(5_000), A[1]]);

  // ---- helpers for proposals
  async function pick(vault, expiry, isCall, target = 2500n) {
    const spot = await read(EPOCH_MANAGER, emAbi, "spot", [stock]);
    const base = spot / WAD;
    let best;
    for (let k = 2n; k <= 60n; k++) {
      const strike = (isCall ? base + k : base - k) * WAD;
      const [, , , capacity] = await read(EPOCH_MANAGER, emAbi, "previewProposal", [
        vault,
        strike,
        BigInt(expiry),
        1n,
        10000,
      ]);
      const size = ((capacity * 7n) / 10n / WAD) * WAD;
      const [reason, , delta] = await read(EPOCH_MANAGER, emAbi, "previewProposal", [
        vault,
        strike,
        BigInt(expiry),
        size,
        10000,
      ]);
      if (reason !== 0) continue;
      const d = ((delta < 0n ? -delta : delta) * 10000n) / WAD;
      const score = d > target ? d - target : target - d;
      if (!best || score < best.score) best = { strike, size, score, delta: d };
    }
    if (!best) throw new Error("no strike inside the mandate");
    return best;
  }
  async function propose(who, vault, strike, expiry, size, premiumBps) {
    await send(who, EPOCH_MANAGER, emAbi, "proposeSeries", [vault, strike, BigInt(expiry), size, premiumBps]);
    return (await read(EPOCH_MANAGER, emAbi, "epochs", [vault]))[2];
  }
  async function buy(who, seriesId, amount) {
    await send(who, EPOCH_MANAGER, emAbi, "buy", [seriesId, amount, maxUint256, A[who]]);
  }
  const price8 = (wad) => wad / 10n ** 10n;

  // ---- epoch 1
  await warp(w1.open);
  await send(0, feed, feedAbi, "push", [36900000000n, BigInt(w1.open)]);
  await send(0, EPOCH_MANAGER, emAbi, "openEpoch", [callVault]);
  await send(0, EPOCH_MANAGER, emAbi, "openEpoch", [putVault]);
  // Reckless: a covered call struck below spot (in the money). Rejected, agent 1 slashed.
  await propose(0, callVault, 360n * WAD, w1.expiry, tok(10), 10000);
  const c1 = await pick(callVault, w1.expiry, true);
  const callSeries1 = await propose(0, callVault, c1.strike, w1.expiry, c1.size, 10000);
  const p1 = await pick(putVault, w1.expiry, false);
  const putSeries1 = await propose(0, putVault, p1.strike, w1.expiry, p1.size, 10000);
  await buy(2, callSeries1, tok(40));
  await buy(1, callSeries1, tok(5));
  await buy(2, putSeries1, tok(28));
  await buy(1, putSeries1, tok(3));

  // Expiry: the call finishes just in the money, the put out of the money.
  const settlePx = (c1.strike * 1006n) / 1000n;
  await warp(w1.expiry + 60);
  await send(0, feed, feedAbi, "push", [price8(settlePx), BigInt(w1.expiry + 60)]);
  const round = await read(feed, feedAbi, "latestRound");
  await send(0, EPOCH_MANAGER, emAbi, "settle", [callVault, round]);
  await send(0, EPOCH_MANAGER, emAbi, "settle", [putVault, round]);

  // ---- epoch 2
  await warp(w2.open);
  await send(0, feed, feedAbi, "push", [price8((settlePx * 995n) / 1000n), BigInt(w2.open)]);
  await send(0, EPOCH_MANAGER, emAbi, "openEpoch", [callVault]);
  await send(0, EPOCH_MANAGER, emAbi, "openEpoch", [putVault]);

  const c2 = await pick(callVault, w2.expiry, true, 2200n);
  // Agent 1 asks less than the mandate's minimum price (90% of fair value): rejected.
  await propose(0, callVault, c2.strike, w2.expiry, c2.size, 9000);
  const callSeries2 = await propose(0, callVault, c2.strike, w2.expiry, c2.size, 10200);

  // Put vault: the curator hands it to agent 3, which breaks the mandate three times and is suspended.
  const p2 = await pick(putVault, w2.expiry, false);
  await send(0, EPOCH_MANAGER, emAbi, "setVaultAgent", [putVault, agent3]);
  const spot2 = await read(EPOCH_MANAGER, emAbi, "spot", [stock]);
  await propose(4, putVault, (spot2 / WAD + 10n) * WAD, w2.expiry, tok(5), 10000); // StrikeWrongSide
  await propose(4, putVault, p2.strike, w2.expiry, p2.size * 20n, 10000); // SizeTooLarge
  await propose(4, putVault, (((spot2 / WAD) * 70n) / 100n) * WAD, w2.expiry, tok(5), 10000); // DeltaOutOfBand
  // Agent 2 takes over; its first try uses a two-week expiry (TenorOutOfRange), then a valid one.
  await send(0, EPOCH_MANAGER, emAbi, "setVaultAgent", [putVault, agent2]);
  await propose(3, putVault, p2.strike, w2.expiry + 7 * DAY, p2.size, 10000);
  const putSeries2 = await propose(3, putVault, p2.strike, w2.expiry, p2.size, 10000);

  await buy(2, callSeries2, tok(30));
  await buy(1, callSeries2, tok(4));
  await buy(2, putSeries2, tok(18));

  // Queued requests while the vaults are locked.
  await send(1, callVault, vaultAbi, "requestDeposit", [tok(5), A[1]]);
  const putShares = await read(putVault, vaultAbi, "balanceOf", [A[1]]);
  await send(1, putVault, vaultAbi, "requestRedeem", [putShares / 5n]);

  console.log("call vault", callVault, "strike", formatUnits(c2.strike, 18), "delta", Number(c2.delta) / 1e4);
  console.log("put vault ", putVault, "strike", formatUnits(p2.strike, 18), "delta", Number(p2.delta) / 1e4);
  console.log("agents", (await read(registry, registryAbi, "agentCount")).toString());
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
