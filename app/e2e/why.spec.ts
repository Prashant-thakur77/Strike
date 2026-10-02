import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { acknowledge, horizontalOverflow, rpcTraffic, settle } from "./helpers";

// "Why this strike" on the live TSLA covered-call vaults: v2 on Robinhood Chain testnet (46630), whose first epoch
// was run by hand and whose epoch log is anchored in the v2 DecisionLog, and v3 on Arbitrum Sepolia (421614), whose
// Claude-planned decision record is anchored in its DecisionLog, and v3 on Robinhood Chain testnet (next to v2), whose
// record of 1 October is anchored in v3's DecisionLog there. The panel must name the planner, show the chosen delta
// and premium, the agent's reasoning and the contract's verdict, rebuild the record's hash from the file on GitHub
// and find it in the record's own anchoring transaction ("hash matches (anchored in tx …)"), so a later settlement
// record for the same epoch does not break it. Each case skips when its RPC or GitHub is unreachable, and when
// the vault has moved on to an epoch with no published record. Set WHY_SHOTS=<dir> to save the rail as
// <project>-vault-why.png (46630 v2), <project>-vault-arbitrum-sepolia-why.png (421614) and
// <project>-vault-robinhood-v3-why.png (46630 v3).

interface Case {
  chainId: number;
  chain: string;
  rpc: string;
  vault: string;
  /** Which DecisionLog the anchor is expected in (the record's own, checked against the deployed ones). */
  decisionLog: string;
  shot: string;
}

const CASES: Case[] = [
  {
    chainId: 46630,
    chain: "Robinhood Chain testnet",
    rpc: process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
    vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    decisionLog: "0xbF94f54fd0258ac59e2f54B70754dFAfFd245D93",
    shot: "vault-why",
  },
  {
    chainId: 421614,
    chain: "Arbitrum Sepolia",
    rpc: process.env.E2E_ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
    vault: "0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
    decisionLog: "0x60E947b8d2c2C34b95d88d02F0A06AeFb6Ccd04C",
    shot: "vault-arbitrum-sepolia-why",
  },
  {
    // v3 next to v2 on Robinhood Chain testnet: the Claude-planned epoch of 1 October, anchored in v3's DecisionLog.
    chainId: 46630,
    chain: "Robinhood Chain testnet",
    rpc: process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
    vault: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
    decisionLog: "0xa98106db53519F8cfE4D7C56B34D4Fe0460403a4",
    shot: "vault-robinhood-v3-why",
  },
];

const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/";
const PLANNER = /Claude via (Claude Code CLI|API), model \S+|Rule-based/;

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

async function githubUp(): Promise<boolean> {
  try {
    const res = await fetch(`${RAW}docs/agent-log/README.md`, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The rail and, once loaded, the panel; skips when the epoch has no published record. */
async function openPanel(page: Page, c: Case) {
  await acknowledge(page);
  await page.goto(`/app/vault/${c.vault}?chain=${c.chainId}`);
  const rail = page.locator("section#why");
  await expect(rail).toBeVisible({ timeout: 60_000 });
  await expect(rail.getByRole("heading", { level: 2 })).toHaveText("Why this strike");
  await rail.scrollIntoViewIfNeeded();
  const panel = rail.getByTestId("why-panel");
  const empty = rail.getByTestId("why-empty");
  const error = rail.getByTestId("why-error");
  await expect(panel.or(empty).or(error)).toBeVisible({ timeout: 60_000 });
  if (await error.isVisible()) throw new Error(`the panel failed to load: ${await error.innerText()}`);
  test.skip(await empty.isVisible(), "the vault's current epoch has no published record");
  return { rail, panel };
}

for (const c of CASES) {
  test(`why this strike on ${c.chain} (${c.shot}): planner, choice, reasoning, verdict and the on-chain hash check`, async ({
    page,
  }, info) => {
    test.skip(!(await rpcUp(c.rpc, c.chainId)), `${c.chain} RPC unreachable`);
    test.skip(!(await githubUp()), "GitHub (raw.githubusercontent.com) unreachable");
    const { rail, panel } = await openPanel(page, c);

    // The plain-language line, then who planned it, what it chose and what the contract said.
    await expect(panel).toContainText("The agent that runs this vault wrote this before it proposed");
    await expect(panel.getByTestId("why-planner")).toContainText(PLANNER);
    const chosen = panel.getByTestId("why-chosen");
    await expect(chosen).toContainText(/0\.\d{2}/);
    await expect(chosen).toContainText("delta");
    await expect(chosen).toContainText(/\d+(\.\d+)?% of fair value/);
    await expect(panel.getByTestId("why-result")).toContainText(/Accepted|Rejected/);
    await expect(panel.getByTestId("why-reasoning")).toContainText(/Why · (Claude|Rule-based)/);
    await expect(panel.getByTestId("why-reasoning").locator("blockquote")).toContainText(/delta/i);
    if ((await panel.getAttribute("data-kind")) === "record") {
      const cands = panel.getByTestId("why-candidates").locator("li");
      expect(await cands.count()).toBeGreaterThan(0);
      await expect(cands.last()).toContainText(/inside the mandate|outside:/);
      await expect(cands.last()).toContainText("sent");
      await expect(panel.getByRole("link", { name: /The JSON the hash covers/ })).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/Prashant-thakur77\/Strike\/blob\/main\/docs\/agent-log\/.+\.json$/,
      );
    }

    // The hash check: rebuilt from the file on GitHub, found in the DecisionLog on the vault's chain.
    const anchor = panel.getByTestId("why-anchor");
    await expect(anchor).toHaveAttribute("data-status", "match");
    await expect(panel).toHaveAttribute("data-anchor", "match");
    await expect(anchor).toContainText("Anchored on-chain");
    await expect(anchor.getByTestId("why-anchor-status")).toHaveText("hash matches");
    // Checked against the record's own anchoring transaction, not only latestHash (a settlement record anchored
    // for the same epoch overwrites that): its DecisionRecorded event carries this hash.
    await expect(panel).toHaveAttribute("data-anchor-via", "tx");
    await expect(anchor.getByTestId("why-anchor-via")).toHaveText(
      /^\s*\(anchored in tx 0x[0-9a-f]{6}…[0-9a-f]{4}\)$/i,
    );
    await expect(anchor).toContainText("anchored in its own transaction");
    await expect(anchor).toContainText(`DecisionLog on ${c.chain}`);
    await expect(anchor).toContainText(/hash 0x[0-9a-f]{6}…[0-9a-f]{4}/);
    await expect(anchor).toContainText(`${c.decisionLog.slice(0, 6)}…${c.decisionLog.slice(-4)}`);
    const tx = anchor.getByRole("link", { name: /anchor tx/ });
    await expect(tx).toHaveAttribute("href", /\/tx\/0x[0-9a-fA-F]{64}$/);
    // The full hash is there for hover and for screen readers, the short form for everyone else.
    const full = await anchor.locator("[title^='0x']").first().getAttribute("title");
    expect(full).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(anchor).toContainText(full!);

    // Links to the record itself.
    await expect(
      panel.getByRole("link", { name: /Full record on GitHub|The epoch log on GitHub/ }),
    ).toHaveAttribute("href", /^https:\/\/github\.com\/Prashant-thakur77\/Strike\/blob\/main\/docs\//);
    await expect(panel.getByRole("link", { name: "Decision log on the agents page" })).toHaveAttribute(
      "href",
      `/app/agents?chain=${c.chainId}#decision-log`,
    );

    // Keyboard: the More toggle (when the reasoning is long) and the glossary terms work from the keyboard.
    const more = panel.getByRole("button", { name: "More" });
    if (await more.isVisible()) {
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    }
    const term = panel.locator("[data-term='anchored']");
    await term.focus();
    await expect(page.getByRole("tooltip")).toContainText("Anchored.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const dir = process.env.WHY_SHOTS;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      // From the top of the page, so the fixed navigation stays in the page's first screen, not over the rail.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
      await settle(page, 800);
      const box = (await rail.boundingBox())!;
      await page.screenshot({
        path: join(dir, `${info.project.name}-${c.shot}.png`),
        fullPage: true,
        clip: { x: 0, y: box.y - 16, width: page.viewportSize()!.width, height: box.height + 32 },
      });
    }
  });
}

test("says when there is no record, and offers a retry when GitHub cannot be reached", async ({ page }) => {
  const c = CASES[0];
  test.skip(!(await rpcUp(c.rpc, c.chainId)), `${c.chain} RPC unreachable`);
  await acknowledge(page);

  // Nothing published for this epoch: every record file is a 404.
  await page.route(`${RAW}**`, (route) => route.fulfill({ status: 404, body: "404: Not Found" }));
  await page.goto(`/app/vault/${c.vault}?chain=${c.chainId}`);
  const rail = page.locator("section#why");
  await expect(rail).toBeVisible({ timeout: 60_000 });
  const empty = rail.getByTestId("why-empty");
  await expect(empty).toBeVisible({ timeout: 60_000 });
  await expect(empty).toContainText("No record for this series yet.");
  await expect(empty.getByRole("link", { name: /Agent log folder/ })).toBeVisible();
  await expect(rail.getByTestId("why-panel")).toHaveCount(0);

  // GitHub unreachable: an error with a retry (a fresh page: a miss is remembered for the session).
  await page.unroute(`${RAW}**`);
  await page.route(`${RAW}**`, (route) => route.abort("connectionfailed"));
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  const error = page.locator("section#why").getByTestId("why-error");
  await expect(error).toBeVisible({ timeout: 60_000 });
  await expect(error).toContainText("The decision record couldn't be fetched.");
  await expect(error).toContainText("GitHub could not be reached");
  const retry = error.getByRole("button", { name: /Try again/ });
  await expect(retry).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // Once GitHub answers, Try again recovers.
  await page.unroute(`${RAW}**`);
  await retry.click();
  const panel = page.locator("section#why").getByTestId("why-panel");
  const stillEmpty = page.locator("section#why").getByTestId("why-empty");
  await expect(panel.or(stillEmpty)).toBeVisible({ timeout: 60_000 });
});

test("a later record for the same epoch (the settlement's) does not break the check: the record's own tx proves it", async ({
  page,
}) => {
  const c = CASES[2]!; // v3 on Robinhood Chain testnet: Claude's record of 1 October
  test.skip(!(await rpcUp(c.rpc, c.chainId)), `${c.chain} RPC unreachable`);
  test.skip(!(await githubUp()), "GitHub (raw.githubusercontent.com) unreachable");
  await acknowledge(page);
  // What Friday's anchored settlement record does to DecisionLog.latestHash(agent, vault, epoch): another hash.
  // The app batches reads through Multicall3, so the latestHash call is rewritten inside aggregate3's answer.
  const LATER = `0x${"5e".repeat(32)}` as Hex;
  const LATEST_HASH = "0x92e1a7ee"; // latestHash(uint256,address,uint64)
  type Rpc = { id?: number; method?: string; params?: [{ data?: Hex; input?: Hex }] };
  const rewrite = (call: Rpc, result: Hex): Hex => {
    const data = call.params?.[0]?.data ?? call.params?.[0]?.input;
    if (call.method !== "eth_call" || !data) return result;
    if (data.startsWith(LATEST_HASH)) return LATER;
    if (!data.includes(LATEST_HASH.slice(2))) return result;
    const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
    if (functionName !== "aggregate3") return result;
    const out = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: result });
    const patched = out.map((r, i) =>
      args[0][i]!.callData.startsWith(LATEST_HASH) ? { ...r, returnData: LATER } : r,
    );
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: patched });
  };
  await page.route(rpcTraffic(c.chainId, c.rpc), async (route) => {
    if (!route.request().postData()?.includes(LATEST_HASH.slice(2))) return route.continue();
    const body = route.request().postDataJSON() as Rpc | Rpc[];
    const calls = Array.isArray(body) ? body : [body];
    const res = await route.fetch();
    const json = (await res.json()) as { id: number; result?: Hex } | { id: number; result?: Hex }[];
    const answers = Array.isArray(json) ? json : [json];
    for (const a of answers) {
      const call = calls.find((x) => x.id === a.id);
      if (call && a.result) a.result = rewrite(call, a.result);
    }
    await route.fulfill({ response: res, json: Array.isArray(json) ? answers : answers[0] });
  });
  const { panel } = await openPanel(page, c);
  const anchor = panel.getByTestId("why-anchor");
  await expect(anchor).toHaveAttribute("data-status", "match");
  await expect(anchor.getByTestId("why-anchor-status")).toHaveText("hash matches");
  await expect(anchor.getByTestId("why-anchor-via")).toContainText("anchored in tx");
  const later = anchor.getByTestId("why-anchor-later");
  await expect(later).toContainText("A later record for this epoch exists");
  await expect(later).toContainText("0x5e5e5e…5e5e");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
