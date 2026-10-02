import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow, revealAll, rpcTraffic, settle } from "./helpers";

// /app/proof and the live ActivityFeed. The live checks read Robinhood Chain testnet (46630) and skip when its RPC
// is unreachable. Set PROOF_SHOTS=<dir> to also save full-page screenshots of the page.
// (Specs load as CommonJS, where @strike/sdk does not resolve, so nothing from src/lib is imported here.)

/** Same as REPO in src/lib/proof.ts. */
const REPO = "https://github.com/Prashant-thakur77/Strike";

const ROOT = resolve(__dirname, "..", "..");
const TESTNET_RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";

/** The first live epoch's transactions (2026-09-29), as the README and docs/testnet-epochs/2026-09-29.md list them. */
const KNOWN = [
  {
    event: "SeriesProposed",
    tx: "0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4",
    text: /Agent #1 proposed 4 TSLA calls at strike \$369\.86/,
  },
  {
    event: "ProposalRejected",
    tx: "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0",
    text: /Agent #1 proposal rejected: DeltaOutOfBand, 10 USDG slashed to depositors/,
  },
  {
    event: "OptionsBought",
    tx: "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9",
    text: /4 TSLA calls bought for 10\.01 USDG/,
  },
] as const;

async function testnetUp(): Promise<boolean> {
  try {
    const res = await fetch(TESTNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result !== undefined && Number(json.result) === 46630;
  } catch {
    return false;
  }
}

/** Does `git cat-file -e <spec>` succeed in the repository? */
function gitHas(spec: string): boolean {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", spec], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const desktopOnly = () => test.skip(test.info().project.name !== "desktop", "one project is enough");

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

/* ------------------------------------------------------------------ the page */

test("proof: every GitHub link points to a file or folder in the repository", async ({ page }) => {
  desktopOnly();
  await page.goto("/app/proof");
  await expect(page.getByRole("heading", { level: 1, name: /proof/i })).toBeVisible();
  const hrefs = await page
    .locator(`#main a[href^="${REPO}/"]`) // the page body; the shared footer links elsewhere (issues, repo root)
    .evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLAnchorElement).href))]);
  expect(hrefs.length).toBeGreaterThan(30);

  // v3's files live on the v3-contracts branch: checked in git when the branch is fetched, else skipped.
  const v3Ref = ["origin/v3-contracts", "v3-contracts"].find((ref) => gitHas(`${ref}^{commit}`));
  const missing: string[] = [];
  for (const href of hrefs) {
    const v3 = new URL(href).pathname.match(/^\/Prashant-thakur77\/Strike\/(blob|tree)\/v3-contracts\/(.+)$/);
    if (v3) {
      if (v3Ref && !gitHas(`${v3Ref}:${decodeURIComponent(v3[2] as string)}`)) missing.push(href);
      continue;
    }
    const m = new URL(href).pathname.match(/^\/Prashant-thakur77\/Strike\/(blob|tree)\/main\/(.+)$/);
    if (!m) {
      missing.push(`${href} (not a blob/tree link)`);
      continue;
    }
    const [, kind, path] = m;
    const file = join(ROOT, decodeURIComponent(path));
    const ok = existsSync(file) && (kind === "blob" ? statSync(file).isFile() : statSync(file).isDirectory());
    if (!ok) missing.push(href);
  }
  expect(missing).toEqual([]);
});

test("proof: layout fits the viewport with no horizontal scroll", async ({ page }) => {
  await page.goto("/app/proof");
  await expect(page.getByRole("heading", { level: 1, name: /proof/i })).toBeVisible();
  await revealAll(page);
  await settle(page, 400);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // Every section has a heading and every link a name.
  for (const label of [
    "Live on Robinhood Chain testnet",
    "Stylus",
    "Tests",
    "Security",
    "Testnet usage",
    "Live activity",
    "Research",
  ]) {
    await expect(page.getByRole("region", { name: label })).toBeAttached();
  }
  const unnamed = await page
    .locator("a")
    .evaluateAll(
      (els) => els.filter((e) => !(e.textContent ?? "").trim() && !e.getAttribute("aria-label")).length,
    );
  expect(unnamed).toBe(0);
});

test("proof: says which RPC the live reads use", async ({ page }) => {
  await page.goto("/app/proof");
  const note = page.getByTestId("rpc-source");
  await expect(note).toBeVisible();
  // "public" unless the build had ALCHEMY_API_KEY and /api/rpc reports that Alchemy answers.
  await expect(note).not.toHaveAttribute("data-provider", "checking", { timeout: 30_000 });
  const provider = await note.getAttribute("data-provider");
  expect(["alchemy", "public"]).toContain(provider);
  await expect(note).toHaveText(provider === "alchemy" ? "RPC: Alchemy" : "RPC: public");
  await expect(note).toHaveAttribute("title", /.+/);
});

test("proof: live feed shows the known transactions and the Stylus pricer is active", async ({
  page,
}, info) => {
  test.skip(!(await testnetUp()), `Robinhood Chain testnet RPC unreachable at ${TESTNET_RPC}`);
  await page.goto("/app/proof");

  for (const k of KNOWN) {
    const row = page.locator(`li[data-tx="${k.tx}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute("data-event", k.event);
    await expect(row).toContainText(k.text);
    await expect(
      row.locator(`a[href="https://explorer.testnet.chain.robinhood.com/tx/${k.tx}"]`),
    ).toBeVisible();
    await expect(row.locator("time")).toHaveAttribute("title", /UTC$/);
  }
  // Newest first: the purchase came after the rejection, which came after the proposal.
  const order = await page
    .locator("li[data-tx]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-tx")));
  const idx = KNOWN.map((k) => order.indexOf(k.tx));
  expect(idx[2]).toBeLessThan(idx[1]);
  expect(idx[1]).toBeLessThan(idx[0]);

  await expect(page.getByTestId("active-pricer")).toContainText(
    /0x60e947b8d2c2c34b95d88d02f0a06aefb6ccd04c/i,
    {
      timeout: 30_000,
    },
  );

  const dir = process.env.PROOF_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await revealAll(page);
    await settle(page, 1200);
    await page.screenshot({ path: join(dir, `proof-${info.project.name}-full.png`), fullPage: true });
    await page.locator("#activity").screenshot({ path: join(dir, `activity-${info.project.name}.png`) });
  }
});

test("activity: the scan halves its range when the RPC refuses wide getLogs ranges", async ({ page }) => {
  desktopOnly();
  test.skip(!(await testnetUp()), `Robinhood Chain testnet RPC unreachable at ${TESTNET_RPC}`);
  const LIMIT = 100_000n;
  let refused = 0;
  let served = 0;
  // Pass every RPC call through, but answer eth_getLogs over more than LIMIT blocks with a range error.
  await page.route(rpcTraffic(46630, "https://rpc.testnet.chain.robinhood.com"), async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = JSON.parse(req.postData() ?? "null") as unknown;
    const calls = (Array.isArray(body) ? body : [body]) as {
      id: number;
      method: string;
      params?: { fromBlock?: string; toBlock?: string }[];
    }[];
    const tooWide = new Set(
      calls
        .filter((c) => {
          if (c.method !== "eth_getLogs") return false;
          const p = c.params?.[0];
          const wide = BigInt(p?.toBlock ?? "0x0") - BigInt(p?.fromBlock ?? "0x0") + 1n > LIMIT;
          if (wide) refused += 1;
          else served += 1;
          return wide;
        })
        .map((c) => c.id),
    );
    if (!tooWide.size) return route.continue();
    const response = await route.fetch();
    const json = (await response.json()) as { id: number }[] | { id: number };
    const patch = (r: { id: number }) =>
      tooWide.has(r.id)
        ? {
            jsonrpc: "2.0",
            id: r.id,
            error: { code: -32602, message: "block range too large: max 100000 blocks" },
          }
        : r;
    await route.fulfill({ response, json: Array.isArray(json) ? json.map(patch) : patch(json) });
  });

  await page.goto("/app/proof");
  for (const k of KNOWN) {
    await expect(page.locator(`li[data-tx="${k.tx}"]`)).toBeVisible({ timeout: 90_000 });
  }
  expect(refused).toBeGreaterThan(0);
  expect(served).toBeGreaterThan(1);
});

test("activity: shows an error with a retry when the RPC is down, without a wallet", async ({ page }) => {
  desktopOnly();
  await page.route(rpcTraffic(46630, "https://rpc.testnet.chain.robinhood.com"), (route) =>
    route.abort("connectionrefused"),
  );
  await page.goto("/app/proof");
  const feed = page.getByRole("region", { name: "Live activity" });
  await expect(feed.getByRole("alert")).toContainText("Couldn't read Robinhood Chain testnet", {
    timeout: 60_000,
  });
  await expect(feed.getByRole("button", { name: /try again/i })).toBeVisible();
});
