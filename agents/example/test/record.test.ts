import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prettier from "prettier";
import { keccak256, toBytes } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_TX_LABEL,
  type AnchorRequest,
  type AnchorSender,
  anchorEpoch,
  anchorRecord,
  chainAnchorSender,
  decisionLogAddress,
  hashText,
  recordHash,
  recordUrl,
  unanchoredJson,
  verifyAnchoredRecord,
} from "../src/anchor.js";
import { Journal, marketInputs, proposeResult } from "../src/journal.js";
import {
  type DecisionRecord,
  formatRecordJson,
  formatRecordMarkdown,
  recordBaseName,
  txUrl,
  writeRecord,
} from "../src/record.js";
import type { AgentStats, ProposeResult, RiskCheck, VaultState } from "../src/types.js";

// The --log decision record: what it contains, how it links transactions, and that prettier leaves it alone (the
// weekly workflow commits these files and CI runs prettier --check).

const OPEN_TX = `0x${"a".repeat(64)}`;
const PROPOSE_TX = `0x${"b".repeat(64)}`;
const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
  summary:
    "|delta| 0.10-0.35, premium >= 95% of fair value, yield >= 0.05% of collateral, size <= 80% of capacity, tenor 1-8 days",
};

const state = (epochState: "Idle" | "Open" | "Selling" = "Idle"): VaultState => ({
  vault: {
    address: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    symbol: "sTSLA-CC",
    name: "Strike TSLA Covered Call",
    kind: "covered-call",
    epochState,
    agentId: "1",
    underlying: { symbol: "TSLA" },
    asset: { symbol: "TSLA" },
    totalAssets: "5",
    sigma: 0.55,
    mandate,
    series: null,
  },
  spot: { price: "352.453", status: "Ok", ok: true },
  marketOpen: true,
  blockTimeIso: "2026-10-05T15:02:11.000Z",
  nextExpiryIso: "2026-10-09T20:00:00.000Z",
  agent: { agentId: "1", active: true, bond: "60", strikes: 0 },
  nextStep: "Idle and ready",
});

const check: RiskCheck = {
  vaultSymbol: "sTSLA-CC",
  isCall: true,
  proposal: {
    mode: "delta",
    strike: "369.86",
    targetDeltaBps: 2000,
    expiryIso: "2026-10-09T20:00:00.000Z",
    size: "4",
    premiumBps: 10_000,
  },
  ok: true,
  reason: "None",
  explanation: "Inside the mandate: the contract would accept this proposal.",
  measured: { fairValue: "2.1268", delta: 0.2, capacity: "5", yieldBps: 60.34 },
  spot: "352.453",
  suggestion: null,
};

const accepted: ProposeResult = {
  submitted: true,
  accepted: true,
  reason: "None",
  explanation:
    "Accepted: series 42 is on sale (strike $369.86, |delta| 0.2, expiry 2026-10-09T20:00:00.000Z).",
  seriesId: "42",
  strike: "369.86",
  expiry: 1_791_576_000,
  size: "4",
  slashed: "0",
  txHash: PROPOSE_TX,
  openTxHash: OPEN_TX,
  agent: { bond: "60", strikes: 0, maxStrikes: 3, rejected: 0, active: true },
};

const stats: AgentStats = {
  agentId: "1",
  status: "Active",
  active: true,
  bond: "60",
  strikes: 0,
  maxStrikes: 3,
  accepted: 3,
  rejected: 1,
  settledEpochs: 2,
  cumulativePnl: "4.25",
  claimableFees: "0.4",
  erc8004Id: "0",
  rejectionsUntilInactive: 3,
};

/** An accepted default-strategy proposal on Robinhood Chain testnet, as the agent records it. */
function acceptedRecord(): DecisionRecord {
  const j = new Journal("propose", 46630, "0x26b277b434B1670f207Afd8946edA9AF78A613Ff");
  j.vaultRead(state());
  j.decided({
    strategy: "default",
    targetDeltaBps: 2000,
    premiumBps: 10_000,
    reasoning:
      "Target 0.20 delta: far enough out of the money that the stock rarely gets called away, close enough to earn a meaningful premium. Price at 100% of Black-Scholes fair value.",
    notes: [],
  });
  j.dryRan(check);
  j.proposed(accepted, "proposeByDelta");
  j.market = marketInputs(state("Selling"), {
    state: "Selling",
    openedAt: 1_791_212_531,
    openSpot: "352.453",
    openSigma: 0.55,
  });
  j.tracked(stats);
  const r = j.build();
  if (!r) throw new Error("no record");
  return r;
}

async function prettierClean(text: string, filepath: string) {
  const options = (await prettier.resolveConfig(join(process.cwd(), filepath))) ?? {};
  return prettier.format(text, { ...options, filepath });
}

describe("decision record", () => {
  it("names files <date>-<vault symbol> from the chain date", () => {
    const r = acceptedRecord();
    expect(r.date).toBe("2026-10-05");
    expect(recordBaseName(r)).toBe("2026-10-05-sTSLA-CC");
  });

  it("links transactions to Blockscout on chain 46630 and not on the local devnet", () => {
    expect(txUrl(46630, PROPOSE_TX)).toBe(`https://explorer.testnet.chain.robinhood.com/tx/${PROPOSE_TX}`);
    expect(txUrl(31337, PROPOSE_TX)).toBeNull();
    const md = formatRecordMarkdown(acceptedRecord());
    expect(md).toContain(
      `- openEpoch: [\`${OPEN_TX}\`](https://explorer.testnet.chain.robinhood.com/tx/${OPEN_TX})`,
    );
    expect(md).toContain(
      `- proposeByDelta: [\`${PROPOSE_TX}\`](https://explorer.testnet.chain.robinhood.com/tx/${PROPOSE_TX})`,
    );
    const local = { ...acceptedRecord(), transactions: [{ label: "settle", hash: PROPOSE_TX, url: null }] };
    expect(formatRecordMarkdown(local)).toContain(`- settle: \`${PROPOSE_TX}\``);
  });

  it("contains every section of an accepted proposal", () => {
    const md = formatRecordMarkdown(acceptedRecord());
    expect(md).toMatch(/^# sTSLA-CC weekly proposal, 2026-10-05\n/);
    expect(md).toContain("- **Chain:** Robinhood Chain Testnet (46630)");
    expect(md).toContain("- **Mandate:** |delta| 0.10-0.35, premium >= 95% of fair value");
    expect(md).toContain("- **Spot:** $352.453");
    expect(md).toContain("- **Implied volatility (sigma):** 55.00% a year");
    expect(md).toContain("snapshot taken when the epoch opened (2026-10-05T15:02:11.000Z)");
    expect(md).toContain("- **Target:** 0.20 delta at 100% of Black-Scholes fair value");
    expect(md).toContain("> Target 0.20 delta: far enough out of the money");
    expect(md).toContain("- **Verdict:** inside the mandate (`None`).");
    expect(md).toContain("call at strike $369.86 (|delta| 0.2, solved from a 0.20 target)");
    expect(md).toContain("**Accepted.** Accepted: series 42 is on sale");
    expect(md).toContain("- **Series:** `42`");
    expect(md).toContain("- **Expiry:** 2026-10-09T20:00:00.000Z");
    expect(md).toContain("- **Proposals:** 3 accepted, 1 rejected; 0/3 strikes");
    expect(md).toContain("- **Settled epochs:** 2, cumulative depositor PnL 4.25 USDG");
    expect(md).toContain("[2026-10-05-sTSLA-CC.json](2026-10-05-sTSLA-CC.json)");
  });

  it("records Claude's reasoning, the model and mandate-guard notes", () => {
    const r = acceptedRecord();
    r.decision = {
      strategy: "claude",
      targetDeltaBps: 1800,
      premiumBps: 10_500,
      reasoning: "TSLA has an earnings call next week.\n\nA lower delta keeps the shares.",
      notes: [
        "Model claude-opus-5.",
        "Mandate guard in the agent code adjusted Claude's plan: premium 9000 bps → 9500 bps.",
      ],
    };
    const md = formatRecordMarkdown(r);
    expect(md).toContain("- **Strategy:** Claude chose the plan");
    expect(md).toContain("- **Target:** 0.18 delta at 105% of Black-Scholes fair value");
    expect(md).toContain("- **Note:** Model claude-opus-5.");
    expect(md).toContain("> TSLA has an earnings call next week.\n>\n> A lower delta keeps the shares.");
    expect(md).not.toContain("**Planner:**"); // older records have no planner
  });

  it("names the planner that ran (API or Claude Code CLI)", () => {
    const r = acceptedRecord();
    const label = "Claude via Claude Code CLI, model claude-opus-5";
    r.decision = {
      strategy: "claude",
      targetDeltaBps: 1800,
      premiumBps: 10_000,
      reasoning: "Far enough out of the money.",
      notes: [`${label}.`],
      planner: { kind: "claude-code", model: "claude-opus-5", label },
    };
    expect(formatRecordMarkdown(r)).toContain(`- **Planner:** ${label}\n`);
    expect(JSON.parse(formatRecordJson(r)).decision.planner).toEqual(r.decision.planner);
  });

  it("names a rule-based profile as the planner (rule: conservative)", () => {
    const r = acceptedRecord();
    r.decision = {
      strategy: "default",
      targetDeltaBps: 1500,
      premiumBps: 10_800,
      reasoning: 'Profile "conservative": target 0.15 delta.',
      notes: ['Profile "conservative" capped the size at 50% of capacity: 0.419 → 0.2095.'],
      planner: { kind: "rule", model: "conservative", label: "rule: conservative" },
    };
    const md = formatRecordMarkdown(r);
    expect(md).toContain("- **Strategy:** default strategy (deterministic)");
    expect(md).toContain("- **Planner:** rule: conservative\n");
    expect(md).toContain("- **Target:** 0.15 delta at 108% of Black-Scholes fair value");
    expect(md).toContain(
      '- **Note:** Profile "conservative" capped the size at 50% of capacity: 0.419 → 0.2095.',
    );
    expect(JSON.parse(formatRecordJson(r)).decision.planner).toEqual({
      kind: "rule",
      model: "conservative",
      label: "rule: conservative",
    });
  });

  it("records a rejection with its reason and slash", () => {
    const rejected = proposeResult({
      ...accepted,
      accepted: false,
      reason: "DeltaOutOfBand",
      explanation: "Rejected on-chain (DeltaOutOfBand): ...",
      seriesId: null,
      slashed: "20",
    });
    expect(rejected).toMatchObject({ status: "rejected", reason: "DeltaOutOfBand", slashed: "20" });
    const md = formatRecordMarkdown({ ...acceptedRecord(), result: rejected });
    expect(md).toContain("- **Result:** rejected on-chain");
    expect(md).toContain("- **Reason:** `DeltaOutOfBand`");
    expect(md).toContain("- **Slashed:** 20 USDG from the agent's bond");
    expect(proposeResult({ ...accepted, submitted: false, accepted: null }).status).toBe("not-sent");
  });

  it("records a settlement the keeper already sent", () => {
    const md = formatRecordMarkdown({
      ...acceptedRecord(),
      action: "settle",
      decision: null,
      dryRun: null,
      result: {
        status: "settled",
        summary: "Already settled by the keeper at $380.",
        seriesId: "42",
        settlementPrice: "380",
        payout: "0 TSLA",
        premium: "8.5",
        fee: "0.85",
        settledBy: "keeper",
      },
    });
    expect(md).toMatch(/^# sTSLA-CC settlement, 2026-10-05/);
    expect(md).toContain("No decision to make: settlement follows the price feed");
    expect(md).toContain("- **Settlement price:** $380");
    expect(md).toContain("- **Settled by:** the keeper");
  });

  it("falls back to live inputs when no epoch runs, and to a failure when the run stopped", () => {
    expect(marketInputs(state("Idle"), null)).toMatchObject({
      spot: "352.453",
      sigma: 0.55,
      source: "live",
      openedAtIso: null,
    });
    expect(
      marketInputs(state("Idle"), { state: "Idle", openedAt: 1, openSpot: "1", openSigma: 1 }).source,
    ).toBe("live");
    const j = new Journal("propose", 46630);
    expect(j.build()).toBeNull();
    j.vaultRead(state());
    const r = j.build("Agent stopped: the dry run failed");
    expect(r?.result).toEqual({ status: "failed", summary: "Agent stopped: the dry run failed" });
    expect(formatRecordMarkdown(r as DecisionRecord)).toContain(
      "The run stopped before a decision was made.",
    );
  });

  it("emits JSON that round-trips", () => {
    const r = acceptedRecord();
    const json = formatRecordJson(r);
    expect(json.endsWith("}\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(r);
  });

  it("is already prettier-formatted (markdown and JSON)", async () => {
    for (const r of [acceptedRecord(), { ...acceptedRecord(), market: null, trackRecord: null }]) {
      const md = formatRecordMarkdown(r);
      expect(await prettierClean(md, "docs/agent-log/x.md")).toBe(md);
      const json = formatRecordJson(r);
      expect(await prettierClean(json, "docs/agent-log/x.json")).toBe(json);
    }
  });
});

describe("writeRecord", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes .md and .json and never overwrites an earlier record of the same day", async () => {
    dir = await mkdtemp(join(tmpdir(), "strike-agent-log-"));
    const first = await writeRecord(join(dir, "log"), acceptedRecord());
    expect(first.md).toBe(join(dir, "log", "2026-10-05-sTSLA-CC.md"));
    const second = await writeRecord(join(dir, "log"), acceptedRecord());
    expect(second.json).toBe(join(dir, "log", "2026-10-05-sTSLA-CC-2.json"));
    expect((await readdir(join(dir, "log"))).sort()).toEqual([
      "2026-10-05-sTSLA-CC-2.json",
      "2026-10-05-sTSLA-CC-2.md",
      "2026-10-05-sTSLA-CC.json",
      "2026-10-05-sTSLA-CC.md",
    ]);
    const md = await readFile(second.md, "utf8");
    expect(md).toContain("[2026-10-05-sTSLA-CC-2.json](2026-10-05-sTSLA-CC-2.json)");
    expect(JSON.parse(await readFile(first.json, "utf8")).result.seriesId).toBe("42");
  });
});

describe("--anchor", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const DECISION_LOG = "0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93";
  const ANCHOR_TX = `0x${"c".repeat(64)}` as const;

  function fakeSender() {
    const requests: AnchorRequest[] = [];
    const send: AnchorSender = async (req) => {
      requests.push(req);
      return ANCHOR_TX;
    };
    return { requests, send };
  }

  const anchor = (r: DecisionRecord, fileName: string, send: AnchorSender) =>
    anchorRecord(r, fileName, {
      contract: DECISION_LOG,
      epoch: 3n,
      send,
      txUrl: (h) => txUrl(46630, h),
    });

  it("hashes the exact JSON record it writes, before the anchor is added", () => {
    const r = acceptedRecord();
    expect(recordHash(r)).toBe(keccak256(toBytes(formatRecordJson(r))));
    expect(hashText("abc")).toBe(keccak256(toBytes("abc")));
    expect(unanchoredJson(r)).toBe(formatRecordJson(r));
  });

  it("sends DecisionLog.record with the agent, vault, epoch, hash and GitHub URL, and records the tx", async () => {
    const r = acceptedRecord();
    const { requests, send } = fakeSender();
    const anchored = await anchor(r, "2026-10-05-sTSLA-CC.json", send);
    expect(requests).toEqual([
      {
        agentId: 1n,
        vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
        epoch: 3n,
        recordHash: recordHash(r),
        uri: "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/2026-10-05-sTSLA-CC.json",
      },
    ]);
    expect(anchored.transactions.at(-1)).toEqual({
      label: ANCHOR_TX_LABEL,
      hash: ANCHOR_TX,
      url: `https://explorer.testnet.chain.robinhood.com/tx/${ANCHOR_TX}`,
    });
    expect(anchored.anchor).toEqual({
      contract: DECISION_LOG,
      recordHash: recordHash(r),
      uri: requests[0]?.uri,
      epoch: 3,
      txHash: ANCHOR_TX,
    });
    // The published JSON verifies against its anchor; any edit breaks it.
    const json = formatRecordJson(anchored);
    expect(verifyAnchoredRecord(json)).toBe(true);
    expect(recordHash(JSON.parse(json))).toBe(anchored.anchor?.recordHash);
    expect(verifyAnchoredRecord(json.replace('"accepted"', '"rejected"'))).toBe(false);
    expect(verifyAnchoredRecord(formatRecordJson(r))).toBe(false);
  });

  it("writes an anchored record that prettier leaves alone, with an on-chain anchor section", async () => {
    const anchored = await anchor(acceptedRecord(), "x.json", fakeSender().send);
    const md = formatRecordMarkdown(anchored);
    expect(md).toContain("## On-chain anchor");
    expect(md).toContain(`- **DecisionLog:** \`${DECISION_LOG}\`, epoch 3`);
    expect(md).toContain(`- ${ANCHOR_TX_LABEL}: [\`${ANCHOR_TX}\`]`);
    expect(await prettierClean(md, "docs/agent-log/x.md")).toBe(md);
    const json = formatRecordJson(anchored);
    expect(await prettierClean(json, "docs/agent-log/x.json")).toBe(json);
  });

  it("anchors under the file name writeRecord picks, and still writes the record when anchoring fails", async () => {
    dir = await mkdtemp(join(tmpdir(), "strike-agent-anchor-"));
    await writeRecord(dir, acceptedRecord());
    const { requests, send } = fakeSender();
    const second = await writeRecord(dir, acceptedRecord(), (r, file) => anchor(r, file, send));
    expect(requests[0]?.uri).toMatch(/\/docs\/agent-log\/2026-10-05-sTSLA-CC-2\.json$/);
    expect(second.anchorError).toBeUndefined();
    expect(verifyAnchoredRecord(await readFile(second.json, "utf8"))).toBe(true);

    const failed = await writeRecord(dir, acceptedRecord(), async () => {
      throw new Error("NotSigner");
    });
    expect(failed.anchorError).toBe("NotSigner");
    expect(JSON.parse(await readFile(failed.json, "utf8")).anchor).toBeUndefined();
  });

  it("anchors a propose run that opened nothing under the next epoch", () => {
    expect(anchorEpoch("propose", 1n, "Selling")).toBe(1n);
    expect(anchorEpoch("reckless", 2n, "Open")).toBe(2n);
    expect(anchorEpoch("propose", 1n, "Idle")).toBe(2n);
    expect(anchorEpoch("settle", 1n, "Idle")).toBe(1n);
  });

  it("finds the DecisionLog and needs the signer key", () => {
    expect(decisionLogAddress(46630, {})).toBe(DECISION_LOG);
    expect(decisionLogAddress(46630, { STRIKE_DECISION_LOG: DECISION_LOG.toLowerCase() })).toBe(DECISION_LOG);
    expect(() => decisionLogAddress(31337, {})).toThrow(/no DecisionLog deployed on chain 31337/);
    expect(() => chainAnchorSender(46630, DECISION_LOG, {})).toThrow(/STRIKE_AGENT_PRIVATE_KEY/);
    expect(recordUrl("a.json", "https://example.com/log")).toBe("https://example.com/log/a.json");
  });
});
