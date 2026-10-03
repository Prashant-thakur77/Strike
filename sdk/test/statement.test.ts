import { type Abi, type Address, type Hex, decodeEventLog, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  STATEMENT_ACTIONS,
  StatementInputError,
  agentRegistryV3Abi,
  buildStatement,
  csvCell,
  epochManagerAbi,
  gasDripAbi,
  parseStatementQuery,
  statement,
  statementBound,
  statementChecks,
  statementCsv,
  strikeVaultAbi,
  usdgDripAbi,
} from "../src/index.js";
import { fakePublicClient } from "./fake-chain.js";
import fixtureJson from "./fixtures/statement-46630.json" with { type: "json" };

// The wallet statement (src/statement.ts) over real Robinhood Chain testnet logs (fixtures/statement-46630.json, read
// on 3 October): the deployer, who owns agent 1, deposited in v2 and v3, bought 4 calls and was slashed into its own
// put vault, and QA wallet 1 (a faucet drip, a deposit, a withdrawal and an x402 payment). A fake chain serves the
// logs at the real contract addresses, so statement() runs its real scan; the indexer path gets the same logs as
// /events JSON. Then CSV escaping, the date filter, an empty wallet and the query parser.

interface FixtureLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  transactionHash: Hex;
  logIndex: number;
}
const fixture = fixtureJson as unknown as {
  wallets: [Address, Address];
  blockTimestamps: Record<string, number>;
  logs: FixtureLog[];
};
const [DEPLOYER, QA] = fixture.wallets;
const EMPTY = "0x000000000000000000000000000000000000dEaD" as Address;

const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as Address;
const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as Address;
const V2_EM = "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99" as Address;
const V3_EM = "0x256D4546486368dCb23E94758b4cb500c215929F" as Address;
const V2_REGISTRY = "0xE5b76249041e59C74Ee317fC2729f26249618D32" as Address;
const V3_REGISTRY = "0x1c42740145B245b2f894d8e989ca29dfd9A9052f" as Address;
const USDG_DRIP = "0x1f3778BfC474419f154AD543625A711d90985632" as Address;
const GAS_DRIP = "0x8dC1296314Df514e4fC86720DD26f0b4F3D10b27" as Address;
const VAULTS = {
  v2cc: { address: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e", symbol: "sTSLA-CC", isCall: true },
  v2csp: { address: "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7", symbol: "sTSLA-CSP", isCall: false },
  v3cc: { address: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285", symbol: "sTSLA-CC", isCall: true },
  v3csp: { address: "0x1bc73c1B28F520E57982FAe6127477190FA53690", symbol: "sTSLA-CSP", isCall: false },
} as const;
// The 4 calls the deployer bought on v2: strike $369.86, expiry Fri 2 Oct 20:00 UTC.
const SERIES = 8614008145645214741184698995285385951692715470493509368088435356950067027964n;
const HEAD = 128_280_000n;

const zero = "0x0000000000000000000000000000000000000000" as Address;
const vaultContract = (v: { symbol: string; isCall: boolean }) => ({
  abi: strikeVaultAbi as Abi,
  fns: {
    symbol: v.symbol,
    decimals: v.isCall ? 18 : 6,
    asset: v.isCall ? TSLA : USDG,
    underlying: TSLA,
    premiumToken: USDG,
    isCall: v.isCall,
  },
});
const token = (symbol: string, decimals: number) => ({ abi: erc20Abi as Abi, fns: { symbol, decimals } });
const series = {
  vault: VAULTS.v2cc.address,
  underlying: TSLA,
  agentId: 1n,
  expiry: 1790971200n,
  premiumBps: 10000,
  isCall: true,
  settled: false,
  cancelled: false,
  strike: 36986n * 10n ** 16n,
  size: 4n * 10n ** 18n,
  sold: 4n * 10n ** 18n,
  premium: 10005944n,
  collateral: 4n * 10n ** 18n,
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};

function chain(logs: FixtureLog[] = fixture.logs) {
  return fakePublicClient(
    {
      [V2_EM]: {
        abi: epochManagerAbi as Abi,
        fns: {
          vaultCount: 2n,
          allVaults: ([i]: readonly unknown[]) => (i === 0n ? VAULTS.v2cc.address : VAULTS.v2csp.address),
          getSeries: ([id]: readonly unknown[]) =>
            id === SERIES ? series : { ...series, vault: zero, isCall: false },
        },
      },
      [V3_EM]: {
        abi: epochManagerAbi as Abi,
        fns: {
          vaultCount: 2n,
          allVaults: ([i]: readonly unknown[]) => (i === 0n ? VAULTS.v3cc.address : VAULTS.v3csp.address),
        },
      },
      [VAULTS.v2cc.address]: vaultContract(VAULTS.v2cc),
      [VAULTS.v2csp.address]: vaultContract(VAULTS.v2csp),
      [VAULTS.v3cc.address]: vaultContract(VAULTS.v3cc),
      [VAULTS.v3csp.address]: vaultContract(VAULTS.v3csp),
      [USDG]: token("USDG", 6),
      [TSLA]: token("TSLA", 18),
    },
    {
      timestamp: 1791050000n,
      head: HEAD,
      blockTimestamps: Object.fromEntries(
        Object.entries(fixture.blockTimestamps).map(([b, t]) => [b, BigInt(t)]),
      ),
      logs: logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) })),
    },
  ).client;
}

const read = (address: Address, opts: Parameters<typeof statement>[1] = {}) => {
  const pc = chain();
  return statement(address, { chainIds: [46630], publicClientFor: () => pc, cacheTtlMs: 0, ...opts });
};

describe("statement over the fixture wallets", () => {
  it("lists every Strike event of the deployer, oldest first, with amounts, tokens and links", async () => {
    const s = await read(DEPLOYER);
    expect(s.errors).toEqual([]);
    expect(s.sources).toEqual([
      { chainId: 46630, source: "rpc", fromBlock: "125880607", toBlock: HEAD.toString() },
    ]);
    expect(s.rows.map((r) => `${r.deployment} ${r.vaultSymbol ?? "-"} ${r.action}`)).toEqual([
      "46630-v2 - bond-posted",
      "46630-v2 sTSLA-CC deposit",
      "46630-v2 sTSLA-CSP deposit",
      "46630-v2 - bond-slashed",
      "46630-v2 sTSLA-CSP slash-to-vault",
      "46630-v2 sTSLA-CC option-bought",
      "46630-v2 sTSLA-CSP withdrawal",
      "46630-v2 sTSLA-CSP premium-claimed",
      "46630-v3 sTSLA-CC deposit",
      "46630-v3 sTSLA-CSP deposit",
      "46630-v3 - bond-slashed",
      "46630-v3 sTSLA-CSP slash-to-vault",
      "46630-v2 - bond-posted",
      "46630-v3 - bond-posted",
    ]);
    const bought = s.rows.find((r) => r.action === "option-bought")!;
    expect(bought.date).toBe("2026-09-29T17:09:45.000Z");
    expect(bought.chain).toBe("Robinhood Chain testnet");
    expect(bought.amounts).toEqual([
      { direction: "out", amount: "10.005944", raw: "10005944", symbol: "USDG", decimals: 6, token: USDG },
      {
        direction: "in",
        amount: "4",
        raw: "4000000000000000000",
        symbol: "TSLA 369.86 call 2026-10-02",
        decimals: 18,
        token: "0x557060266F4aE09ae723541AC8E7E27A99B0c9DB",
        tokenId: SERIES.toString(),
      },
    ]);
    expect(bought.txHash).toBe("0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9");
    expect(bought.explorerUrl).toBe(
      "https://explorer.testnet.chain.robinhood.com/tx/0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9",
    );
    expect(bought.check).toBe(
      `cast logs --rpc-url https://rpc.testnet.chain.robinhood.com --from-block 126302569 --to-block 126302569 --address ${V2_EM} 'OptionsBought(uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 amount, uint256 premium)' && cast abi-decode 'f()(uint256,uint256)' <data of that log>`,
    );
    // The slash came out of agent 1's bond (info, not a wallet transfer) and went to the put vault it had deposited in.
    const slash = s.rows.filter((r) => r.txHash.startsWith("0x3df523aa"));
    expect(slash.map((r) => [r.action, r.amounts[0]!.direction, r.amounts[0]!.amount])).toEqual([
      ["bond-slashed", "info", "10"],
      ["slash-to-vault", "info", "10"],
    ]);
  });

  it("totals each token per chain over the in and out amounts, leaving info amounts out", async () => {
    const s = await read(DEPLOYER);
    const usdg = s.totals.find((t) => t.token === USDG)!;
    // Out: bonds 60 + 20 + 20, deposits 20 + 60, premium 10.005944. In: the withdrawal 20, the claimed premium 10.
    expect(usdg).toMatchObject({
      chainId: 46630,
      symbol: "USDG",
      in: "30",
      out: "190.005944",
      net: "-160.005944",
    });
    expect(s.totals.find((t) => t.token === TSLA)).toMatchObject({ in: "0", out: "10", net: "-10" });
    expect(s.totals.find((t) => t.tokenId === SERIES.toString())).toMatchObject({ in: "4", net: "4" });
    expect(s.checks.map((c) => c.action)).toEqual([
      "deposit",
      "withdrawal",
      "premium-claimed",
      "option-bought",
      "bond-posted",
      "bond-slashed",
      "slash-to-vault",
    ]);
  });

  it("reads the faucet drip and the x402 payment of QA wallet 1 from the chain", async () => {
    const s = await read(QA);
    expect(
      s.rows.map((r) => [
        r.action,
        r.deployment,
        r.amounts.map((m) => `${m.direction} ${m.amount} ${m.symbol}`),
      ]),
    ).toEqual([
      ["usdg-drip", null, ["in 10 USDG"]],
      ["deposit", "46630-v3", ["out 5 USDG", "in 5 sTSLA-CSP"]],
      ["withdrawal", "46630-v3", ["in 2 USDG", "out 2 sTSLA-CSP"]],
      ["x402-payment", null, ["out 0.01 USDG"]],
    ]);
    expect(s.rows[3]!.txHash).toBe("0xf3d96e3be187b3d2318219b64c8c75ceca19c336afc3c2ff1f4ce0b01251729d");
    expect(s.totals.find((t) => t.token === USDG)).toMatchObject({ in: "12", out: "5.01", net: "6.99" });
  });

  it("filters by date (a bare `to` date runs to the end of that UTC day) and recomputes the totals", async () => {
    const s = await read(DEPLOYER, { from: "2026-09-29", to: "2026-09-30" });
    expect(s.from).toBe("2026-09-29T00:00:00.000Z");
    expect(s.to).toBe("2026-09-30T23:59:59.000Z");
    expect(s.rows.map((r) => r.action)).toEqual([
      "deposit",
      "bond-slashed",
      "slash-to-vault",
      "option-bought",
      "withdrawal",
      "premium-claimed",
    ]);
    expect(s.totals.find((t) => t.token === USDG)).toMatchObject({ in: "30", out: "30.005944" });
    const none = await read(DEPLOYER, { from: "2026-10-02T00:00:00Z", to: "2026-10-02T23:00:00Z" });
    expect(none.rows).toEqual([]);
    await expect(read(DEPLOYER, { from: "2026-10-02", to: "2026-10-01" })).rejects.toThrow(
      StatementInputError,
    );
  });

  it("gives an empty wallet an empty statement: no rows, totals or checks, and a CSV with headers only", async () => {
    const s = await read(EMPTY);
    expect(s.rows).toEqual([]);
    expect(s.totals).toEqual([]);
    expect(s.checks).toEqual([]);
    expect(s.errors).toEqual([]);
    const csv = statementCsv(s).split("\r\n");
    expect(csv[0]).toMatch(/^date_utc,chain_id,chain,deployment,vault,vault_symbol,action,in_amount/);
    expect(csv[1]).toBe("");
    expect(csv[2]).toBe("total_chain_id,total_chain,token,token_id,symbol,in,out,net");
  });

  it("reads Strike's events from the indexer when one is configured, and x402 and drips from the chain", async () => {
    const kinds: Record<string, { kind: string; abi: Abi }> = {
      [V2_EM.toLowerCase()]: { kind: "epochManager", abi: epochManagerAbi as Abi },
      [V3_EM.toLowerCase()]: { kind: "epochManager", abi: epochManagerAbi as Abi },
      [V2_REGISTRY.toLowerCase()]: { kind: "agentRegistry", abi: agentRegistryV3Abi as Abi },
      [V3_REGISTRY.toLowerCase()]: { kind: "agentRegistry", abi: agentRegistryV3Abi as Abi },
      ...Object.fromEntries(
        Object.values(VAULTS).map((v) => [
          v.address.toLowerCase(),
          { kind: "vault", abi: strikeVaultAbi as Abi },
        ]),
      ),
    };
    const v3 = new Set(
      [V3_EM, V3_REGISTRY, VAULTS.v3cc.address, VAULTS.v3csp.address].map((a) => a.toLowerCase()),
    );
    const json = (v: unknown): unknown =>
      typeof v === "bigint"
        ? v.toString()
        : typeof v === "string"
          ? v.toLowerCase()
          : typeof v !== "object" || v === null
            ? v
            : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, json(x)]));
    const events = fixture.logs.flatMap((l) => {
      const k = kinds[l.address.toLowerCase()];
      if (!k) return [];
      const d = decodeEventLog({ abi: k.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return [
        {
          chainId: 46630,
          deployment: v3.has(l.address.toLowerCase()) ? "46630-v3" : "46630-v2",
          blockNumber: Number(l.blockNumber),
          blockTime: new Date(fixture.blockTimestamps[l.blockNumber]! * 1000).toISOString(),
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          address: l.address.toLowerCase(),
          source: k.kind,
          event: d.eventName,
          args: json(d.args),
        },
      ];
    });
    const asked: string[] = [];
    const fakeFetch = (async (url: string) => {
      asked.push(url);
      const q = new URL(url).searchParams;
      const account = q.get("account");
      const types = q.get("type")?.split(",");
      const hits = events.filter((e) =>
        account
          ? Object.values(e.args as Record<string, unknown>).includes(account)
          : types!.includes(String(e.event)),
      );
      return new Response(JSON.stringify({ events: hits, nextCursor: null }), { status: 200 });
    }) as typeof fetch;
    const viaIndexer = await read(DEPLOYER, { indexerUrl: "http://indexer.test/", fetch: fakeFetch });
    const viaRpc = await read(DEPLOYER);
    expect(viaIndexer.sources[0]!.source).toBe("indexer");
    expect(asked[0]).toBe(`http://indexer.test/events?account=${DEPLOYER.toLowerCase()}&limit=500`);
    const strip = (rows: typeof viaRpc.rows) => rows.map(({ check: _c, ...r }) => r);
    expect(strip(viaIndexer.rows)).toEqual(strip(viaRpc.rows));
    const qa = await read(QA, { indexerUrl: "http://indexer.test", fetch: fakeFetch });
    expect(qa.rows.map((r) => r.action)).toEqual(["usdg-drip", "deposit", "withdrawal", "x402-payment"]);
  });

  it("reports a chain it cannot read and still answers for the others", async () => {
    const broken = chain();
    const s = await statement(DEPLOYER, {
      chainIds: [46630, 421614],
      cacheTtlMs: 0,
      publicClientFor: (id) => {
        if (id === 46630) return broken;
        throw new Error("Arbitrum Sepolia RPC is down");
      },
    });
    expect(s.errors).toEqual([{ chainId: 421614, error: "Arbitrum Sepolia RPC is down" }]);
    expect(s.rows.length).toBe(14);
  });
});

describe("statement CSV", () => {
  it("quotes commas, quotes and line breaks, and defuses spreadsheet formulas but not numbers", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rlf")).toBe('"cr\rlf"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1+2")).toBe("'+1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-160.005944")).toBe("-160.005944");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
    expect(csvCell(null)).toBe("");
    expect(csvCell(46630)).toBe("46630");
  });

  it("writes rows, totals, the cast checks and the note, and a hostile vault symbol survives a round trip", async () => {
    const s = await read(DEPLOYER);
    const hostile = {
      ...s.rows[1]!,
      vaultSymbol: '=cmd|"/c calc"!A1',
      description: 'Deposited 5 TSLA, "quoted"\nnext',
    };
    const csv = statementCsv(buildStatement({ address: DEPLOYER, rows: [hostile, s.rows[5]!] }));
    const table = parseCsv(csv);
    expect(table[0]).toEqual([
      "date_utc",
      "chain_id",
      "chain",
      "deployment",
      "vault",
      "vault_symbol",
      "action",
      "in_amount",
      "in_token",
      "out_amount",
      "out_token",
      "other_amount",
      "other_token",
      "description",
      "block",
      "log_index",
      "contract",
      "tx_hash",
      "explorer_url",
    ]);
    expect(table[1]!.slice(0, 13)).toEqual([
      "2026-09-28T21:18:19.000Z",
      "46630",
      "Robinhood Chain testnet",
      "46630-v2",
      VAULTS.v2cc.address,
      `'=cmd|"/c calc"!A1`,
      "deposit",
      "5",
      "sTSLA-CC",
      "5",
      "TSLA",
      "",
      "",
    ]);
    expect(table[1]![13]).toBe('Deposited 5 TSLA, "quoted"\nnext');
    expect(table[2]!.slice(6, 11)).toEqual([
      "option-bought",
      "4",
      "TSLA 369.86 call 2026-10-02",
      "10.005944",
      "USDG",
    ]);
    expect(table[3]).toEqual([""]);
    expect(table[4]![0]).toBe("total_chain_id");
    const checks = table.findIndex((r) => r[0] === "check_action");
    expect(table[checks + 1]![0]).toBe("deposit");
    expect(table[checks + 1]![2]).toMatch(
      /^cast logs --rpc-url <RPC> --from-block <BLOCK> --to-block <BLOCK> --address <CONTRACT> 'Deposit\(address indexed sender, address indexed owner, uint256 assets, uint256 shares\)' && cast abi-decode 'f\(\)\(uint256,uint256\)' <data of that log>$/,
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(table.find((r) => r[0] === "note")![1]).toMatch(/^A statement of the wallet's Strike records/);
    expect(csv).not.toMatch(/\btax\b/i);
  });

  it("has a check for every row type", () => {
    expect(statementChecks().map((c) => c.action)).toEqual([...STATEMENT_ACTIONS]);
    for (const c of statementChecks()) expect(c.command).toMatch(/^cast logs --rpc-url <RPC> /);
  });
});

describe("statement query", () => {
  it("takes an address, optional dates and csv or json", () => {
    expect(parseStatementQuery(new URLSearchParams(`address=${DEPLOYER.toLowerCase()}`))).toEqual({
      address: getAddress(DEPLOYER),
      from: null,
      to: null,
      format: "json",
    });
    expect(
      parseStatementQuery({ address: DEPLOYER, from: "2026-10-01", to: "2026-10-01", format: "CSV" }),
    ).toEqual({ address: DEPLOYER, from: 1790812800, to: 1790899199, format: "csv" });
    for (const [q, msg] of [
      [{}, /address is required/],
      [{ address: "0x123" }, /0x address/],
      [{ address: DEPLOYER, format: "xml" }, /csv or json/],
      [{ address: DEPLOYER, from: "2026-02-30" }, /valid date/],
      [{ address: DEPLOYER, from: "yesterday" }, /YYYY-MM-DD/],
      [{ address: DEPLOYER, from: "2026-10-02", to: "2026-10-01" }, /after/],
    ] as const) {
      expect(() => parseStatementQuery(q as Record<string, string>)).toThrow(msg);
    }
    expect(statementBound(1790812800, "from")).toBe(1790812800);
    expect(statementBound("2026-10-01T12:00:00Z", "to")).toBe(1790856000);
  });

  it("covers the faucets' event signatures", () => {
    expect(gasDripAbi.some((x) => x.type === "event" && x.name === "Dripped")).toBe(true);
    expect(usdgDripAbi.some((x) => x.type === "event" && x.name === "Dripped")).toBe(true);
    expect(GAS_DRIP).toBe(getAddress(GAS_DRIP));
    expect(USDG_DRIP).toBe(getAddress(USDG_DRIP));
  });
});

/** A small RFC 4180 reader, to check that the CSV parses back to the same cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}
