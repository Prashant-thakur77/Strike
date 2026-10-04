import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  RAW_BASE,
  RECORD_INDEX_PATH,
  fetchRecordIndex,
  indexHas,
  listedRunNames,
  parseRecordIndex,
} from "../src/lib/recordIndex";
import { acknowledge } from "./helpers";

// The vault and decision pages look a decision record up in the published index (docs/agent-log/index.json, written
// by scripts/agent-log-index.mjs) before fetching it, so they never ask GitHub for a file that does not exist: each
// miss used to be a 404 in the browser's console (v2's TSLA covered call on 46630 tried 2026-09-28 to 09-30
// sTSLA-CC.json, none of which exists). The repository's own files stand in for raw.githubusercontent.com.

const REPO = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const committed = () => parseRecordIndex(read(RECORD_INDEX_PATH))!;

test.describe("decision record index", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("the committed index lists every record file in docs/agent-log and nothing else", () => {
    const run = spawnSync(process.execPath, [join(REPO, "scripts/agent-log-index.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const index = committed();
    expect(indexHas(index, "docs/agent-log", "2026-10-01-sTSLA-CC.json")).toBe(true);
    expect(indexHas(index, "docs/agent-log/arbitrum-sepolia", "2026-09-30-sTSLA-CC.md")).toBe(true);
    expect(indexHas(index, "docs/agent-log/dry-runs", "2026-10-03-sTSLA-CSP-dry-run.json")).toBe(true);
    expect(indexHas(index, "docs/agent-log", "2026-09-29-sTSLA-CC.json")).toBe(false);
    expect(indexHas(index, "docs/agent-log", "README.md")).toBe(false);
    expect(indexHas(index, "docs/agent-log/nowhere", "2026-10-01-sTSLA-CC.json")).toBe(false);
    for (const [folder, files] of index)
      for (const f of files) expect(existsSync(join(REPO, folder, f)), f).toBe(true);
  });

  test("no index means anything may be tried; an index that is not one reads as none", () => {
    expect(indexHas(null, "docs/agent-log", "anything.json")).toBe(true);
    expect(parseRecordIndex("{}")).toBeNull();
    expect(parseRecordIndex("not json")).toBeNull();
    expect(parseRecordIndex(JSON.stringify({ version: 2, folders: {} }))).toBeNull();
    expect(parseRecordIndex(JSON.stringify({ version: 1, folders: { a: "b" } }))).toBeNull();
  });

  test("a day's runs in order, without another vault whose symbol extends this one", () => {
    const index = committed();
    expect(listedRunNames(index, "docs/agent-log", "2026-10-02-sTSLA-CC")).toEqual([
      "2026-10-02-sTSLA-CC",
      "2026-10-02-sTSLA-CC-2",
      "2026-10-02-sTSLA-CC-3",
    ]);
    // sTSLA-CSP-A2 (agent 2's vault) is not a run of sTSLA-CSP.
    expect(listedRunNames(index, "docs/agent-log", "2026-10-02-sTSLA-CSP")).toEqual([
      "2026-10-02-sTSLA-CSP",
      "2026-10-02-sTSLA-CSP-2",
      "2026-10-02-sTSLA-CSP-3",
    ]);
    expect(listedRunNames(index, "docs/agent-log", "2026-09-29-sTSLA-CC")).toEqual([]);
    expect(listedRunNames(index, "docs/agent-log/nowhere", "2026-10-02-sTSLA-CC")).toEqual([]);
    const tens = new Map([
      ["f", new Set(["d-s.json", "d-s-10.json", "d-s-2.json", "d-s-2.md", "d-s-x.json"])],
    ]);
    expect(listedRunNames(tens, "f", "d-s")).toEqual(["d-s", "d-s-2", "d-s-10"]);
  });

  test("the index is fetched once, a 404 reads as no index, and an unreachable GitHub throws", async () => {
    let calls = 0;
    const ok = async (url: string) => {
      calls++;
      expect(url).toBe(RAW_BASE + RECORD_INDEX_PATH);
      return new Response(read(RECORD_INDEX_PATH), { status: 200 });
    };
    expect((await fetchRecordIndex(ok))?.get("docs/agent-log")?.has("2026-10-01-sTSLA-CC.json")).toBe(true);
    await fetchRecordIndex(ok);
    expect(calls).toBe(1);

    expect(await fetchRecordIndex(async () => new Response("404: Not Found", { status: 404 }))).toBeNull();

    let tries = 0;
    const down = async () => {
      tries++;
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchRecordIndex(down)).rejects.toMatchObject({ name: "WhyStrikeError", kind: "network" });
    // A failure is not remembered: the next call reaches GitHub again.
    await expect(fetchRecordIndex(down)).rejects.toMatchObject({ kind: "network" });
    expect(tries).toBe(2);
  });
});

/* ================================================================ in the browser */

/** Serve the repository's raw files from this checkout; record what was asked for and what was missing. */
async function serveRaw(page: Page) {
  const asked: string[] = [];
  const missing: string[] = [];
  await page.route(`${RAW_BASE}**`, (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split("/main/")[1] ?? "");
    asked.push(rel);
    if (rel.includes("..") || !existsSync(join(REPO, rel))) {
      missing.push(rel);
      return route.fulfill({ status: 404, body: "404: Not Found" });
    }
    return route.fulfill({ status: 200, body: read(rel), contentType: "text/plain" });
  });
  return { asked, missing };
}

async function rpcUp(rpc: string, chainId: number): Promise<boolean> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result !== undefined && Number(json.result) === chainId;
  } catch {
    return false;
  }
}

test("the vault page asks GitHub only for records that exist (v2's TSLA covered call on 46630)", async ({
  page,
}) => {
  const rpc = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
  test.skip(!(await rpcUp(rpc, 46630)), "Robinhood Chain testnet RPC unreachable");
  const raw = await serveRaw(page);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /githubusercontent|404/.test(m.text())) errors.push(m.text());
  });
  await acknowledge(page);
  await page.goto("/app/vault/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e?chain=46630#why");
  const rail = page.locator("section#why");
  await expect(rail).toBeVisible({ timeout: 60_000 });
  const settled = rail
    .getByTestId("why-panel")
    .or(rail.getByTestId("why-empty"))
    .or(rail.getByTestId("why-error"));
  await expect(settled).toBeVisible({ timeout: 60_000 });
  await expect(rail.getByTestId("why-error")).toHaveCount(0);
  expect(raw.asked).toContain(RECORD_INDEX_PATH);
  expect(raw.missing).toEqual([]);
  expect(errors).toEqual([]);
});

test("a decision page for a record that was never published asks for the index only", async ({ page }) => {
  const raw = await serveRaw(page);
  await acknowledge(page);
  await page.goto("/app/decision/46630/2026-09-28-sTSLA-CC");
  const empty = page.getByTestId("decision-empty");
  await expect(empty).toBeVisible({ timeout: 60_000 });
  await expect(empty).toContainText("No such decision record.");
  expect(raw.asked).toEqual([RECORD_INDEX_PATH]);
  expect(raw.missing).toEqual([]);
});
