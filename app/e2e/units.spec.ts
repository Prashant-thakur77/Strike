import { expect, test } from "@playwright/test";
import { breakeven, buyPrice, payoffAt } from "../src/lib/payoff";
import { UNIT_MULTIPLIER, fmtMultiplier, hasMultiplier, perSharePrice } from "../src/lib/shares";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import strikeConfig from "../../strike.config.json";
import {
  CI_KEEPER_ADDRESS,
  GOV_DEPLOYMENTS,
  GOV_ERROR_TTL_MS,
  GOV_TTL_MS,
  GovernanceCache,
  ROLE_HASH,
  STAGES,
  type GovernanceJson,
  type RoleEvent,
  describeAction,
  everGranted,
  groupActions,
  holdersFromEvents,
  labelBook,
  labelOf,
  nameFrom,
  parseGovChain,
  roleName,
} from "../src/lib/governance";

// Pure unit tests (no browser page) for the ERC-8056 per-share conversion. Chainlink prices one RAW token; one raw
// token is multiplier / 1e18 shares, so price per share = price per token / multiplier. Never price × multiplier.

const WAD = 10n ** 18n;
const usd = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

test("per-share price divides the per-token price by the multiplier", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const m = 1_000775000000000000n; // 1.000775
  expect(perSharePrice(usd("381.12"), m)).toBe((usd("381.12") * WAD) / m);
  expect(Number(perSharePrice(usd("381.12"), m)) / 1e18).toBeCloseTo(380.8249, 3);
  // A 2-for-1 split: each raw token is two shares, so a share costs half the token price.
  expect(perSharePrice(usd("400"), 2n * WAD)).toBe(usd("200"));
  // Never above the feed price when the multiplier is above 1 (it would be if we multiplied).
  expect(perSharePrice(usd("400"), m) < usd("400")).toBe(true);
});

test("a missing or unit multiplier leaves the price alone", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(perSharePrice(usd("381.12"), UNIT_MULTIPLIER)).toBe(usd("381.12"));
  expect(perSharePrice(usd("381.12"), 0n)).toBe(usd("381.12"));
  expect(hasMultiplier(UNIT_MULTIPLIER)).toBe(false);
  expect(hasMultiplier(0n)).toBe(false);
  expect(hasMultiplier(1_000775000000000000n)).toBe(true);
});

test("formats the multiplier for the note", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(fmtMultiplier(1_000775000000000000n)).toBe("1.000775");
  expect(fmtMultiplier(UNIT_MULTIPLIER)).toBe("1.000");
  expect(fmtMultiplier(2n * WAD)).toBe("2.000");
  expect(fmtMultiplier(500000000000000000n)).toBe("0.500");
  expect(fmtMultiplier(1_000000400000000000n)).toBe("1.0000004");
});

// Payoff at expiry and the buy-price mirror of EpochManager._quoteBuy (display only).

test("payoff: calls pay S − K, puts K − S; the depositor side mirrors the buyer", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(payoffAt(true, 370, 400, 2.5)).toEqual({ payout: 30, buyer: 27.5, depositor: -27.5 });
  expect(payoffAt(true, 370, 350, 2.5)).toEqual({ payout: 0, buyer: -2.5, depositor: 2.5 });
  expect(payoffAt(false, 330, 300, 4)).toEqual({ payout: 30, buyer: 26, depositor: -26 });
  expect(payoffAt(false, 330, 360, 4)).toEqual({ payout: 0, buyer: -4, depositor: 4 });
  expect(breakeven(true, 369.86, 2.5)).toBeCloseTo(372.36, 6);
  expect(breakeven(false, 330, 4)).toBe(326);
  expect(payoffAt(true, 369.86, breakeven(true, 369.86, 2.5), 2.5).buyer).toBeCloseTo(0, 9);
});

test("buy price: fair value at the buffered spot × premium factor, never below intrinsic", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const base = {
    strike: 369.86,
    tenorSeconds: 3 * 86_400,
    sigma: 0.6,
    premiumBps: 10_000,
    spotBufferBps: 50,
  };
  // A stand-in model that records what it was asked (specs load as CommonJS: no @strike/sdk here).
  const asked: number[][] = [];
  const model = (spot: number, strike: number, tenor: number, sigma: number) => {
    asked.push([spot, strike, tenor, sigma]);
    return 2.5;
  };
  const call = buyPrice({ ...base, spot: 352.45, isCall: true }, model);
  expect(call.pricedSpot).toBeCloseTo(352.45 * 1.005, 9); // against a call buyer: up
  expect(asked[0]).toEqual([call.pricedSpot, 369.86, 3 * 86_400, 0.6]);
  expect(call.perOption).toBe(2.5);
  expect(call.floorBinds).toBe(false);
  const put = buyPrice({ ...base, spot: 352.45, isCall: false }, model);
  expect(put.pricedSpot).toBeCloseTo(352.45 * 0.995, 9); // against a put buyer: down
  expect(buyPrice({ ...base, spot: 352.45, isCall: true, premiumBps: 12_000 }, model).perOption).toBeCloseTo(
    3,
    9,
  );
  // Deep in the money at a 50% premium factor: the intrinsic floor sets the price.
  const itm = buyPrice({ ...base, spot: 420, isCall: true, premiumBps: 5_000 }, () => 52);
  expect(itm.floorBinds).toBe(true);
  expect(itm.perOption).toBeCloseTo(420 * 1.005 - 369.86, 9);
});

// ------------------------------------------------------------------ governance (src/lib/governance.ts)

const DEPLOYER = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";
const ADMIN = ROLE_HASH.DEFAULT_ADMIN_ROLE;
const KEEPER = ROLE_HASH.KEEPER_ROLE;
const FEED = "0x5476cb08769f406dE95F6171AcC1F5FE88431230";
const ev = (role: string, account: string, granted: boolean, block: number, logIndex = 0): RoleEvent => ({
  contract: FEED,
  role,
  account,
  sender: DEPLOYER,
  granted,
  tx: `0x${block.toString(16).padStart(64, "0")}`,
  block,
  logIndex,
});

test("governance: each role hash is keccak256 of its name, and unknown roles show a short hash", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  for (const [name, hash] of Object.entries(ROLE_HASH)) {
    if (name === "DEFAULT_ADMIN_ROLE") expect(hash).toBe(`0x${"0".repeat(64)}`);
    else expect(hash).toBe(keccak256(toBytes(name)));
    expect(roleName(hash)).toBe(name);
  }
  expect(roleName(keccak256(toBytes("MINTER_ROLE")))).toMatch(/^role 0x[0-9a-f]{8}…$/);
});

test("governance: holders are the grants the logs leave, replayed in chain order", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const other = "0x000000000000000000000000000000000000dEaD";
  // Out of order on purpose: the replay sorts by block and log index.
  const events = [
    ev(KEEPER, other, false, 30),
    ev(KEEPER, DEPLOYER, true, 10, 1),
    ev(ADMIN, DEPLOYER, true, 10, 0),
    ev(KEEPER, other, true, 20),
    ev(KEEPER, CI_KEEPER_ADDRESS, true, 40),
    ev(KEEPER, CI_KEEPER_ADDRESS, false, 50),
    ev(KEEPER, CI_KEEPER_ADDRESS, true, 60),
  ];
  const roles = holdersFromEvents(events).get(FEED.toLowerCase())!;
  expect([...roles.get(ADMIN)!.keys()]).toEqual([DEPLOYER.toLowerCase()]);
  const keepers = roles.get(KEEPER)!;
  expect([...keepers.keys()].sort()).toEqual(
    [DEPLOYER.toLowerCase(), CI_KEEPER_ADDRESS.toLowerCase()].sort(),
  );
  // The re-grant is the one in force, and the revoked account is gone.
  expect(keepers.get(CI_KEEPER_ADDRESS.toLowerCase())!.block).toBe(60);
  expect(keepers.has(other.toLowerCase())).toBe(false);
  // Everyone ever granted is still a candidate for hasRole, revoked or not.
  expect([...everGranted(events, FEED).get(KEEPER)!].sort()).toEqual(
    [DEPLOYER, other, CI_KEEPER_ADDRESS].map((a) => a.toLowerCase()).sort(),
  );
});

test("governance: the label book names the team's keys and Strike's contracts, and nothing else", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const rh = labelBook(46630);
  expect(labelOf(rh, DEPLOYER)).toEqual({ label: "Deployer", kind: "deployer" });
  expect(labelOf(rh, CI_KEEPER_ADDRESS.toUpperCase().replace("0X", "0x"))).toEqual({
    label: "CI keeper key",
    kind: "keeper",
  });
  expect(labelOf(rh, "0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f")).toEqual({
    label: "Agent #1 signer",
    kind: "agent",
  });
  expect(labelOf(rh, "0x4501c16dc4f29394560F9B2aB935667cA058B79b").kind).toBe("agent");
  // v2's EpochManager, and the calendar and feeds v3 shares with v2.
  expect(labelOf(rh, "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99")).toEqual({
    label: "EpochManager v2",
    kind: "contract",
  });
  expect(labelOf(rh, "0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4").label).toBe("MarketCalendar v2, v3");
  expect(labelOf(rh, FEED).label).toBe("TSLA MirrorFeed v2, v3");
  expect(labelOf(rh, "0x000000000000000000000000000000000000dEaD")).toEqual({
    label: "Unknown holder",
    kind: "unknown",
  });
  // Arbitrum Sepolia's book has its own contracts, not 46630's.
  const arb = labelBook(421614);
  expect(labelOf(arb, "0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0").label).toBe("EpochManager v3");
  expect(labelOf(arb, "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99").kind).toBe("unknown");
  expect(nameFrom(arb)("0x000000000000000000000000000000000000dEaD")).toBe("0x0000…dEaD");
});

test("governance: the page reads exactly the deployments strike.config.json lists", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const listed = [...strikeConfig.chains["46630"].deployments, ...strikeConfig.chains["421614"].deployments];
  expect(GOV_DEPLOYMENTS.map((d) => d.file)).toEqual(listed);
  expect(GOV_DEPLOYMENTS.map((d) => d.record.chainId)).toEqual([46630, 46630, 421614]);
});

test("governance: every staged-path test link lands on that test's line", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(STAGES.map((s) => s.current)).toEqual([true, false, false]);
  const tests = STAGES.flatMap((s) => s.commitments.flatMap((c) => c.tests));
  expect(tests.length).toBe(14);
  for (const t of tests) {
    const [file, line] = t.path.split("#L");
    const text = readFileSync(join(__dirname, "..", "..", file!), "utf8").split("\n")[Number(line) - 1];
    expect(text, t.path).toContain(t.name);
  }
});

test("governance: admin events read as one plain line, folded per transaction", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  const name = nameFrom(labelBook(46630));
  expect(describeAction("RoleGranted", { role: KEEPER, account: CI_KEEPER_ADDRESS }, name)).toBe(
    "Granted KEEPER_ROLE to CI keeper key",
  );
  expect(describeAction("PricerSet", { pricer: "0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c" }, name)).toBe(
    "Pricer set to Stylus pricer v2",
  );
  expect(
    describeAction(
      "SigmaSet",
      {
        token: "0x71178BAc73cBeb415514eB542a8995b82669778d",
        sigma: 5n * 10n ** 17n,
        minSigma: 2n * 10n ** 17n,
        maxSigma: 2n * 10n ** 18n,
      },
      name,
    ),
  ).toBe("Sigma of AMD stock token v2, v3 set to 50% (bounds 20% to 200%)");
  expect(
    describeAction(
      "TimingsSet",
      { proposalTimeout: 86400n, saleCutoff: 3600n, settlementGrace: 604800n },
      name,
    ),
  ).toBe("Timings set: proposal timeout 1 d, sale cutoff 1 h, settlement grace 7 d");
  const log = (eventName: string, tx: string, logIndex: number) => ({
    contract: FEED,
    eventName,
    args: {},
    tx,
    block: 100,
    logIndex,
  });
  const groups = groupActions([
    log("HolidaySet", "0xa", 0),
    log("HolidaySet", "0xa", 1),
    log("RoleGranted", "0xa", 2),
  ]);
  expect(groups.map((g) => [g.eventName, g.logs.length])).toEqual([
    ["RoleGranted", 1],
    ["HolidaySet", 2],
  ]);
});

test("governance: ?chain= takes the two testnets, 46630 by default", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  expect(parseGovChain(null)).toEqual({ chainId: 46630 });
  expect(parseGovChain("421614")).toEqual({ chainId: 421614 });
  expect(parseGovChain("4663")).toHaveProperty("error");
  expect(parseGovChain("abc")).toHaveProperty("error");
});

test("governance: one read per chain per 10 minutes, shared by concurrent requests, a failure retried sooner", async () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  let now = 0;
  let calls = 0;
  let fail = false;
  const answer = { chainId: 46630, deployments: [], errors: [] } as unknown as GovernanceJson;
  const cache = new GovernanceCache(
    async () => {
      calls += 1;
      if (fail) throw new Error("rpc down\nstack");
      return answer;
    },
    () => now,
  );
  const [a, b] = await Promise.all([cache.get(46630), cache.get(46630)]);
  expect(calls).toBe(1);
  expect(a.value).toBe(answer);
  expect(b.value).toBe(answer);
  now = GOV_TTL_MS - 1;
  expect((await cache.get(46630)).cached).toBe(true);
  now = GOV_TTL_MS;
  fail = true;
  expect((await cache.get(46630)).error).toBe("rpc down");
  now += GOV_ERROR_TTL_MS;
  fail = false;
  expect((await cache.get(46630)).value).toBe(answer);
  expect(calls).toBe(3);
});
