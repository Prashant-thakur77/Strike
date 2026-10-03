import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildTrace, type EpochTraceJson, type TraceContext, type TraceLog } from "../src/lib/epochTrace";
import { settlementLine, type SettlementAuditJson } from "../src/lib/settlementAudit";
import { acknowledge, horizontalOverflow, settle } from "./helpers";
import { PHASE_SELECTORS, patchEthCalls, vaultPhase } from "./lifecycle";

// The epoch trace on the vault page (rail "Epoch trace"): every step of the current and the last epoch with its
// transaction and evidence. The first group builds traces from decoded logs without a network (src/lib/epochTrace.ts)
// and words the settlement check. The second renders a settled epoch and a pending one from fixtures of
// /api/epoch-trace and /api/settlement-audit on a live vault page (the settled state cannot be read live before the
// 2 October settlement). The last calls the built routes against the live chains: v2 and v3 on 46630 and v3 on 421614,
// whose first epochs' transactions are in contracts/deployments and docs/testnet-epochs. Set TRACE_SHOTS=<dir> to save
// the rail as <project>-trace-*.png.

const pure = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
const at = (iso: string) => Date.parse(iso) / 1000;
const E18 = 10n ** 18n;
const usd = (n: number) => (BigInt(Math.round(n * 100)) * E18) / 100n;
const VAULT = "0x478E7BC3C3aB07fdd104e4765F178977adEe6285"; // v3 TSLA covered call, 46630
const OTHER = "0x1bc73c1B28F520E57982FAe6127477190FA53690";
const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const SERIES = 48103703716925406245656156603615117052914973735876202170787552644395932337728n;
const EXPIRY = at("2026-10-02T20:00:00Z");
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let idx = 0;
function log(
  source: TraceLog["source"],
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  time: number | null = null,
): TraceLog {
  return { source, eventName, args, tx: tx(block), block: BigInt(block), logIndex: idx++, time };
}

const CTX: TraceContext = {
  chainId: 46630,
  vault: VAULT,
  explorer: "https://explorer.testnet.chain.robinhood.com",
  currentEpoch: 2n,
  state: 2,
  isCall: true,
  underlying: { address: TSLA, symbol: "TSLA", decimals: 18 },
  asset: { symbol: "TSLA", decimals: 18 },
  shareDecimals: 18,
  usdgDecimals: 6,
  openSigma: 6n * 10n ** 17n,
  now: at("2026-10-05T16:00:00Z"),
};

/** Epoch 1: opened, a record, accepted, two buys, settled at round 17, a redemption and claims. Epoch 2: opened,
 *  rejected and slashed, then accepted. Plus another vault's events, which must not appear. */
function logs(): TraceLog[] {
  idx = 0;
  const T1 = at("2026-10-01T14:00:00Z");
  return [
    log("epochManager", "EpochOpened", { vault: VAULT, epoch: 1n, spot: usd(358.55) }, 100, T1),
    log(
      "decisionLog",
      "DecisionRecorded",
      {
        agentId: 1n,
        vault: VAULT,
        epoch: 1n,
        recordHash: `0x${"ab".repeat(32)}`,
        uri: "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/2026-10-01-sTSLA-CC-2.md",
        timestamp: BigInt(T1 + 60),
      },
      101,
      T1 + 60,
    ),
    log(
      "epochManager",
      "SeriesProposed",
      {
        vault: VAULT,
        epoch: 1n,
        seriesId: SERIES,
        strike: usd(369.36),
        expiry: EXPIRY,
        size: 4n * E18,
        premiumBps: 10_500,
        fairValue: usd(1.36),
        delta: 2n * 10n ** 17n,
      },
      102,
      T1 + 120,
    ),
    log(
      "epochManager",
      "OptionsBought",
      {
        seriesId: SERIES,
        buyer: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff",
        recipient: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff",
        amount: 3n * E18,
        premium: 5_541_000n,
      },
      103,
      T1 + 600,
    ),
    log(
      "epochManager",
      "OptionsBought",
      {
        seriesId: SERIES,
        buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        amount: E18,
        premium: 1_847_000n,
      },
      104,
      T1 + 900,
    ),
    // Another vault's proposal in the same EpochManager: ignored.
    log(
      "epochManager",
      "ProposalRejected",
      {
        vault: OTHER,
        epoch: 1n,
        agentId: 1n,
        reason: 8,
        slashed: 10_000_000n,
        strike: usd(352),
        expiry: EXPIRY,
        size: E18,
        premiumBps: 10_000,
      },
      105,
      T1 + 1000,
    ),
    log(
      "oracle",
      "SettlementPriceRecorded",
      { token: TSLA, expiry: EXPIRY, roundId: 17n, price: usd(371.2) },
      200,
      EXPIRY + 2460,
    ),
    log(
      "epochManager",
      "EpochSettled",
      {
        vault: VAULT,
        epoch: 1n,
        seriesId: SERIES,
        settlementPrice: usd(371.2),
        payout: 19_752_000_000_000_000n,
        premium: 7_388_000n,
        fee: 0n,
      },
      200,
      EXPIRY + 2460,
    ),
    log(
      "vault",
      "EpochSettled",
      {
        epoch: 1n,
        payout: 19_752_000_000_000_000n,
        premium: 7_388_000n,
        assets: 5n * E18,
        supply: 5n * E18,
        accPremium: 0n,
      },
      200,
      EXPIRY + 2460,
    ),
    log(
      "epochManager",
      "OptionsRedeemed",
      {
        seriesId: SERIES,
        holder: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff",
        recipient: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff",
        amount: 3n * E18,
        paid: 14_814_000_000_000_000n,
      },
      201,
      EXPIRY + 3000,
    ),
    log(
      "vault",
      "RedeemClaimed",
      { account: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff", epoch: 1n, shares: E18, assets: E18 },
      202,
      EXPIRY + 3100,
    ),
    log(
      "vault",
      "PremiumClaimed",
      { account: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff", amount: 7_388_000n },
      203,
      EXPIRY + 3200,
    ),
    log(
      "epochManager",
      "EpochOpened",
      { vault: VAULT, epoch: 2n, spot: usd(372.1) },
      300,
      at("2026-10-05T15:01:00Z"),
    ),
    log(
      "epochManager",
      "ProposalRejected",
      {
        vault: VAULT,
        epoch: 2n,
        agentId: 1n,
        reason: 8,
        slashed: 10_000_000n,
        strike: usd(372.1),
        expiry: at("2026-10-09T20:00:00Z"),
        size: E18,
        premiumBps: 10_000,
      },
      301,
      at("2026-10-05T15:02:00Z"),
    ),
    log(
      "epochManager",
      "SeriesProposed",
      {
        vault: VAULT,
        epoch: 2n,
        seriesId: 7n,
        strike: usd(390.5),
        expiry: at("2026-10-09T20:00:00Z"),
        size: 4n * E18,
        premiumBps: 10_000,
        fairValue: usd(2.1),
        delta: -2n * 10n ** 17n,
      },
      302,
      at("2026-10-05T15:03:00Z"),
    ),
  ];
}

test.describe("epoch trace from logs", () => {
  test("the current and the last epoch, each step in chain order with its evidence", () => {
    pure();
    const t = buildTrace(CTX, logs());
    expect(t.epochs.map((e) => [e.epoch, e.current, e.status])).toEqual([
      ["2", true, "selling"],
      ["1", false, "settled"],
    ]);
    const [cur, last] = t.epochs;
    expect(cur!.steps.map((s) => s.kind)).toEqual(["open", "rejected", "accepted", "pending"]);
    expect(cur!.steps[0]!.facts).toEqual([
      "Snapshot spot $372.10: every proposal this epoch is priced against it",
      "Snapshot volatility 60%",
      "Vault locked: deposits and withdrawals queue until the epoch closes",
    ]);
    expect(cur!.steps[1]).toMatchObject({
      title: "Proposal rejected: DeltaOutOfBand",
      tone: "bad",
      tx: tx(301),
    });
    expect(cur!.steps[1]!.facts[1]).toBe(
      "Agent #1 slashed 10 USDG from its bond, paid to this vault's depositors when the epoch closes",
    );
    expect(cur!.steps[2]!.facts[1]).toBe(
      "Fair value $2.10 per option, |delta| 0.20, inside the vault's mandate",
    );
    expect(cur!.steps[3]).toMatchObject({ kind: "pending", tx: null });
    expect(cur!.steps[3]!.facts[0]).toBe(
      "Settles after 20:00 UTC on Fri 9 Oct, at the first price round at or after expiry. Anyone may call settle then.",
    );

    expect(last!.steps.map((s) => s.kind)).toEqual([
      "open",
      "record",
      "accepted",
      "buy",
      "buy",
      "settle",
      "redeem",
      "claim",
      "claim",
    ]);
    expect(last!.seriesId).toBe(SERIES.toString());
    expect(last!.steps[0]!.facts).toHaveLength(2); // no volatility for an earlier epoch: only the current one is stored
    expect(last!.steps[1]).toMatchObject({
      title: "Decision record anchored in DecisionLog",
      record: { agentId: "1" },
    });
    expect(last!.steps[3]).toMatchObject({ title: "Bought 3 calls", tx: tx(103) });
    expect(last!.steps[3]!.facts[0]).toBe("5.54 USDG premium, escrowed for the vault until settlement");
    const s = last!.steps[5]!;
    expect(s).toMatchObject({
      title: "Settled at $371.20",
      tone: "good",
      round: { roundId: "17", price: "$371.20" },
    });
    expect(s.facts).toEqual([
      "Settlement price $371.20, MirrorFeed round 17",
      "Paid to option holders: 0.0198 TSLA",
      "Premium to the vault: 7.39 USDG",
    ]);
    expect(last!.steps[6]!.facts[0]).toBe("Paid 0.0148 TSLA to 0x26b277…13Ff");
    expect(last!.steps.slice(7).map((x) => x.title)).toEqual(["Withdrawal claimed", "Premium claimed"]);
    expect(last!.steps[4]!.title).toBe("Bought 1 call");
    expect(last!.steps[7]!.facts[0]).toBe("1 TSLA for 1 share, by 0x26b277…13Ff");
    // Nothing of the other vault.
    expect(JSON.stringify(t)).not.toContain(tx(105));
  });

  test("an expired series still selling waits for settle; an aborted epoch pays the slash", () => {
    pure();
    idx = 0;
    const T = at("2026-09-29T14:00:00Z");
    const aborted = buildTrace(
      { ...CTX, currentEpoch: 1n, state: 0, isCall: false, asset: { symbol: "USDG", decimals: 6 } },
      [
        log("epochManager", "EpochOpened", { vault: VAULT, epoch: 1n, spot: usd(352.45) }, 10, T),
        log(
          "epochManager",
          "ProposalRejected",
          {
            vault: VAULT,
            epoch: 1n,
            agentId: 1n,
            reason: 8,
            slashed: 10_000_000n,
            strike: usd(352.44),
            expiry: EXPIRY,
            size: 4540n * 10n ** 13n,
            premiumBps: 10_000,
          },
          11,
          T,
        ),
        log("epochManager", "EpochAborted", { vault: VAULT, epoch: 1n }, 12, T + 86_400),
        log(
          "vault",
          "EpochSettled",
          {
            epoch: 1n,
            payout: 0n,
            premium: 10_000_000n,
            assets: 30_000_000n,
            supply: 20n * E18,
            accPremium: 0n,
          },
          12,
          T + 86_400,
        ),
      ],
    );
    expect(aborted.epochs[0]!.status).toBe("aborted");
    expect(aborted.epochs[0]!.steps.map((s) => s.kind)).toEqual(["open", "rejected", "abort"]);
    expect(aborted.epochs[0]!.steps[2]!.facts).toEqual([
      "10 USDG of slashed bonds paid to the vault's depositors",
    ]);

    const expired = buildTrace({ ...CTX, currentEpoch: 1n, now: EXPIRY + 600 }, logs().slice(0, 5));
    const pending = expired.epochs[0]!.steps.at(-1)!;
    expect(pending.kind).toBe("pending");
    expect(pending.facts[0]).toBe(
      "Expired at 20:00 UTC on Fri 2 Oct; waiting for the first price round at or after expiry (the settlement price), then for the settle transaction, which anyone may send.",
    );
    expect(buildTrace({ ...CTX, currentEpoch: 0n }, []).epochs).toEqual([]);
  });

  test("a depositor finds their own deposit: queued, before the first epoch and after an abort (QA, 3 Oct)", () => {
    pure();
    idx = 0;
    const T = at("2026-10-01T14:00:00Z");
    const QA = "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044";
    const CURATOR = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";
    const put = {
      ...CTX,
      currentEpoch: 1n,
      state: 0,
      isCall: false,
      asset: { symbol: "USDG", decimals: 6 },
      shareDecimals: 6,
    };
    const t = buildTrace(put, [
      log(
        "vault",
        "Deposit",
        { sender: CURATOR, owner: CURATOR, assets: 50_000_000n, shares: 50_000_000n },
        5,
        T - 600,
      ),
      log("epochManager", "EpochOpened", { vault: VAULT, epoch: 1n, spot: usd(358.55) }, 10, T),
      log("vault", "DepositRequested", { account: QA, epoch: 1n, assets: 2_000_000n }, 11, T + 60),
      log("vault", "RedeemRequested", { account: CURATOR, epoch: 1n, shares: 1_000_000n }, 12, T + 90),
      log("epochManager", "EpochAborted", { vault: VAULT, epoch: 1n }, 20, T + 3600),
      log(
        "vault",
        "Deposit",
        { sender: QA, owner: QA, assets: 5_000_000n, shares: 5_000_000n },
        30,
        T + 7200,
      ),
      log(
        "vault",
        "Withdraw",
        { sender: QA, receiver: QA, owner: QA, assets: 2_000_000n, shares: 2_000_000n },
        31,
        T + 7300,
      ),
      // Another vault's deposit is a log of that vault's address, which the reader never fetches; a deposit of this
      // vault during the epoch cannot happen (deposit reverts while locked).
    ]);
    const steps = t.epochs[0]!.steps;
    expect(steps.map((x) => x.kind)).toEqual([
      "deposit",
      "open",
      "queue",
      "queue",
      "abort",
      "deposit",
      "withdraw",
    ]);
    expect(steps[0]).toMatchObject({ title: "Deposited before epoch 1", tx: tx(5) });
    expect(steps[0]!.facts).toEqual(["50 USDG for 50 shares, by 0x26b277…13Ff"]);
    expect(steps[2]!.title).toBe("Deposit queued");
    expect(steps[2]!.facts[0]).toBe(
      "2 USDG by 0x7767ca…0044: becomes shares at this epoch's closing price, claimable after settlement",
    );
    expect(steps[3]!.title).toBe("Withdrawal queued");
    expect(steps[5]).toMatchObject({ title: "Deposited (vault unlocked)", tx: tx(30) });
    expect(steps[5]!.facts).toEqual(["5 USDG for 5 shares, by 0x7767ca…0044"]);
    expect(steps[6]).toMatchObject({ title: "Withdrew (vault unlocked)", tx: tx(31) });
    expect(steps[6]!.facts).toEqual(["2 shares for 2 USDG, to 0x7767ca…0044"]);

    // Once epoch 2 opens, the moves after epoch 1 closed stay with epoch 1, and none of them repeat under epoch 2.
    const two = buildTrace({ ...put, currentEpoch: 2n, state: 1 }, [
      log("epochManager", "EpochOpened", { vault: VAULT, epoch: 1n, spot: usd(358.55) }, 10, T),
      log("epochManager", "EpochAborted", { vault: VAULT, epoch: 1n }, 20, T + 3600),
      log(
        "vault",
        "Deposit",
        { sender: QA, owner: QA, assets: 5_000_000n, shares: 5_000_000n },
        30,
        T + 7200,
      ),
      log("epochManager", "EpochOpened", { vault: VAULT, epoch: 2n, spot: usd(370) }, 40, T + 86_400),
    ]);
    expect(two.epochs.map((e) => e.steps.map((x) => x.kind))).toEqual([
      ["open"],
      ["open", "abort", "deposit"],
    ]);
  });

  test("words the settlement check", () => {
    pure();
    const base = {
      seriesId: "1",
      epoch: "1",
      symbol: "TSLA",
      expiry: EXPIRY,
      settled: true,
      roundId: "17",
      roundSource: "recorded" as const,
      recordTx: tx(200),
      mainnetRoundId: "18446744073709553100",
      mainnetPhase: 1,
      mainnetAggregatorRound: "3084",
      sameAsMainnetSettlement: true,
      skippedMainnetRounds: 0,
      message: "",
    };
    expect(settlementLine({ ...base, status: "verified" })).toEqual({
      tone: "good",
      text: "Round 17 matches mainnet Chainlink round 18446744073709553100 (phase 1, aggregator round 3084): same time, same answer. It is the first mainnet print at or after expiry, the round a mainnet settlement would use.",
    });
    expect(
      settlementLine({ ...base, status: "verified", sameAsMainnetSettlement: false, skippedMainnetRounds: 2 })
        .text,
    ).toContain("the keeper skipped 2 earlier round(s)");
    expect(
      settlementLine({ ...base, settled: false, roundSource: "candidate", status: "candidate-verified" })
        .text,
    ).toBe(
      "Expired, not settled yet: it will settle at round 17, which matches mainnet Chainlink round 18446744073709553100 (phase 1, aggregator round 3084).",
    );
    expect(
      settlementLine({ ...base, status: "mismatch", message: "Settled at round 17: MISMATCH." }),
    ).toEqual({
      tone: "bad",
      text: "Settled at round 17: MISMATCH.",
    });
  });
});

/* ------------------------------------------------------------------ the rail, from fixtures */

const TESTNET_RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
async function testnetUp(): Promise<boolean> {
  try {
    const res = await fetch(TESTNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return Number(((await res.json()) as { result?: string }).result) === 46630;
  } catch {
    return false;
  }
}

/** JSON as the route sends it (bigints never reach the trace: it is all strings and numbers). */
const asJson = (t: EpochTraceJson) => JSON.parse(JSON.stringify(t)) as EpochTraceJson;

function auditFixture(trace: EpochTraceJson): SettlementAuditJson {
  return {
    chainId: 46630,
    vault: VAULT,
    version: "v3",
    ok: true,
    testnetTime: trace.now,
    series: [
      {
        seriesId: SERIES.toString(),
        epoch: "1",
        symbol: "TSLA",
        expiry: EXPIRY,
        settled: true,
        status: "verified",
        roundId: "17",
        roundSource: "recorded",
        recordTx: tx(200),
        mainnetRoundId: "18446744073709553100",
        mainnetPhase: 1,
        mainnetAggregatorRound: "3084",
        sameAsMainnetSettlement: true,
        skippedMainnetRounds: 0,
        message: "",
      },
    ],
  };
}

async function serve(page: Page, trace: EpochTraceJson, audit?: SettlementAuditJson) {
  const asked = { trace: 0, audit: 0 };
  await page.route("**/api/epoch-trace?**", (route) => {
    asked.trace++;
    return route.fulfill({ json: asJson(trace) });
  });
  await page.route("**/api/settlement-audit?**", (route) => {
    asked.audit++;
    return audit
      ? route.fulfill({ json: audit })
      : route.fulfill({ status: 502, json: { error: "HTTP 503" } });
  });
  return asked;
}

async function shot(page: Page, name: string) {
  const dir = process.env.TRACE_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await settle(page, 800);
  const box = (await page.locator("#trace").boundingBox())!;
  await page.screenshot({
    path: join(dir, `${test.info().project.name}-trace-${name}.png`),
    fullPage: true,
    clip: { x: 0, y: box.y - 16, width: page.viewportSize()!.width, height: box.height + 32 },
  });
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("vault page: a settled epoch shows its round, the mainnet match and every transaction", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  const trace = buildTrace(CTX, logs());
  await serve(page, trace, auditFixture(trace));
  await page.goto(`/app/vault/${VAULT}?chain=46630#trace`);
  const rail = page.locator("#trace");
  await expect(rail.getByRole("heading", { name: "Epoch trace" })).toBeVisible({ timeout: 45_000 });
  const last = rail.locator('[data-testid="trace-epoch"][data-epoch="1"]');
  await expect(last).toHaveAttribute("data-status", "settled");
  const settled = last.locator('[data-kind="settle"]');
  await expect(settled).toContainText("Settled at $371.20");
  await expect(settled.getByTestId("trace-round")).toHaveText(
    "Recorded by the StockOracle: round 17 at $371.20",
  );
  await expect(settled.getByTestId("trace-audit")).toHaveAttribute("data-status", "verified");
  await expect(settled.getByTestId("trace-audit")).toContainText(
    "✓ Round 17 matches mainnet Chainlink round 18446744073709553100 (phase 1, aggregator round 3084): same time, same answer.",
  );
  await expect(settled.getByTestId("trace-tx")).toHaveAttribute(
    "href",
    `https://explorer.testnet.chain.robinhood.com/tx/${tx(200)}`,
  );
  await expect(last.locator('[data-kind="buy"]')).toHaveCount(2);
  await expect(last.locator('[data-kind="redeem"]')).toContainText("Redeemed 3 options");
  await expect(last.locator('[data-kind="claim"]')).toHaveCount(2);
  // An earlier epoch's record links to the record, not to the current "Why this strike".
  await expect(
    last.locator('[data-kind="record"]').getByRole("link", { name: /the record/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/2026-10-01-sTSLA-CC-2.md",
  );
  await expect(last.getByTestId("trace-why")).toHaveCount(0);

  const cur = rail.locator('[data-testid="trace-epoch"][data-epoch="2"]');
  await expect(cur).toHaveAttribute("data-status", "selling");
  await expect(cur.locator('[data-kind="rejected"]')).toContainText("Proposal rejected: DeltaOutOfBand");
  await expect(cur.locator('[data-kind="rejected"]')).toContainText("slashed 10 USDG from its bond");
  await expect(cur.locator('[data-kind="pending"]')).toContainText("Settles after 20:00 UTC on Fri 9 Oct");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "settled");
});

test("vault page: before expiry the settlement step says when; the current record links to Why this strike", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  const trace = buildTrace({ ...CTX, currentEpoch: 1n, now: at("2026-10-02T15:00:00Z") }, logs().slice(0, 5));
  const asked = await serve(page, trace);
  // The rest of the page in the same state as the trace: the series on sale, before its expiry (lifecycle.ts).
  await patchEthCalls(page, 46630, "https://rpc.testnet.chain.robinhood.com", PHASE_SELECTORS, [
    vaultPhase({ vault: VAULT, seriesId: SERIES, phase: "selling" }),
  ]);
  await page.goto(`/app/vault/${VAULT}?chain=46630#trace`);
  const rail = page.locator("#trace");
  const cur = rail.locator('[data-testid="trace-epoch"][data-epoch="1"]');
  await expect(cur).toHaveAttribute("data-status", "selling", { timeout: 45_000 });
  await expect(cur.locator('[data-kind="pending"]')).toContainText(
    "Settles after 20:00 UTC on Fri 2 Oct, at the first price round at or after expiry. Anyone may call settle then.",
  );
  await expect(cur.getByTestId("trace-why")).toHaveAttribute("href", "#why");
  await expect(cur.getByTestId("trace-audit")).toHaveCount(0);
  expect(asked.audit).toBe(0); // nothing expired: the mainnet check is not asked for, by the trace or the series rail
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "pending");
});

test("vault page: the trace says when its route fails, with a retry", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await page.route("**/api/epoch-trace?**", (route) =>
    route.fulfill({ status: 502, json: { error: "Could not read the epoch trace: HTTP 503" } }),
  );
  await page.goto(`/app/vault/${VAULT}?chain=46630#trace`);
  await expect(page.getByTestId("trace-error")).toContainText("Couldn't read the epoch trace", {
    timeout: 45_000,
  });
});

/* ------------------------------------------------------------------ the built routes, live */

/** Each live first epoch, by its transactions (contracts/deployments/*.json and docs/testnet-epochs). */
const LIVE = [
  {
    name: "v2 call, 46630",
    chain: 46630,
    vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    steps: [
      ["accepted", "0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4"],
      ["buy", "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9"],
    ],
  },
  {
    name: "v2 put, 46630 (rejected, slashed, aborted)",
    chain: 46630,
    vault: "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
    steps: [
      ["rejected", "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0"],
      ["abort", "0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7"],
    ],
  },
  {
    name: "v3 call, 46630",
    chain: 46630,
    vault: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
    steps: [
      ["open", "0x4b179fb1809a4777961e5fe1439f7ad4dd2c418f4cc2e20c99b397d561d959e1"],
      ["accepted", "0xe823a351b82404077c126482ca61f6be9c1c461606b4626f55bea1898d335a45"],
      ["buy", "0x16d9345d815d1d5fb5a39540533b725367cfbaeab0287647f984d0202b6a61fc"],
      ["record", "0x00e27fe12ab6b01507f55aba3b32b9576d2bcdf84dbede88c8bee2223aef6388"],
    ],
  },
  {
    name: "v3 call, 421614",
    chain: 421614,
    vault: "0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
    steps: [
      ["open", "0x9865efd793e63ee8386e4a670eeb0bc65f5d45f1c3070126bc295f261a98de59"],
      ["accepted", "0xf26315b33df93548bfa31d68b7d9964792ef88184cb154796180e19b9365b5f4"],
      ["buy", "0x82e2d5b4e476edec205c80daca431a8becdd5fbdb1f84e3ca0dea8d7d49265f4"],
      ["record", "0x1f9f7eafdf448c205df43e81d75e94f5282dd3b2bb465473330012c04cac3538"],
    ],
  },
] as const;

for (const c of LIVE) {
  test(`GET /api/epoch-trace: epoch 1 of the ${c.name}, step by step`, async ({ request }) => {
    test.skip(test.info().project.name !== "desktop", "one project is enough");
    test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
    const res = await request.get(`/api/epoch-trace?chain=${c.chain}&vault=${c.vault}`, { timeout: 90_000 });
    test.skip(res.status() === 502, `the route could not read the chain: ${(await res.json()).error}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("s-maxage=60");
    const t = (await res.json()) as EpochTraceJson;
    // Epoch 1 stays in the trace while it is the current or the previous epoch.
    const e1 = t.epochs.find((e) => e.epoch === "1");
    test.skip(!e1, "epoch 1 is older than the previous epoch now");
    for (const [kind, hash] of c.steps) {
      expect(e1!.steps.find((s) => s.tx === hash)?.kind, `${kind} ${hash}`).toBe(kind);
    }
    const kinds = e1!.steps.map((s) => s.kind);
    // The vault's first deposits come before epoch 1 opened; then the opening.
    const open = kinds.indexOf("open");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(kinds.slice(0, open).every((k) => k === "deposit")).toBe(true);
    if (e1!.status === "settled") expect(kinds).toContain("settle");
  });
}

test("GET /api/epoch-trace and /api/settlement-audit: 400 for another chain or a non-vault", async ({
  request,
}) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  const chain = await request.get(
    "/api/epoch-trace?chain=4663&vault=0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
  );
  expect(chain.status()).toBe(400);
  expect((await chain.json()).error).toMatch(/chain must be a chain with a Strike deployment/);
  const addr = await request.get("/api/settlement-audit?chain=46630&vault=nope");
  expect(addr.status()).toBe(400);
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  const none = await request.get(
    "/api/epoch-trace?chain=46630&vault=0x0000000000000000000000000000000000000001",
  );
  expect(none.status()).toBe(400);
  expect((await none.json()).error).toMatch(/is not a Strike vault on chain 46630/);
});

test("vault page, live: the trace links the agent's accepted proposal on the explorer", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await page.goto("/app/vault/0x478E7BC3C3aB07fdd104e4765F178977adEe6285?chain=46630#trace");
  const rail = page.locator("#trace");
  const e1 = rail.locator('[data-testid="trace-epoch"][data-epoch="1"]');
  await expect(e1).toBeVisible({ timeout: 90_000 });
  await expect(e1.locator('[data-kind="accepted"]').getByTestId("trace-tx")).toHaveAttribute(
    "href",
    "https://explorer.testnet.chain.robinhood.com/tx/0xe823a351b82404077c126482ca61f6be9c1c461606b4626f55bea1898d335a45",
  );
  await shot(page, "live");
});
