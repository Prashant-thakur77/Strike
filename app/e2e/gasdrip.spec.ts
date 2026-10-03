import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type Address, getAddress, keccak256, toFunctionSelector, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  GAS_DRIP_AMOUNT,
  GAS_DRIP_DAILY_CAP,
  GAS_DRIP_LIMITS,
  GAS_DRIP_SELECTORS,
  type GasDripStatus,
  gasDripMessage,
  leadingZeroBits,
  powValid,
  solvePow,
} from "../src/lib/gasDrip";
import {
  type GasDripChain,
  type GasDripDeps,
  challengeFor,
  gasDripLimiters,
  gasDripStatus,
  handleGasDrip,
} from "../src/lib/gasDripServer";
import { gasDripAbi } from "../../sdk/src/abi/gasDrip";
import { generatedDeployments } from "../../sdk/src/deployments.generated";
import { acknowledge, connectWallet, horizontalOverflow, installMockWallet } from "./helpers";

// The starter gas drip (GasDrip.sol, D49). Unit tests run POST and GET /api/gas-drip's logic in the test process with
// a fake chain and clock: every limit, in the order the route checks them. The page tests stub the route with
// fixtures and connect a never-used wallet on Robinhood Chain testnet (its balances are read live, so they are 0).
// The specs load no runtime SDK code (CommonJS), so the ABI and the deployments map come from their generated files.
// The live test reads the deployed drip through the built route, which has no relayer key in CI and so must report
// itself unavailable while still returning the contract's numbers.

const SECRET = "spec-secret-not-a-key-0123456789abcdef";
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "gas-drip", `${name}.json`), "utf8")) as GasDripStatus;
const sel = (sig: string) => keccak256(stringToHex(sig)).slice(0, 10);
const RELAYER = "0xA84936fA307909e01C3C9710D4cEE179385d5e9c" as Address;
const DRIP = "0x8dC1296314Df514e4fC86720DD26f0b4F3D10b27" as Address;

/** A chain where every check passes unless the test changes `state`. */
function fakeChain(state: Partial<Awaited<ReturnType<GasDripChain["read"]>>> = {}, sendFails = false) {
  const sent: Address[] = [];
  const chain: GasDripChain = {
    drip: DRIP,
    relayer: RELAYER,
    async read() {
      return {
        amount: GAS_DRIP_AMOUNT,
        dailyCap: 20,
        dripsLeftToday: 20,
        remaining: 2_000_000_000_000_000n,
        relayerBalance: 300_000_000_000_000n,
        isRelayer: true,
        check: { ok: true, reason: "0x00000000" },
        ...state,
      };
    },
    async send(to) {
      if (sendFails) throw new Error("nonce too low");
      sent.push(to);
      return `0x${"ab".repeat(32)}` as `0x${string}`;
    },
  };
  return { chain, sent };
}

function deps(
  chain: GasDripChain,
  over: Partial<GasDripDeps> = {},
  now = () => 1_791_208_800_000,
): GasDripDeps {
  return {
    secret: SECRET,
    chain: (id) => (id === 46630 ? chain : null),
    ...gasDripLimiters(now),
    now,
    difficulty: 6,
    ...over,
  };
}

async function solved(to: Address, at = 1_791_208_800_000, difficulty = 6) {
  const challenge = await challengeFor(SECRET, 46630, to, Math.floor(at / GAS_DRIP_LIMITS.challengeMs));
  return (await solvePow(challenge, difficulty))!;
}

const body = (to: string, nonce: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ chainId: 46630, address: to, nonce, ...extra });
const fresh = () => privateKeyToAddress(generatePrivateKey());

test.describe("limits (unit)", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "pure functions: one project is enough");
  });

  test("the error selectors match the contract's ABI", () => {
    const errors = gasDripAbi.filter((x) => x.type === "error").map((x) => x.name);
    for (const name of ["AlreadyDripped", "HasGas", "DailyCapReached", "Empty", "ZeroRecipient"])
      expect(errors).toContain(name);
    expect(GAS_DRIP_SELECTORS[sel("AlreadyDripped(address)")]).toBe("AlreadyDripped");
    expect(GAS_DRIP_SELECTORS[sel("DailyCapReached(uint256)")]).toBe("DailyCapReached");
    expect(Object.keys(GAS_DRIP_SELECTORS)).toHaveLength(5);
    expect(gasDripAbi.some((x) => x.type === "function" && x.name === "check")).toBe(true);
    expect(toFunctionSelector("drip(address)")).toBe(sel("drip(address)"));
  });

  test("the deployed drips are in the SDK map, with their relayer", () => {
    const map = generatedDeployments as Record<string, { gasDrip?: string; gasDripRelayer?: string }>;
    expect(map["46630"]).toMatchObject({ gasDrip: DRIP, gasDripRelayer: RELAYER });
    expect(map["421614"]).toMatchObject({
      gasDrip: getAddress("0x4ff10f0a6c1a9cc9c0a83cec6c0c5e3dd2293ead"),
      gasDripRelayer: RELAYER,
    });
    expect(map["4663"]?.gasDrip).toBeUndefined();
    expect(GAS_DRIP_DAILY_CAP).toBe(20);
  });

  test("proof of work: leading zero bits, verify and solve", async () => {
    expect(leadingZeroBits("0xffff")).toBe(0);
    expect(leadingZeroBits("0x0fff")).toBe(4);
    expect(leadingZeroBits("0x00ff")).toBe(8);
    expect(leadingZeroBits("0x001f")).toBe(11);
    expect(leadingZeroBits("0x0000")).toBe(16);
    const n = (await solvePow("abc", 10))!;
    expect(powValid("abc", n, 10)).toBe(true);
    expect(powValid("abd", n, 10) && powValid("abd", n, 30)).toBe(false);
    expect(powValid("abc", -1, 0)).toBe(false);
    expect(powValid("abc", 1.5, 0)).toBe(false);
    const ac = new AbortController();
    ac.abort();
    expect(await solvePow("abc", 64, { signal: ac.signal, batch: 10 })).toBeNull();
  });

  test("a good request is relayed once", async () => {
    const { chain, sent } = fakeChain();
    const to = fresh();
    const r = await handleGasDrip(body(to, await solved(to)), "1.2.3.4", deps(chain));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, txHash: `0x${"ab".repeat(32)}`, amount: GAS_DRIP_AMOUNT.toString() });
    expect(sent).toEqual([to]);
  });

  test("the honeypot, a bad body and a missing key are refused before anything else", async () => {
    const { chain, sent } = fakeChain();
    const to = fresh();
    const n = await solved(to);
    expect((await handleGasDrip(body(to, n, { website: "x" }), "ip", deps(chain))).body).toMatchObject({
      ok: false,
      reason: "Bot",
    });
    expect((await handleGasDrip("{not json", "ip", deps(chain))).status).toBe(400);
    expect((await handleGasDrip(body("0x123", n), "ip", deps(chain))).body).toMatchObject({
      reason: "BadRequest",
    });
    expect(
      (await handleGasDrip(JSON.stringify({ chainId: 4663, address: to, nonce: n }), "ip", deps(chain))).body,
    ).toMatchObject({ reason: "BadRequest" });
    const off = await handleGasDrip(body(to, n), "ip", deps(chain, { secret: undefined }));
    expect(off.status).toBe(503);
    expect(off.body).toMatchObject({ reason: "Unavailable" });
    expect(sent).toHaveLength(0);
  });

  test("the proof must solve this address's challenge in this window or the one before", async () => {
    const { chain, sent } = fakeChain();
    const to = fresh();
    const t0 = 1_791_208_800_000;
    const n = await solved(to, t0);
    // Another address's proof does not transfer.
    expect((await handleGasDrip(body(fresh(), n), "a", deps(chain))).body).toMatchObject({
      reason: "BadProof",
    });
    // Still good one window later; not two.
    const later = (k: number) => () => t0 + k * GAS_DRIP_LIMITS.challengeMs;
    expect((await handleGasDrip(body(to, n), "b", deps(chain, {}, later(2)))).body).toMatchObject({
      reason: "BadProof",
    });
    expect((await handleGasDrip(body(to, n), "c", deps(chain, {}, later(1)))).status).toBe(200);
    expect(sent).toEqual([to]);
  });

  test("attempts per IP: 6 per 10 minutes, with Retry-After", async () => {
    const { chain } = fakeChain();
    const d = deps(chain);
    for (let i = 0; i < GAS_DRIP_LIMITS.attemptsPer10Min; i++)
      expect((await handleGasDrip(body(fresh(), 0), "9.9.9.9", d)).status).toBe(400); // bad proofs still count
    const r = await handleGasDrip(body(fresh(), 0), "9.9.9.9", d);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ reason: "RateLimited", retryAfter: 600 });
    expect(r.headers?.["Retry-After"]).toBe("600");
    // Another IP is not affected.
    expect((await handleGasDrip(body(fresh(), 0), "8.8.8.8", d)).body).toMatchObject({ reason: "BadProof" });
  });

  test("drips per IP: 2 a day", async () => {
    const { chain, sent } = fakeChain();
    const d = deps(chain);
    for (let i = 0; i < GAS_DRIP_LIMITS.perIpPerDay; i++) {
      const to = fresh();
      expect((await handleGasDrip(body(to, await solved(to)), "7.7.7.7", d)).status).toBe(200);
    }
    const to = fresh();
    const r = await handleGasDrip(body(to, await solved(to)), "7.7.7.7", d);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ reason: "RateLimited" });
    expect((r.body as { retryAfter: number }).retryAfter).toBeGreaterThan(23 * 3600);
    expect(sent).toHaveLength(2);
  });

  test("the contract's refusals come back by name, without sending or using up the IP's drips", async () => {
    for (const [sig, reason] of [
      ["AlreadyDripped(address)", "AlreadyDripped"],
      ["HasGas(uint256)", "HasGas"],
      ["DailyCapReached(uint256)", "DailyCapReached"],
      ["Empty()", "Empty"],
    ] as const) {
      const { chain, sent } = fakeChain({ check: { ok: false, reason: sel(sig) } });
      const d = deps(chain);
      const to = fresh();
      const r = await handleGasDrip(body(to, await solved(to)), "6.6.6.6", d);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ ok: false, reason, message: gasDripMessage(reason) });
      expect(sent).toHaveLength(0);
      expect(d.ipDrips.hit("probe").ok).toBe(true);
    }
  });

  test("a relayer that is not allowed or below its floor stops the drip", async () => {
    const to = fresh();
    const n = await solved(to);
    const low = fakeChain({ relayerBalance: GAS_DRIP_LIMITS.relayerFloor - 1n });
    expect((await handleGasDrip(body(to, n), "5", deps(low.chain))).body).toMatchObject({
      reason: "RelayerLow",
    });
    const not = fakeChain({ isRelayer: false });
    expect((await handleGasDrip(body(to, n), "5", deps(not.chain))).status).toBe(503);
    const failing = fakeChain({}, true);
    const r = await handleGasDrip(body(to, n), "5", deps(failing.chain));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ reason: "Unavailable" });
  });

  test("GET: the numbers, eligibility and a challenge only for an eligible address", async () => {
    const { chain } = fakeChain();
    expect((await gasDripStatus("4663", null, deps(chain))).status).toBe(404);
    expect((await gasDripStatus("46630", "0x12", deps(chain))).status).toBe(400);
    const anon = await gasDripStatus("46630", null, deps(chain));
    expect(anon.body).toMatchObject({ available: true, amount: "100000000000000", dailyCap: 20 });
    expect((anon.body as GasDripStatus).challenge).toBeUndefined();
    const to = fresh();
    const ok = (await gasDripStatus("46630", to, deps(chain))).body as GasDripStatus;
    expect(ok.eligible).toBe(true);
    expect(ok.challenge).toBe(await challengeFor(SECRET, 46630, to, Math.floor(1_791_208_800_000 / 600_000)));
    const used = fakeChain({ check: { ok: false, reason: sel("AlreadyDripped(address)") } });
    const no = (await gasDripStatus("46630", to, deps(used.chain))).body as GasDripStatus;
    expect(no).toMatchObject({ eligible: false, reason: "AlreadyDripped" });
    expect(no.challenge).toBeUndefined();
    const off = (await gasDripStatus("46630", to, deps(chain, { secret: undefined }))).body as GasDripStatus;
    expect(off).toMatchObject({ available: false, eligible: false, reason: "Unavailable" });
  });
});

test.describe("the faucet page's Get started (fixtures)", () => {
  test.beforeEach(async ({ page }) => {
    await acknowledge(page);
  });

  test("a new wallet gets starter gas: anti-bot work, relayed drip, tx link", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const account = fresh();
    const status = fixture("status-eligible");
    let posted: { chainId: number; address: string; nonce: number; website: string } | null = null;
    await page.route("**/api/gas-drip**", async (route) => {
      if (route.request().method() === "POST") {
        posted = route.request().postDataJSON();
        return route.fulfill({
          json: { ok: true, txHash: `0x${"cd".repeat(32)}`, amount: status.amount },
        });
      }
      return route.fulfill({ json: status });
    });
    await installMockWallet(page, account, [], 46630);
    await page.goto("/app/faucet?chain=46630");
    const start = page.getByRole("region", { name: "Get started with no test ETH" });
    await expect(start).toBeVisible();
    await expect(page.getByTestId("start-connect")).toHaveAttribute("data-state", "current");
    await expect(page.getByTestId("gas-drip-limits")).toContainText("once per wallet");
    await expect(page.getByTestId("gas-drip-limits")).toContainText("17 of 20 drips left today");
    await expect(page.getByTestId("gas-drip-limits")).toContainText("2 per connection per day");
    await connectWallet(page, mobile);
    await expect(page.getByTestId("start-connect")).toHaveAttribute("data-state", "done");
    const gas = page.getByTestId("start-gas");
    await expect(gas).toHaveAttribute("data-state", "current");
    // USDG waits for gas: claiming it is a transaction.
    await expect(page.getByTestId("start-usdg")).toContainText("After the gas");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await gas.getByRole("button", { name: "Get 0.0001 test ETH" }).click();
    await expect(gas.getByText("Starter gas sent.")).toBeVisible();
    await expect(gas.getByRole("link", { name: "View" })).toHaveAttribute("href", /\/tx\/0x(cd){32}$/);
    expect(posted).not.toBeNull();
    const p = posted!;
    expect(p).toMatchObject({ chainId: 46630, address: account, website: "" });
    expect(powValid(status.challenge!, p.nonce, status.difficulty)).toBe(true);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a wallet that already had its drip is told so and pointed at the chain's faucet", async ({
    page,
  }, info) => {
    await page.route("**/api/gas-drip**", (route) => route.fulfill({ json: fixture("status-already") }));
    await installMockWallet(page, fresh(), [], 46630);
    await page.goto("/app/faucet?chain=46630");
    await connectWallet(page, info.project.name === "mobile");
    const gas = page.getByTestId("start-gas");
    await expect(gas).toContainText("already had its starter gas");
    await expect(gas.getByRole("link", { name: /faucet/ })).toHaveAttribute("href", /faucet/);
    await expect(gas.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("gas-drip-limits")).toContainText("0 of 20 drips left today");
  });

  test("the route refusing a drip shows its message", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one is enough");
    await page.route("**/api/gas-drip**", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 429,
            json: {
              ok: false,
              reason: "RateLimited",
              message: gasDripMessage("RateLimited", 600),
              retryAfter: 600,
            },
          })
        : route.fulfill({ json: fixture("status-eligible") }),
    );
    await installMockWallet(page, fresh(), [], 46630);
    await page.goto("/app/faucet?chain=46630");
    await connectWallet(page, false);
    await page
      .getByTestId("start-gas")
      .getByRole("button", { name: /test ETH/ })
      .click();
    await expect(page.getByRole("alert").filter({ hasText: "Too many requests" })).toContainText("10 min");
  });
});

test("live: the route reads the deployed drip on both testnets", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "one is enough");
  for (const chainId of [46630, 421614]) {
    const res = await request.get(`/api/gas-drip?chainId=${chainId}&address=${fresh()}`);
    test.skip(res.status() === 502, "chain RPC unreachable");
    expect(res.status()).toBe(200);
    const s = (await res.json()) as GasDripStatus;
    expect(s.drip).toBe(
      (generatedDeployments as Record<string, { gasDrip?: string }>)[String(chainId)].gasDrip,
    );
    expect(s.amount).toBe(GAS_DRIP_AMOUNT.toString());
    expect(s.dailyCap).toBe(GAS_DRIP_DAILY_CAP);
    expect(s.dripsLeftToday).toBeLessThanOrEqual(GAS_DRIP_DAILY_CAP);
    // A never-used address qualifies on chain; without GAS_RELAYER_KEY the route says it is off instead.
    if (!s.available) expect(s).toMatchObject({ eligible: false, reason: "Unavailable" });
    else expect(s.eligible).toBe(true);
  }
});
