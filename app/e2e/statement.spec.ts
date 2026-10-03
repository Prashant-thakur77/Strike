import { expect, test } from "@playwright/test";
import type { StatementRow, WalletStatement } from "@strike/sdk";
import { RateLimiter, type StatementRouteDeps, handleStatementRequest } from "../src/lib/statementRoute";

// GET /api/statement (src/lib/statementRoute.ts over the SDK's statement): first the handler with a fixture reader
// (the deployer's real option purchase on Robinhood Chain testnet v2), no chain: JSON and CSV answers, the 400s, the
// rate limit, a chain that fails. Specs load as CommonJS and cannot import the SDK, so the query parser and the CSV
// writer here are small stand-ins (the SDK's own tests cover the real ones); the built route below runs the real ones:
// 400 for a bad query, and an empty wallet read from the live chains as JSON and as CSV.

const DEPLOYER = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";
const EMPTY = "0x000000000000000000000000000000000000dEaD";
const TX = "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9";
const ROW: StatementRow = {
  time: 1790701785,
  date: "2026-09-29T17:09:45.000Z",
  chainId: 46630,
  chain: "Robinhood Chain testnet",
  deployment: "46630-v2",
  vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
  vaultSymbol: "sTSLA-CC",
  action: "option-bought",
  description: "Bought 4 TSLA 369.86 call 2026-10-02 options from sTSLA-CC for 10.005944 USDG",
  amounts: [
    {
      direction: "out",
      amount: "10.005944",
      raw: "10005944",
      symbol: "USDG",
      decimals: 6,
      token: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    },
  ],
  txHash: TX,
  explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${TX}`,
  blockNumber: "126302569",
  logIndex: 2,
  contract: "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
  check: "cast logs …",
};
const SOURCES = [{ chainId: 46630, source: "rpc" as const, fromBlock: "125880607", toBlock: "128280000" }];

class StatementInputError extends Error {
  override name = "StatementInputError";
}

/** A statement with the SDK's shape: totals per token over the rows' in and out amounts. */
function buildStatement(p: {
  address: string;
  rows: StatementRow[];
  from?: number | null;
  to?: number | null;
  sources?: WalletStatement["sources"];
  errors?: WalletStatement["errors"];
}): WalletStatement {
  const rows = p.rows.filter((r) => (p.from == null || r.time >= p.from) && (p.to == null || r.time <= p.to));
  const totals = rows.flatMap((r) =>
    r.amounts.map((m) => ({
      chainId: r.chainId,
      chain: r.chain,
      token: m.token,
      symbol: m.symbol,
      decimals: m.decimals,
      in: m.direction === "in" ? m.amount : "0",
      out: m.direction === "out" ? m.amount : "0",
      net: m.direction === "out" ? `-${m.amount}` : m.amount,
    })),
  );
  return {
    kind: "strike.statement",
    version: 1,
    address: p.address as `0x${string}`,
    from: p.from == null ? null : new Date(p.from * 1000).toISOString(),
    to: p.to == null ? null : new Date(p.to * 1000).toISOString(),
    generatedAt: "2026-10-03T23:00:00.000Z",
    rows,
    totals,
    checks: rows.map((r) => ({ action: r.action, description: "", event: "", command: r.check })),
    sources: p.sources ?? [],
    errors: p.errors ?? [],
    note: "",
  };
}

const parseQuery: StatementRouteDeps["parseQuery"] = (q) => {
  const address = q instanceof URLSearchParams ? q.get("address") : null;
  const format = (q instanceof URLSearchParams ? q.get("format") : null) ?? "json";
  const from = q instanceof URLSearchParams ? q.get("from") : null;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new StatementInputError("address must be a 0x address");
  if (format !== "csv" && format !== "json") throw new StatementInputError("format must be csv or json");
  if (from && Number.isNaN(Date.parse(`${from}T00:00:00Z`)))
    throw new StatementInputError("from is not a valid date");
  return {
    address: (address.toLowerCase() === DEPLOYER.toLowerCase() ? DEPLOYER : address) as `0x${string}`,
    from: from ? Date.parse(`${from}T00:00:00Z`) / 1000 : null,
    to: null,
    format,
  };
};
const toCsv = (s: WalletStatement) =>
  [
    "date_utc,chain_id,chain,deployment,vault,vault_symbol,action,in_amount,in_token,out_amount,out_token,other_amount,other_token",
    ...s.rows.map(
      (r) =>
        `${r.date},${r.chainId},${r.chain},${r.deployment},${r.vault},${r.vaultSymbol},${r.action},,,10.005944,USDG,,`,
    ),
    "",
    "total_chain_id,total_chain,token,token_id,symbol,in,out,net",
    "",
    "check_action,event,cast_command,what_it_is",
  ].join("\r\n");

const pure = () => test.skip(test.info().project.name !== "desktop", "no browser: one project is enough");
const req = (q: string, ip = "203.0.113.7") =>
  new Request(`https://strike-options.vercel.app/api/statement?${q}`, { headers: { "x-forwarded-for": ip } });

function deps(over: Partial<Parameters<typeof handleStatementRequest>[1]> = {}) {
  const calls: { address: string; from: number | null; to: number | null }[] = [];
  return {
    calls,
    d: {
      limiter: new RateLimiter(20, 60_000),
      parseQuery,
      toCsv,
      read: async (address: string, opts: { from: number | null; to: number | null }) => {
        calls.push({ address, ...opts });
        return buildStatement({ address, rows: [ROW], from: opts.from, to: opts.to, sources: SOURCES });
      },
      ...over,
    },
  };
}

test.describe("statement route, fixture reader", () => {
  test.beforeEach(pure);

  test("JSON: rows, totals per token and the cast check for each row type, cached by the CDN", async () => {
    const { d, calls } = deps();
    const res = await handleStatementRequest(req(`address=${DEPLOYER.toLowerCase()}&from=2026-09-29`), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(calls).toEqual([{ address: DEPLOYER, from: 1790640000, to: null }]);
    const body = await res.json();
    expect(body.kind).toBe("strike.statement");
    expect(body.rows[0].explorerUrl).toBe(`https://explorer.testnet.chain.robinhood.com/tx/${TX}`);
    expect(body.totals).toEqual([
      expect.objectContaining({
        chainId: 46630,
        symbol: "USDG",
        in: "0",
        out: "10.005944",
        net: "-10.005944",
      }),
    ]);
    expect(body.checks.map((c: { action: string }) => c.action)).toEqual(["option-bought"]);
  });

  test("CSV: a download named by address and date, rows then totals then checks", async () => {
    const { d } = deps();
    const res = await handleStatementRequest(req(`address=${DEPLOYER}&format=csv`), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="strike-statement-${DEPLOYER}-\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
    );
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]!.startsWith("date_utc,chain_id,chain,deployment,vault,vault_symbol,action,")).toBe(true);
    expect(lines[1]).toContain(",option-bought,,,10.005944,USDG,,");
    expect(lines).toContain("total_chain_id,total_chain,token,token_id,symbol,in,out,net");
    expect(lines.some((l) => l.startsWith("check_action,"))).toBe(true);
  });

  test("a bad query is 400 and never reaches the chain", async () => {
    const { d, calls } = deps();
    for (const q of [
      "",
      "address=0x123",
      `address=${DEPLOYER}&format=pdf`,
      `address=${DEPLOYER}&from=2026-13-01`,
    ]) {
      const res = await handleStatementRequest(req(q), d);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });

  test("over the rate limit a client gets 429 with Retry-After; another client is not affected", async () => {
    const { d } = deps({ limiter: new RateLimiter(2, 60_000) });
    for (let i = 0; i < 2; i++)
      expect((await handleStatementRequest(req(`address=${DEPLOYER}`), d)).status).toBe(200);
    const limited = await handleStatementRequest(req(`address=${DEPLOYER}`), d);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await handleStatementRequest(req(`address=${DEPLOYER}`, "198.51.100.1"), d)).status).toBe(200);
  });

  test("a chain that cannot be read: partial answer cached briefly; none readable is 502", async () => {
    const partial = deps({
      read: async (address) =>
        buildStatement({
          address,
          rows: [ROW],
          sources: SOURCES,
          errors: [{ chainId: 421614, error: "RPC down" }],
        }),
    });
    const res = await handleStatementRequest(req(`address=${DEPLOYER}`), partial.d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15, s-maxage=30");
    expect((await res.json()).errors).toEqual([{ chainId: 421614, error: "RPC down" }]);
    const none = deps({
      read: async (address) =>
        buildStatement({ address, rows: [], errors: [{ chainId: 46630, error: "down" }] }),
    });
    expect((await handleStatementRequest(req(`address=${DEPLOYER}`), none.d)).status).toBe(502);
    const thrown = deps({
      read: async () => {
        throw new StatementInputError("from is after to");
      },
    });
    expect((await handleStatementRequest(req(`address=${DEPLOYER}`), thrown.d)).status).toBe(400);
  });
});

test.describe("statement route, built", () => {
  test.beforeEach(pure);

  test("400 for a bad query", async ({ request }) => {
    const res = await request.get("/api/statement?address=nope");
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/0x address/);
  });

  test("an empty wallet read from the live chains: no rows, both testnets scanned; the CSV has headers only", async ({
    request,
  }) => {
    test.setTimeout(150_000);
    const res = await request.get(`/api/statement?address=${EMPTY}`, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual([]);
    expect(body.sources.map((s: { chainId: number }) => s.chainId).sort()).toEqual([421614, 46630]);
    const csv = await request.get(`/api/statement?address=${EMPTY}&format=csv`, { timeout: 120_000 });
    expect(csv.headers()["content-type"]).toBe("text/csv; charset=utf-8");
    const lines = (await csv.text()).split("\r\n");
    expect(lines[0]).toBe(
      "date_utc,chain_id,chain,deployment,vault,vault_symbol,action,in_amount,in_token,out_amount,out_token,other_amount,other_token,description,block,log_index,contract,tx_hash,explorer_url",
    );
    expect(lines[1]).toBe("");
  });
});
