import { encodeAbiParameters, encodeEventTopics, type Hex, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import rhCc from "../../docs/agent-log/2026-10-01-sTSLA-CC.json?raw";
import rhCsp from "../../docs/agent-log/2026-10-01-sTSLA-CSP.json?raw";
import arbCc from "../../docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json?raw";
import arbCsp from "../../docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CSP.json?raw";
import epochLog from "../../docs/testnet-epochs/2026-09-29.md?raw";
import {
  checkAnchorReceipt,
  decisionLogAbi,
  decisionRecordHash,
  epochLogHash,
  rawGithubUrl,
  recordAnchorOf,
  recordIdentityOf,
  recordMatchRank,
  unanchoredRecordJson,
  verifyDecisionAnchor,
} from "../src/index.js";

// The anchored decision records published in docs/agent-log (and the hand-run epoch log of 29 September): the
// hash rebuilt from each published file must equal the hash its agent anchored, and a record must be matched to
// the vault epoch it is about by chain, vault and series or epoch.

const RH_CC = "2026-10-01-sTSLA-CC.json";
const ARB_CC = "arbitrum-sepolia/2026-09-30-sTSLA-CC.json";
const ARB_CSP = "arbitrum-sepolia/2026-09-30-sTSLA-CSP.json";
const FILES: Record<string, string> = {
  [RH_CC]: rhCc,
  "2026-10-01-sTSLA-CSP.json": rhCsp,
  [ARB_CC]: arbCc,
  [ARB_CSP]: arbCsp,
};
const read = (name: string) => FILES[name]!;
const RECORDS = Object.keys(FILES);

describe("decision record hash", () => {
  it("rebuilds the anchored hash of every published record", () => {
    for (const p of RECORDS) {
      const text = read(p);
      const anchor = recordAnchorOf(JSON.parse(text));
      expect(anchor, p).not.toBeNull();
      expect(decisionRecordHash(text), p).toBe(anchor!.recordHash);
      expect(decisionRecordHash(JSON.parse(text)), p).toBe(anchor!.recordHash);
    }
  });

  it("hashes the record without its anchor and anchoring transaction, pretty-printed with a newline", () => {
    const record = JSON.parse(read(RH_CC)) as Record<string, unknown>;
    const json = unanchoredRecordJson(record);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json).not.toContain('"anchor"');
    expect(json).not.toContain("DecisionLog.record");
    expect(json).toContain('"label": "proposeByDelta"');
    // The published copy is prettier-formatted (notes on one line); the hash covers the agent's own layout.
    expect(json).toContain('"notes": [\n      "Claude via Claude Code CLI, model claude-opus-5."\n    ]');
    // Key order is the record's own.
    expect(Object.keys(JSON.parse(json))).toEqual(Object.keys(record).filter((k) => k !== "anchor"));
  });

  it("changes when the record changes", () => {
    const record = JSON.parse(read(ARB_CC)) as { decision: { reasoning: string } };
    const tampered = { ...record, decision: { ...record.decision, reasoning: "We sell at the money." } };
    expect(decisionRecordHash(tampered)).not.toBe(recordAnchorOf(record)!.recordHash);
  });

  it("covers decision.candidates when present, and a record without the field keeps its hash", () => {
    const record = JSON.parse(read(RH_CC)) as { decision: Record<string, unknown> };
    expect(record.decision).not.toHaveProperty("candidates");
    const withCandidates = {
      ...record,
      decision: {
        ...record.decision,
        candidates: [
          {
            source: "ladder",
            targetDeltaBps: 2000,
            premiumBps: 10_000,
            ok: true,
            reason: "None",
            chosen: true,
          },
        ],
      },
    };
    expect(decisionRecordHash(withCandidates)).not.toBe(recordAnchorOf(record)!.recordHash);
    expect(unanchoredRecordJson(withCandidates)).toContain('"candidates"');
    // A changed candidate changes the hash.
    const edited = structuredClone(withCandidates);
    (edited.decision.candidates as { ok: boolean }[])[0]!.ok = false;
    expect(decisionRecordHash(edited)).not.toBe(decisionRecordHash(withCandidates));
    // Without the field the hash is the anchored one (what the app's browser check rebuilds for old records).
    const { candidates: _drop, ...decision } = withCandidates.decision;
    expect(decisionRecordHash({ ...withCandidates, decision })).toBe(recordAnchorOf(record)!.recordHash);
  });

  it("rejects what is not a record", () => {
    expect(() => unanchoredRecordJson(null)).toThrow(TypeError);
    expect(() => unanchoredRecordJson([])).toThrow(TypeError);
    expect(() => decisionRecordHash("not json")).toThrow();
  });

  it("rebuilds the hash of the hand-run epoch log of 29 September", () => {
    // Anchored in the v2 DecisionLog on Robinhood Chain testnet for the covered-call vault's epoch 1
    // (docs/testnet-epochs/2026-09-29.md, "Anchored on-chain"): the hash covers the file above that section.
    const log = epochLog;
    expect(epochLogHash(log)).toBe("0xffd051c8d7bdb2692879653db2002b54979482787e8d86a8fcad0a883d12bc5a");
    expect(epochLogHash(`${log}\nmore text appended later\n`)).toBe(epochLogHash(log));
    expect(epochLogHash(log.replace("0.20-delta covered call", "0.50-delta covered call"))).not.toBe(
      epochLogHash(log),
    );
    // A log never anchored hashes whole, trimmed to one trailing newline.
    expect(epochLogHash("# Log\n\ntext\n\n\n")).toBe(epochLogHash("# Log\n\ntext"));
  });
});

describe("anchor and identity", () => {
  it("reads the anchor fields", () => {
    expect(recordAnchorOf(JSON.parse(read(ARB_CC)))).toEqual({
      contract: "0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C",
      recordHash: "0x7ca1bd76f2bc2f658221e776b0a2bf15f3f1eb07f05961f216ab4a69c124e0f9",
      uri: "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json",
      epoch: 1,
      txHash: "0x1f9f7eafdf448c205df43e81d75e94f5282dd3b2bb465473330012c04cac3538",
    });
    expect(recordAnchorOf({ anchor: { contract: "0x1", recordHash: "0x2", epoch: 1 } })).toBeNull();
    expect(recordAnchorOf({ version: 1 })).toBeNull();
    expect(recordAnchorOf("x")).toBeNull();
  });

  it("reads the identity of a record", () => {
    expect(recordIdentityOf(JSON.parse(read(RH_CC)))).toEqual({
      chainId: 46630,
      vault: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
      seriesId: "48103703716925406245656156603615117052914973735876202170787552644395932337728",
      epoch: 1,
    });
    // The rejected reckless put on Arbitrum Sepolia put nothing on sale.
    expect(recordIdentityOf(JSON.parse(read(ARB_CSP)))).toEqual({
      chainId: 421614,
      vault: "0x02B701210aA006CEAbd389dBc32af0047B1B9bbe",
      seriesId: null,
      epoch: 1,
    });
    expect(recordIdentityOf({ chain: { id: "46630" }, vault: { address: "0xabc" } })).toBeNull();
    expect(recordIdentityOf(null)).toBeNull();
  });
});

describe("matching a record to a vault epoch", () => {
  const cc = recordIdentityOf(JSON.parse(read(ARB_CC)))!;
  const live = {
    chainId: 421614,
    vault: "0x5655659e18bf54ee0ef8f6a816e2e18d000f7311", // lower-case: addresses compare case-insensitively
    epoch: 1n,
    seriesId: 8200340887102394470889505950118944065123972136398888610989328404594772867353n,
  };

  it("ranks the record that put the live series on sale highest", () => {
    expect(recordMatchRank(cc, live)).toBe(2);
  });

  it("matches by epoch once settlement cleared the series id", () => {
    expect(recordMatchRank(cc, { ...live, seriesId: null })).toBe(1);
    expect(recordMatchRank(cc, { ...live, seriesId: undefined })).toBe(1);
    expect(recordMatchRank(cc, { ...live, epoch: 1 })).toBe(2);
  });

  it("ranks a rejected run of the same epoch below the accepted retry", () => {
    const rejected = { ...cc, seriesId: null };
    expect(recordMatchRank(rejected, live)).toBe(1);
    expect(recordMatchRank(cc, live)).toBeGreaterThan(recordMatchRank(rejected, live));
  });

  it("rejects another chain, vault, epoch or series", () => {
    expect(recordMatchRank(cc, { ...live, chainId: 46630 })).toBe(0);
    expect(recordMatchRank(cc, { ...live, vault: "0x02B701210aA006CEAbd389dBc32af0047B1B9bbe" })).toBe(0);
    expect(recordMatchRank(cc, { ...live, epoch: 2n, seriesId: null })).toBe(0);
    expect(recordMatchRank(cc, { ...live, epoch: 2n, seriesId: 1n })).toBe(0);
    // Unanchored and nothing on sale: nothing to match on.
    expect(recordMatchRank({ ...cc, epoch: null, seriesId: null }, live)).toBe(0);
  });
});

describe("rawGithubUrl", () => {
  it("maps a github.com file link to raw.githubusercontent.com", () => {
    expect(
      rawGithubUrl(
        "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json",
      ),
    ).toBe(
      "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json",
    );
  });

  it("returns null for anything else", () => {
    expect(rawGithubUrl("https://github.com/Prashant-thakur77/Strike/tree/main/docs")).toBeNull();
    expect(rawGithubUrl("http://github.com/a/b/blob/main/x.json")).toBeNull();
    expect(rawGithubUrl("https://example.com/a/b/blob/main/x.json")).toBeNull();
    expect(rawGithubUrl("not a url")).toBeNull();
  });
});

describe("verifying a record against its own anchoring transaction", () => {
  // The Claude-planned covered call on Robinhood Chain testnet (v3), anchored in v3's DecisionLog for epoch 1 by
  // tx 0x00e27f…; a settlement record for the same epoch will overwrite latestHash(1, vault, 1) on Friday.
  const record = JSON.parse(read(RH_CC)) as { vault: { address: string } };
  const anchor = recordAnchorOf(record)!;
  const LOG = anchor.contract;
  const VAULT = record.vault.address;
  const OTHER = "0x00000000000000000000000000000000DeaDBeef";
  const SETTLEMENT_HASH = `0x${"5e".repeat(32)}` as Hex;
  const computed = decisionRecordHash(read(RH_CC));

  const eventLog = (
    over: Partial<{ emitter: string; agentId: bigint; vault: string; epoch: bigint; hash: Hex }> = {},
  ) => ({
    address: over.emitter ?? LOG,
    topics: encodeEventTopics({
      abi: decisionLogAbi,
      eventName: "DecisionRecorded",
      args: { agentId: over.agentId ?? 1n, vault: (over.vault ?? VAULT) as Hex, epoch: over.epoch ?? 1n },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }],
      [over.hash ?? anchor.recordHash, anchor.uri, 1790870000n],
    ),
    logIndex: 0,
  });
  const receipt = (logs = [eventLog()], status: "success" | "reverted" = "success") => ({ status, logs });
  const expected = { decisionLogs: [LOG], agentId: 1n, vault: VAULT, epoch: 1, recordHash: computed };

  /** A chain whose anchor tx has `logs` and whose latestHash(1, vault, 1) is `latest`. */
  const chain = (opts: { receipt?: ReturnType<typeof receipt> | null; latest?: Hex }) => {
    const calls: string[] = [];
    const client = {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        calls.push(`receipt ${hash}`);
        if (opts.receipt === null) throw new TransactionReceiptNotFoundError({ hash });
        return opts.receipt ?? receipt();
      },
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        calls.push(`${functionName} ${address}`);
        return opts.latest ?? anchor.recordHash;
      },
    };
    return { client: client as never, calls };
  };

  it("verifies the proposal record by its tx after a settlement record overwrote latestHash", async () => {
    const { client, calls } = chain({ latest: SETTLEMENT_HASH });
    const check = await verifyDecisionAnchor(client, { ...expected, txHash: anchor.txHash });
    expect(check.status).toBe("match");
    expect(check.via).toBe("tx");
    expect(check.tx?.status).toBe("match");
    expect(check.tx?.event?.recordHash).toBe(computed);
    expect(check.decisionLog?.toLowerCase()).toBe(LOG.toLowerCase());
    // latestHash is secondary: a later record exists for the epoch, which is not a failure.
    expect(check.latestHash).toBe(SETTLEMENT_HASH);
    expect(check.superseded).toBe(true);
    expect(calls[0]).toBe(`receipt ${anchor.txHash}`);
  });

  it("is not superseded while latestHash still holds the record's hash", async () => {
    const { client } = chain({});
    const check = await verifyDecisionAnchor(client, { ...expected, txHash: anchor.txHash });
    expect(check).toMatchObject({ status: "match", via: "tx", superseded: false });
  });

  it("fails a tampered record", async () => {
    const tampered = { ...JSON.parse(read(RH_CC)), decision: { reasoning: "We sell at the money." } };
    const { client } = chain({ latest: SETTLEMENT_HASH });
    const check = await verifyDecisionAnchor(client, {
      ...expected,
      recordHash: decisionRecordHash(tampered),
      txHash: anchor.txHash,
    });
    expect(check.status).toBe("mismatch");
    expect(check.tx?.status).toBe("hash-mismatch");
    expect(check.superseded).toBe(false);
  });

  it("fails an anchor emitted by a contract that is not a known DecisionLog", async () => {
    const { client } = chain({ receipt: receipt([eventLog({ emitter: OTHER })]) });
    const check = await verifyDecisionAnchor(client, { ...expected, txHash: anchor.txHash });
    expect(check.status).toBe("bad-tx");
    expect(check.tx?.status).toBe("wrong-emitter");
    expect(check.tx?.event?.emitter).toBe(OTHER);
  });

  it("fails an anchor for another agent, vault or epoch, a reverted tx and a tx without the event", () => {
    expect(checkAnchorReceipt(receipt([eventLog({ agentId: 2n })]), expected).status).toBe("wrong-target");
    expect(checkAnchorReceipt(receipt([eventLog({ vault: OTHER })]), expected).status).toBe("wrong-target");
    expect(checkAnchorReceipt(receipt([eventLog({ epoch: 2n })]), expected).status).toBe("wrong-target");
    expect(checkAnchorReceipt(receipt([eventLog()], "reverted"), expected).status).toBe("reverted");
    expect(checkAnchorReceipt(receipt([]), expected).status).toBe("no-event");
    // A fake event next to the real one does not hide it.
    expect(checkAnchorReceipt(receipt([eventLog({ emitter: OTHER }), eventLog()]), expected).status).toBe(
      "match",
    );
  });

  it("falls back to latestHash without a tx or when the chain does not know it", async () => {
    const noTx = await verifyDecisionAnchor(chain({}).client, expected);
    expect(noTx).toMatchObject({ status: "match", via: "latestHash", tx: null, superseded: false });
    const overwritten = await verifyDecisionAnchor(chain({ latest: SETTLEMENT_HASH }).client, expected);
    expect(overwritten.status).toBe("mismatch");
    const unknownTx = await verifyDecisionAnchor(chain({ receipt: null }).client, {
      ...expected,
      txHash: anchor.txHash,
    });
    expect(unknownTx).toMatchObject({ status: "match", via: "latestHash" });
    const none = await verifyDecisionAnchor(chain({ latest: `0x${"0".repeat(64)}` }).client, expected);
    expect(none.status).toBe("no-anchor");
  });
});
