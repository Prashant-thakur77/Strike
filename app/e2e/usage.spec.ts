import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  agoText,
  aggregateDeployment,
  aggregateUsage,
  fmtUsdg,
  walletsOf,
  type DeploymentInput,
  type UsageLog,
  type UsageSource,
  type UsageStats,
} from "../src/lib/usage/aggregate";
import { TEAM_WALLETS, isTeamWallet } from "../src/lib/usage/team";
import { horizontalOverflow, revealAll, settle } from "./helpers";

// Testnet usage (src/lib/usage, /api/stats, the landing strip and the /app/proof table). The first tests are pure
// unit tests of the counting rules on fixture logs; the live ones read the testnets and skip when the RPC is down.

const desktopOnly = () =>
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");

const DEPLOYER = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";
const SIGNER = "0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f";
const OUTSIDER = "0x00000000000000000000000000000000000000a1";
const OUTSIDER_2 = "0x00000000000000000000000000000000000000B2";
const EM = "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99";
const CALL_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const PUT_VAULT = "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7";
const E18 = 10n ** 18n;

let seq = 0;
function log(source: UsageSource, eventName: string, args: Record<string, unknown>, block = 100n): UsageLog {
  seq += 1;
  return {
    source,
    address: source === "vault" ? CALL_VAULT : EM,
    eventName,
    args,
    transactionHash: `0x${seq.toString(16).padStart(64, "0")}`,
    blockNumber: block,
    logIndex: seq,
  };
}

/** The 29 September v2 epoch (docs/testnet-epochs/2026-09-29.md) plus an outside depositor and some noise. */
function v2Fixture(): DeploymentInput {
  const logs: UsageLog[] = [
    log("agentRegistry", "AgentRegistered", {
      agentId: 1n,
      owner: DEPLOYER,
      signer: DEPLOYER,
      erc8004Id: 0n,
    }),
    log("agentRegistry", "BondPosted", { agentId: 1n, from: DEPLOYER, amount: 60_000000n }),
    log("vaultFactory", "VaultCreated", { vault: CALL_VAULT, curator: DEPLOYER, isCall: true, agentId: 1n }),
    log("epochManager", "VaultRegistered", { vault: CALL_VAULT, curator: DEPLOYER, agentId: 1n }),
    log("vaultFactory", "VaultCreated", { vault: PUT_VAULT, curator: DEPLOYER, isCall: false, agentId: 1n }),
    log("vault", "Deposit", { sender: DEPLOYER, owner: DEPLOYER, assets: 5n * E18, shares: 5n * E18 }),
    log("vault", "Deposit", { sender: DEPLOYER, owner: DEPLOYER, assets: 20_000000n, shares: 20_000000n }),
    log("epochManager", "EpochOpened", { vault: CALL_VAULT, epoch: 1n, spot: 352n * E18 }),
    log("epochManager", "SeriesProposed", { vault: CALL_VAULT, epoch: 1n, seriesId: 7n, size: 4n * E18 }),
    log("agentRegistry", "ProposalRecorded", { agentId: 1n, accepted: true }),
    log("epochManager", "EpochOpened", { vault: PUT_VAULT, epoch: 1n, spot: 352n * E18 }),
    // The slash goes to the EpochManager first: a contract, never a wallet.
    log("agentRegistry", "Slashed", { agentId: 1n, recipient: EM, amount: 10_000000n, strikes: 1 }),
    log("epochManager", "ProposalRejected", {
      vault: PUT_VAULT,
      epoch: 1n,
      agentId: 1n,
      slashed: 10_000000n,
    }),
    log("epochManager", "OptionsBought", {
      seriesId: 7n,
      buyer: DEPLOYER,
      recipient: DEPLOYER,
      amount: 4n * E18,
      premium: 10_005944n,
    }),
    // Linking ERC-8004 identity #114 emits AgentRegistered again for agent #1.
    log("agentRegistry", "AgentRegistered", {
      agentId: 1n,
      owner: DEPLOYER,
      signer: DEPLOYER,
      erc8004Id: 114n,
    }),
    log("epochManager", "EpochAborted", { vault: PUT_VAULT, epoch: 1n }),
    log("vault", "Withdraw", { sender: DEPLOYER, receiver: DEPLOYER, owner: DEPLOYER, assets: 20_000000n }),
    log("decisionLog", "DecisionRecorded", { agentId: 1n, vault: CALL_VAULT, epoch: 1n }),
    log("vault", "Deposit", { sender: OUTSIDER, owner: OUTSIDER, assets: 1_000000n, shares: 1_000000n }),
    log("vault", "DepositRequested", { account: OUTSIDER_2, epoch: 2n, assets: 3_000000n }),
    log("vault", "Transfer", { from: "0x0000000000000000000000000000000000000000", to: OUTSIDER, value: 1n }),
  ];
  return {
    chainId: 46630,
    chainName: "Robinhood Chain testnet",
    chainShort: "RH testnet",
    version: "v2",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    contracts: {
      epochManager: EM,
      vaultFactory: "0x5665E02878fA592513C1633af2F07b08cF606beC",
      agentRegistry: "0xE5b76249041e59C74Ee317fC2729f26249618D32",
      decisionLog: "0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93",
    },
    fromBlock: 1n,
    toBlock: 200n,
    usdgDecimals: 6,
    logs,
    tvlUsd: 1924.52,
  };
}

test("usage: counts one deployment's epochs, proposals, options, slashes, records and agents", () => {
  desktopOnly();
  const u = aggregateDeployment(v2Fixture());
  expect(u.key).toBe("46630-v2");
  expect(u.vaults).toBe(2);
  expect(u.epochsOpened).toBe(2);
  expect(u.epochsAborted).toBe(1);
  expect(u.epochsSettled).toBe(0);
  expect(u.proposalsAccepted).toBe(1);
  expect(u.proposalsRejected).toBe(1);
  expect(u.buys).toBe(1);
  expect(u.optionsBought).toBe(4);
  expect(u.premiumUsdg).toBe(10.005944);
  expect(u.slashedUsdg).toBe(10);
  expect(u.deposits).toBe(3);
  expect(u.queuedDeposits).toBe(1);
  expect(u.withdrawals).toBe(1);
  // Agent #1 registered once and re-registered with its identity: one agent, not two.
  expect(u.agentsRegistered).toBe(1);
  expect(u.bondsPosted).toBe(1);
  expect(u.bondedUsdg).toBe(60);
  expect(u.decisionRecords).toBe(1);
  expect(u.tvlUsd).toBe(1924.52);
  // Deployer + two outsiders; the EpochManager (slash recipient) and the zero address are not wallets.
  expect(u.wallets).toBe(3);
  expect(u.outsideWallets).toBe(2);
});

test("usage: a log read twice (overlapping scan ranges) is counted once", () => {
  desktopOnly();
  const input = v2Fixture();
  const bought = input.logs.find((l) => l.eventName === "OptionsBought")!;
  const once = aggregateDeployment(input);
  const twice = aggregateDeployment({ ...input, logs: [...input.logs, { ...bought }] });
  expect(twice.buys).toBe(once.buys);
  expect(twice.premiumUsdg).toBe(once.premiumUsdg);
});

test("usage: wallets count once across chains, other figures add up, unknown value locked stays unknown", () => {
  desktopOnly();
  const a = v2Fixture();
  const b: DeploymentInput = {
    ...v2Fixture(),
    chainId: 421614,
    chainName: "Arbitrum Sepolia",
    chainShort: "Arb Sepolia",
    version: "v3",
    tvlUsd: null,
    logs: [
      log("agentRegistry", "AgentRegistered", {
        agentId: 1n,
        owner: DEPLOYER,
        signer: SIGNER,
        erc8004Id: 253n,
      }),
      log("epochManager", "EpochOpened", { vault: CALL_VAULT, epoch: 1n, spot: 350n * E18 }),
      log("epochManager", "OptionsBought", {
        seriesId: 9n,
        buyer: OUTSIDER.toUpperCase().replace("0X", "0x"),
        recipient: OUTSIDER,
        amount: 4n * E18,
        premium: 8_905435n,
      }),
      log("epochManager", "ProposalRejected", {
        vault: PUT_VAULT,
        epoch: 1n,
        agentId: 1n,
        slashed: 10_000000n,
      }),
    ],
  };
  const s = aggregateUsage([a, b], { generatedAt: new Date("2026-10-02T00:00:00Z") });
  expect(s.generatedAt).toBe("2026-10-02T00:00:00.000Z");
  expect(s.deployments.map((d) => d.key)).toEqual(["46630-v2", "421614-v3"]);
  expect(s.deployments[1].wallets).toBe(3); // deployer, signer, outsider
  // deployer, signer, outsider (on both chains, mixed case), outsider 2
  expect(s.total.wallets).toBe(4);
  expect(s.total.outsideWallets).toBe(2);
  expect(s.outside.find((w) => w.address === OUTSIDER)?.chains).toEqual([46630, 421614]);
  expect(s.outside.find((w) => w.address === OUTSIDER)?.roles.sort()).toEqual(["buyer", "depositor"]);
  expect(s.total.epochsOpened).toBe(3);
  expect(s.total.optionsBought).toBe(8);
  expect(s.total.premiumUsdg).toBe(18.911379);
  expect(s.total.slashedUsdg).toBe(20);
  expect(s.total.agentsRegistered).toBe(2);
  expect(s.total.tvlUsd).toBe(1924.52);
  expect(aggregateUsage([{ ...b }]).total.tvlUsd).toBeNull();
});

test("usage: wallet roles per event", () => {
  desktopOnly();
  expect(walletsOf(log("agentRegistry", "AgentRegistered", { owner: DEPLOYER, signer: SIGNER }))).toEqual([
    [DEPLOYER.toLowerCase(), "agent"],
    [SIGNER.toLowerCase(), "agent"],
  ]);
  expect(walletsOf(log("vaultFactory", "VaultCreated", { curator: OUTSIDER }))).toEqual([
    [OUTSIDER, "curator"],
  ]);
  expect(walletsOf(log("agentRegistry", "BondPosted", { from: OUTSIDER }))).toEqual([[OUTSIDER, "bond"]]);
  // Events that name no acting wallet, and malformed addresses, add none.
  expect(walletsOf(log("epochManager", "EpochOpened", { vault: CALL_VAULT }))).toEqual([]);
  expect(walletsOf(log("vault", "Deposit", { sender: "nope", owner: undefined }))).toEqual([]);
});

test("usage: the team list holds the documented wallets and matches any case", () => {
  desktopOnly();
  const listed = TEAM_WALLETS.map((w) => w.address.toLowerCase());
  for (const a of [
    DEPLOYER,
    SIGNER,
    "0x4501c16dc4f29394560F9B2aB935667cA058B79b",
    "0x1a00BaDC191FFcB65d16D27C0d1F3599528F7364",
    "0x85f0A3A3cb02253e578ec3BE2feDE1F1a1dC33E1",
    // QA test wallets (3 Oct), docs/testnet-epochs/2026-10-03-end-to-end-qa.md
    "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044",
    "0x2E89c1C42A76507dB832E9b78403AB50bd8D9957",
    "0x84bEBDF6736b3f438c9344fb653C80e89Db05F5D",
  ]) {
    expect(listed).toContain(a.toLowerCase());
    expect(isTeamWallet(a.toUpperCase().replace("0X", "0x"))).toBe(true);
  }
  expect(new Set(listed).size).toBe(listed.length);
  expect(isTeamWallet(OUTSIDER)).toBe(false);
});

test("usage: display helpers", () => {
  desktopOnly();
  expect(fmtUsdg(30)).toBe("30");
  expect(fmtUsdg(26.295249)).toBe("26.30");
  expect(fmtUsdg(10.005944)).toBe("10.01");
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(agoText("2026-10-02T11:59:40Z", now)).toBe("just now");
  expect(agoText("2026-10-02T11:46:00Z", now)).toBe("14 min ago");
  expect(agoText("2026-10-02T09:30:00Z", now)).toBe("2 h ago");
});

/* ------------------------------------------------------------------ live: /api/stats against the epoch logs */

async function liveStats(request: APIRequestContext): Promise<UsageStats | null> {
  const res = await request.get("/api/stats", { timeout: 90_000 });
  if (!res.ok()) return null;
  return (await res.json()) as UsageStats;
}

/**
 * Minimums from docs/testnet-epochs (the counts only grow): each deployment ran one live epoch on its call vault
 * (accepted, 4 calls bought) and its put vault (rejected, 10 USDG slashed), and anchored its decision records.
 */
const EXPECTED: Record<
  string,
  {
    vaults: number;
    epochsOpened: number;
    premiumUsdg: number;
    decisionRecords: number;
    agentsRegistered: number;
    log: string;
  }
> = {
  // 2026-09-29.md; agent #2 and its sTSLA-CSP-A2 vault from 2026-10-01-agent2.md; one record anchored later.
  "46630-v2": {
    vaults: 3,
    epochsOpened: 2,
    premiumUsdg: 10.005944,
    decisionRecords: 1,
    agentsRegistered: 2,
    log: "2026-09-29",
  },
  // 2026-09-30-v3.md section 7 (1 October).
  "46630-v3": {
    vaults: 2,
    epochsOpened: 2,
    premiumUsdg: 7.38387,
    decisionRecords: 2,
    agentsRegistered: 1,
    log: "2026-09-30-v3",
  },
  // 2026-09-30-arbitrum-sepolia.md.
  "421614-v3": {
    vaults: 2,
    epochsOpened: 2,
    premiumUsdg: 8.905435,
    decisionRecords: 2,
    agentsRegistered: 1,
    log: "2026-09-30-arbitrum-sepolia",
  },
};

test("usage: /api/stats counts at least what the testnet epoch logs record", async ({ request }) => {
  desktopOnly();
  const s = await liveStats(request);
  test.skip(!s, "/api/stats could not read the testnets (RPC unreachable)");
  expect(s!.errors).toEqual([]);
  for (const [key, e] of Object.entries(EXPECTED)) {
    const d = s!.deployments.find((x) => x.key === key);
    expect(d, `${key} counted`).toBeTruthy();
    expect(d!.vaults, `${key} vaults (${e.log})`).toBeGreaterThanOrEqual(e.vaults);
    expect(d!.epochsOpened, `${key} epochs`).toBeGreaterThanOrEqual(e.epochsOpened);
    expect(d!.proposalsAccepted, `${key} accepted`).toBeGreaterThanOrEqual(1);
    expect(d!.proposalsRejected, `${key} rejected`).toBeGreaterThanOrEqual(1);
    expect(d!.slashedUsdg, `${key} slashed`).toBeGreaterThanOrEqual(10);
    expect(d!.buys, `${key} buys`).toBeGreaterThanOrEqual(1);
    expect(d!.optionsBought, `${key} options`).toBeGreaterThanOrEqual(4);
    expect(d!.premiumUsdg, `${key} premium`).toBeGreaterThanOrEqual(e.premiumUsdg);
    expect(d!.decisionRecords, `${key} records`).toBeGreaterThanOrEqual(e.decisionRecords);
    expect(d!.agentsRegistered, `${key} agents`).toBeGreaterThanOrEqual(e.agentsRegistered);
    expect(d!.wallets, `${key} wallets`).toBeGreaterThanOrEqual(2);
  }
  const t = s!.total;
  expect(t.epochsOpened).toBeGreaterThanOrEqual(6);
  expect(t.proposalsAccepted).toBeGreaterThanOrEqual(3);
  expect(t.proposalsRejected).toBeGreaterThanOrEqual(3);
  expect(t.optionsBought).toBeGreaterThanOrEqual(12);
  expect(t.slashedUsdg).toBeGreaterThanOrEqual(30);
  expect(t.decisionRecords).toBeGreaterThanOrEqual(5);
  // The team wallets seen on-chain are a subset of the team list: some listed wallets (the gas-drip and x402 relayers)
  // only call contracts the usage scan does not read, so they never appear. Anyone else is outside the team.
  const teamSeen = t.wallets - t.outsideWallets;
  expect(teamSeen).toBeGreaterThan(0);
  expect(teamSeen).toBeLessThanOrEqual(TEAM_WALLETS.length);
  expect(t.outsideWallets).toBe(s!.outside.length);
});

/* ------------------------------------------------------------------ pages */

test("usage: the landing strip shows the live counts", async ({ page }) => {
  await page.goto("/");
  const strip = page.getByTestId("usage-strip");
  await strip.scrollIntoViewIfNeeded();
  await expect(strip).toHaveAttribute("data-state", /ready|error/, { timeout: 90_000 });
  test.skip((await strip.getAttribute("data-state")) === "error", "/api/stats could not read the testnets");
  for (const stat of [
    "wallets",
    "outside",
    "epochs",
    "accepted",
    "rejected",
    "options",
    "slashed",
    "records",
  ]) {
    await expect(strip.locator(`[data-stat="${stat}"]`), stat).toHaveText(/^\d[\d,.]*$/);
  }
  expect(Number(await strip.locator('[data-stat="epochs"]').textContent())).toBeGreaterThanOrEqual(6);
  await expect(strip).toContainText(/updated (just now|\d+ min ago)/);
  await expect(strip.getByRole("link", { name: /per chain, with sources/i })).toHaveAttribute(
    "href",
    "/app/proof#usage",
  );
  await revealAll(page);
  await settle(page, 300);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("usage: /app/proof has the per-deployment table with explorer links", async ({ page }) => {
  await page.goto("/app/proof#usage");
  const table = page.getByTestId("usage-table");
  await expect(table).toHaveAttribute("data-state", /ready|error/, { timeout: 90_000 });
  test.skip((await table.getAttribute("data-state")) === "error", "/api/stats could not read the testnets");
  await expect(page.getByRole("region", { name: "Testnet usage" })).toBeVisible();
  await expect(table).toContainText(/Updated (just now|\d+ min ago)/);
  const heads = await table.locator("thead th").allTextContents();
  expect(heads).toEqual(["Counted", "RH testnet v2", "RH testnet v3", "Arb Sepolia v3", "Total"]);
  const epochs = table.locator('tr[data-row="epochsOpened"] td');
  await expect(epochs).toHaveCount(4);
  await expect(epochs.first().locator("a")).toHaveAttribute(
    "href",
    "https://explorer.testnet.chain.robinhood.com/address/0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
  );
  await expect(epochs.nth(2).locator("a")).toHaveAttribute(
    "href",
    /^https:\/\/sepolia\.arbiscan\.io\/address\/0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0$/,
  );
  await expect(table.locator('tr[data-row="decisionRecords"] td').last()).toHaveText(/^\d+$/);
  await revealAll(page);
  await settle(page, 300);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
