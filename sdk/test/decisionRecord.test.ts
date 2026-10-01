import { describe, expect, it } from "vitest";
import rhCc from "../../docs/agent-log/2026-10-01-sTSLA-CC.json?raw";
import rhCsp from "../../docs/agent-log/2026-10-01-sTSLA-CSP.json?raw";
import arbCc from "../../docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CC.json?raw";
import arbCsp from "../../docs/agent-log/arbitrum-sepolia/2026-09-30-sTSLA-CSP.json?raw";
import epochLog from "../../docs/testnet-epochs/2026-09-29.md?raw";
import {
  decisionRecordHash,
  epochLogHash,
  rawGithubUrl,
  recordAnchorOf,
  recordIdentityOf,
  recordMatchRank,
  unanchoredRecordJson,
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
