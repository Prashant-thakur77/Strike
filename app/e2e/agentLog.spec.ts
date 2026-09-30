import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  AGENT_LOG_FOLDER_URL,
  AGENT_LOG_LIMIT,
  AgentLogError,
  fetchAgentLog,
  fmtDecimal,
  fmtDeltaBps,
  fmtFactor,
  fmtLogDate,
  fmtRunTime,
  fmtSigma,
  listingError,
  nextRun,
  parseListing,
  parseRecord,
  parseRecordText,
  strategyLabel,
  verdictOf,
} from "../src/lib/agentLog";
import { acknowledge, horizontalOverflow } from "./helpers";

// The agent decision log on /app/agents: the parser against records written by a local anvil run of the example
// agent (e2e/fixtures/agent-log), and the page with the GitHub API mocked by page.route.

const FIXTURES = join(__dirname, "fixtures", "agent-log");
const text = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string) => JSON.parse(text(name)) as Record<string, unknown>;

const API = "https://api.github.com/repos/Prashant-thakur77/Strike/contents/docs/agent-log?ref=main";
const RAW = "https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/docs/agent-log";
const BLOB = "https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log";
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";

/** A contents API entry, as GitHub lists a file. */
const entry = (name: string, type = "file") => ({
  name,
  path: `docs/agent-log/${name}`,
  type,
  download_url: type === "file" ? `${RAW}/${name}` : null,
  html_url: `${BLOB}/${name}`,
});

const unit = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");

/* ================================================================ parser */

test.describe("parser", () => {
  test("reads a proposal record", () => {
    unit();
    const r = parseRecord(json("2026-10-05-sTSLA-CC.json"));
    expect(r).not.toBeNull();
    expect(r!.action).toBe("propose");
    expect(r!.date).toBe("2026-10-05");
    expect(r!.vault).toMatchObject({ symbol: "sTSLA-CC", kind: "covered-call", underlying: "TSLA" });
    expect(r!.vault.mandateSummary).toMatch(/^\|delta\| 0\.10-0\.35/);
    expect(r!.market).toMatchObject({
      spot: "369",
      sigma: 0.6,
      source: "epoch-open snapshot",
      marketOpen: true,
    });
    expect(r!.decision).toMatchObject({ strategy: "default", targetDeltaBps: 2000, premiumBps: 10000 });
    expect(r!.decision!.reasoning).toMatch(/^Target 0\.20 delta/);
    expect(r!.dryRun).toMatchObject({ ok: true, strike: "390.36", delta: 0.2001, size: "8" });
    expect(r!.transactions.map((t) => t.label)).toEqual(["openEpoch", "proposeByDelta"]);
    // Anvil has no explorer: no link.
    expect(r!.transactions.every((t) => t.url === null)).toBe(true);
    expect(r!.result).toMatchObject({ status: "accepted", strike: "390.36", size: "8" });
    expect(r!.trackRecord).toMatchObject({
      accepted: 1,
      rejected: 0,
      strikes: 0,
      maxStrikes: 3,
      bond: "100",
    });
    expect(verdictOf(r!.result)).toMatchObject({ tone: "good", label: "Accepted" });
  });

  test("reads a rejected reckless proposal with its slash", () => {
    unit();
    const r = parseRecord(json("2026-10-05-sTSLA-CSP.json"))!;
    expect(r.action).toBe("reckless");
    expect(r.vault.kind).toBe("cash-secured-put");
    expect(r.decision!.targetDeltaBps).toBeNull();
    expect(r.dryRun).toMatchObject({ ok: false, reason: "DeltaOutOfBand", optionType: "put" });
    expect(verdictOf(r.result)).toEqual({
      tone: "bad",
      label: "Rejected",
      reason: "DeltaOutOfBand",
      slashed: "10",
    });
  });

  test("reads a settlement record with no decision", () => {
    unit();
    const r = parseRecord(json("2026-10-09-sTSLA-CC.json"))!;
    expect(r.action).toBe("settle");
    expect(r.decision).toBeNull();
    expect(r.dryRun).toBeNull();
    expect(r.result).toMatchObject({
      status: "settled",
      settlementPrice: "400",
      payout: "0.0723 TSLA",
      premium: "8.898629",
      settledBy: "agent",
    });
    expect(r.trackRecord!.cumulativePnl).toBe("-20.021371");
  });

  test("keeps the mandate guard's notes", () => {
    unit();
    const r = parseRecord(json("2026-10-05-sTSLA-CSP-2.json"))!;
    expect(r.decision!.notes).toHaveLength(1);
    expect(r.decision!.notes[0]).toMatch(/^Claude was unavailable/);
  });

  test("every fixture record parses", () => {
    unit();
    for (const f of [
      "2026-10-05-sTSLA-CC.json",
      "2026-10-05-sTSLA-CSP.json",
      "2026-10-05-sTSLA-CSP-2.json",
      "2026-10-09-sTSLA-CC.json",
      "2026-10-09-sTSLA-CSP.json",
    ]) {
      expect(parseRecordText(text(f)), f).not.toBeNull();
    }
  });

  test("skips an unknown version", () => {
    unit();
    expect(json("unknown-version.json").version).toBe(2);
    expect(parseRecord(json("unknown-version.json"))).toBeNull();
    expect(parseRecord({ ...json("2026-10-05-sTSLA-CC.json"), version: "1" })).toBeNull();
    expect(parseRecord({ ...json("2026-10-05-sTSLA-CC.json"), version: undefined })).toBeNull();
  });

  test("skips malformed records without throwing", () => {
    unit();
    expect(parseRecord(json("malformed.json"))).toBeNull();
    expect(parseRecordText(text("truncated.txt"))).toBeNull();
    for (const bad of [null, undefined, 1, "record", [], [json("2026-10-05-sTSLA-CC.json")], {}]) {
      expect(parseRecord(bad)).toBeNull();
    }
    const base = json("2026-10-05-sTSLA-CC.json");
    expect(parseRecord({ ...base, action: "hedge" })).toBeNull();
    expect(parseRecord({ ...base, date: "5 Oct 2026" })).toBeNull();
    expect(parseRecord({ ...base, vault: null })).toBeNull();
    expect(parseRecord({ ...base, vault: { ...(base.vault as object), symbol: "" } })).toBeNull();
    expect(parseRecord({ ...base, result: { status: "won" } })).toBeNull();
    expect(parseRecordText("")).toBeNull();
    expect(parseRecordText("<html>404</html>")).toBeNull();
  });

  test("drops malformed optional sections and keeps the record", () => {
    unit();
    const base = json("2026-10-05-sTSLA-CC.json");
    const r = parseRecord({
      ...base,
      market: { spot: 369, source: "guess" },
      decision: "trust me",
      dryRun: [],
      trackRecord: { accepted: "one" },
      transactions: [
        null,
        { label: "noHash" },
        { label: "evil", hash: `0x${"a".repeat(64)}`, url: "javascript:alert(1)" },
        { label: "ok", hash: `0x${"b".repeat(64)}`, url: "https://example.org/tx/1" },
      ],
    })!;
    expect(r).not.toBeNull();
    expect(r.market).toBeNull();
    expect(r.decision).toBeNull();
    expect(r.dryRun).toBeNull();
    expect(r.trackRecord).toBeNull();
    expect(r.transactions).toEqual([
      { label: "evil", hash: `0x${"a".repeat(64)}`, url: null },
      { label: "ok", hash: `0x${"b".repeat(64)}`, url: "https://example.org/tx/1" },
    ]);
  });

  test("links Robinhood Chain testnet transactions to Blockscout", () => {
    unit();
    const base = json("2026-10-05-sTSLA-CC.json");
    const r = parseRecord({
      ...base,
      chain: { id: 46630, name: "Robinhood Chain Testnet", explorer: EXPLORER },
    })!;
    expect(r.transactions[1].url).toBe(`${EXPLORER}/tx/${r.transactions[1].hash}`);
  });

  test("names the strategy: rule-based, or Claude (also under its old name, llm)", () => {
    unit();
    const base = json("2026-10-05-sTSLA-CC.json");
    const decision = base.decision as Record<string, unknown>;
    expect(strategyLabel(parseRecord(base)!.decision!.strategy)).toBe("Rule-based");
    for (const strategy of ["claude", "llm"]) {
      const r = parseRecord({ ...base, decision: { ...decision, strategy } })!;
      expect(r.decision!.strategy).toBe("claude");
      expect(strategyLabel(r.decision!.strategy)).toBe("Claude");
    }
  });

  test("formats the card's figures", () => {
    unit();
    expect(fmtLogDate("2026-10-05")).toBe("Mon 5 Oct 2026");
    expect(fmtLogDate("2026-10-09")).toBe("Fri 9 Oct 2026");
    expect(fmtLogDate("soon")).toBe("soon");
    expect(fmtSigma(0.6)).toBe("60.0%");
    expect(fmtSigma(null)).toBe("—");
    expect(fmtDeltaBps(2000)).toBe("0.20");
    expect(fmtFactor(10_000)).toBe("100%");
    expect(fmtFactor(9_750)).toBe("97.5%");
    expect(fmtDecimal("-20.021371")).toBe("−20.02");
    expect(fmtDecimal("114.200879346770970136")).toBe("114.2");
    expect(fmtDecimal("50000")).toBe("50,000");
    expect(fmtDecimal(null)).toBe("—");
  });

  test("names the first and the next weekly run", () => {
    unit();
    const first = nextRun(Date.parse("2026-09-30T12:00:00Z"));
    expect(first.first).toBe(true);
    expect(fmtRunTime(first.at)).toBe("Friday 2 Oct, 21:15 UTC");
    const later = nextRun(Date.parse("2026-10-07T09:00:00Z"));
    expect(later.first).toBe(false);
    expect(fmtRunTime(later.at)).toBe("Friday 9 Oct, 21:15 UTC");
    expect(fmtRunTime(nextRun(Date.parse("2026-10-10T09:00:00Z")).at)).toBe("Monday 12 Oct, 15:00 UTC");
    expect(fmtRunTime(nextRun(Date.parse("2026-10-12T15:00:00Z")).at)).toBe("Friday 16 Oct, 21:15 UTC");
  });
});

test.describe("listing", () => {
  test("keeps record files only, newest first, the later same-day run first", () => {
    unit();
    const files = parseListing([
      entry("README.md"),
      entry("2026-10-05-sTSLA-CC.json"),
      entry("2026-10-05-sTSLA-CC.md"),
      entry("2026-10-05-sTSLA-CSP.json"),
      entry("2026-10-05-sTSLA-CSP-2.json"),
      entry("2026-10-05-sTSLA-CSP-2.md"),
      entry("2026-10-09-sTSLA-CC.json"),
      entry("2026-10-09-sTSLA-CC.md"),
      entry("archive", "dir"),
      entry("notes.json"),
      { ...entry("2026-10-10-sTSLA-CC.json"), download_url: "https://evil.example/2026-10-10-sTSLA-CC.json" },
      { name: "2026-10-11-sTSLA-CC.json", type: "file" },
      null,
      "README.md",
    ]);
    expect(files.map((f) => f.name)).toEqual([
      "2026-10-09-sTSLA-CC.json",
      "2026-10-05-sTSLA-CSP-2.json",
      "2026-10-05-sTSLA-CC.json",
      "2026-10-05-sTSLA-CSP.json",
    ]);
    expect(files[0].downloadUrl).toBe(`${RAW}/2026-10-09-sTSLA-CC.json`);
    // The .md twin when there is one, else the JSON itself.
    expect(files[0].recordUrl).toBe(`${BLOB}/2026-10-09-sTSLA-CC.md`);
    expect(files[3].recordUrl).toBe(`${BLOB}/2026-10-05-sTSLA-CSP.json`);
    expect(files[1].run).toBe(2);
  });

  test("keeps the newest twelve", () => {
    unit();
    const names = Array.from(
      { length: 20 },
      (_, i) => `2026-${String(10 + Math.floor(i / 10))}-${String((i % 10) + 10)}-sTSLA-CC.json`,
    );
    const files = parseListing(names.map((n) => entry(n)));
    expect(files).toHaveLength(AGENT_LOG_LIMIT);
    expect(files[0].name).toBe("2026-11-19-sTSLA-CC.json");
    expect(files.at(-1)!.name).toBe("2026-10-18-sTSLA-CC.json");
  });

  test("anything but an array lists nothing", () => {
    unit();
    expect(parseListing({ message: "Not Found" })).toEqual([]);
    expect(parseListing(null)).toEqual([]);
  });

  test("maps GitHub's answers to errors", () => {
    unit();
    const headers = { get: (n: string) => (n === "x-ratelimit-reset" ? "1790000000" : null) };
    expect(listingError(200)).toBeNull();
    expect(listingError(404)).toBeNull();
    const limited = listingError(403, headers)!;
    expect(limited.kind).toBe("rate-limit");
    expect(limited.resetAt).toBe(1_790_000_000_000);
    expect(listingError(429)!.kind).toBe("rate-limit");
    expect(listingError(429)!.resetAt).toBeNull();
    expect(listingError(500)!.kind).toBe("http");
  });

  test("fetches, skips unreadable records and sorts by run time", async () => {
    unit();
    const listing = [
      entry("README.md"),
      entry("2026-10-05-sTSLA-CC.json"),
      entry("2026-10-05-sTSLA-CSP.json"),
      entry("2026-10-05-sTSLA-CSP-2.json"),
      entry("2026-10-09-sTSLA-CC.json"),
      entry("2026-10-12-sTSLA-CC.json"), // unknown version
      entry("2026-10-12-sTSLA-CSP.json"), // malformed
      entry("2026-10-13-sTSLA-CC.json"), // truncated JSON
      entry("2026-10-14-sTSLA-CC.json"), // 404 from raw
    ];
    const bodies: Record<string, string> = {
      "2026-10-05-sTSLA-CC.json": text("2026-10-05-sTSLA-CC.json"),
      "2026-10-05-sTSLA-CSP.json": text("2026-10-05-sTSLA-CSP.json"),
      "2026-10-05-sTSLA-CSP-2.json": text("2026-10-05-sTSLA-CSP-2.json"),
      "2026-10-09-sTSLA-CC.json": text("2026-10-09-sTSLA-CC.json"),
      "2026-10-12-sTSLA-CC.json": text("unknown-version.json"),
      "2026-10-12-sTSLA-CSP.json": text("malformed.json"),
      "2026-10-13-sTSLA-CC.json": text("truncated.txt"),
    };
    const fake = async (url: string) => {
      if (url.startsWith("https://api.github.com/")) return Response.json(listing);
      const body = bodies[url.slice(RAW.length + 1)];
      return body === undefined ? new Response("404", { status: 404 }) : new Response(body);
    };
    const log = await fetchAgentLog(fake);
    expect(log.skipped).toBe(4);
    expect(log.entries.map((e) => e.name)).toEqual([
      "2026-10-09-sTSLA-CC",
      "2026-10-05-sTSLA-CSP-2",
      "2026-10-05-sTSLA-CSP",
      "2026-10-05-sTSLA-CC",
    ]);
  });

  test("an empty folder is an empty log, not an error", async () => {
    unit();
    const log = await fetchAgentLog(async () => Response.json([entry("README.md")]));
    expect(log).toEqual({ entries: [], skipped: 0 });
    const missing = await fetchAgentLog(async () => Response.json({ message: "Not Found" }, { status: 404 }));
    expect(missing.entries).toEqual([]);
  });

  test("a rate limit or a network failure throws a typed error", async () => {
    unit();
    const limited = fetchAgentLog(async () => new Response("{}", { status: 403 }));
    await expect(limited).rejects.toBeInstanceOf(AgentLogError);
    await expect(limited).rejects.toMatchObject({ kind: "rate-limit" });
    await expect(
      fetchAgentLog(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ kind: "network" });
    // The listing loads but no record can be downloaded: a network problem too.
    await expect(
      fetchAgentLog(async (url) =>
        url.startsWith("https://api.github.com/")
          ? Response.json([entry("2026-10-05-sTSLA-CC.json")])
          : Promise.reject(new TypeError("Failed to fetch")),
      ),
    ).rejects.toMatchObject({ kind: "network" });
  });
});

/* ================================================================ page */

const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-ratelimit-reset" };

/** Serve `files` (name → JSON body) as docs/agent-log on GitHub. */
async function mockGitHub(page: Page, files: Record<string, unknown>) {
  await page.route(`${API}*`, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify([
        entry("README.md"),
        ...Object.keys(files).flatMap((n) => [entry(n), entry(n.replace(/\.json$/, ".md"))]),
      ]),
    }),
  );
  await page.route(`${RAW}/**`, (route: Route) => {
    const name = decodeURIComponent(
      route
        .request()
        .url()
        .slice(RAW.length + 1),
    );
    return name in files
      ? route.fulfill({
          status: 200,
          headers: cors,
          contentType: "text/plain",
          body: JSON.stringify(files[name]),
        })
      : route.fulfill({ status: 404, headers: cors, body: "404: Not Found" });
  });
}

/** Two records as they will come from the live testnet: a Claude proposal and a rejected reckless demo. */
function liveRecords() {
  const chain = { id: 46630, name: "Robinhood Chain Testnet", explorer: EXPLORER };
  const cc = json("2026-10-05-sTSLA-CC.json");
  const reasoning =
    "TSLA's opening sigma of 60% is high for the week, so a 0.18 delta keeps the call well out of the money while the premium still clears the mandate's yield floor. " +
    "Earnings are three weeks out, so there is no event inside this tenor. Spot sits mid-range after last week's move, and the oracle is fresh. " +
    "Pricing at 100% of fair value keeps the series attractive to buyers; anything lower gives premium away, anything higher risks not selling out before expiry. " +
    "The size stays at 80% of capacity, the mandate's cap.";
  const claude = {
    ...cc,
    chain,
    decision: { ...(cc.decision as object), strategy: "claude", targetDeltaBps: 1800, reasoning },
  };
  const reckless = { ...json("2026-10-05-sTSLA-CSP.json"), chain };
  return { "2026-10-05-sTSLA-CC.json": claude, "2026-10-05-sTSLA-CSP.json": reckless };
}

test.describe("decision log on /app/agents", () => {
  test.beforeEach(async ({ page }) => {
    await acknowledge(page);
  });

  test("renders one card per record, newest first", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const files = liveRecords();
    await mockGitHub(page, files);
    await page.goto("/app/agents");
    const log = page.locator("#decision-log");
    await expect(log.getByRole("heading", { name: "Decision log" })).toBeAttached();
    const cards = log.getByRole("article");
    await expect(cards).toHaveCount(2);

    // The reckless run happened after the Claude proposal (chain time 15:00:12 vs 15:00:07): it comes first.
    const rejected = cards.nth(0);
    await expect(rejected.getByRole("heading")).toContainText("Mon 5 Oct 2026");
    await expect(rejected.getByRole("heading")).toContainText("sTSLA-CSP");
    await expect(rejected.getByRole("heading")).toContainText("Cash-secured put");
    await expect(rejected.getByText("Reckless demo")).toBeVisible();
    await expect(rejected.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(rejected.getByText("DeltaOutOfBand")).toBeVisible();
    await expect(rejected.getByText("−10 USDG slashed")).toBeVisible();

    const accepted = cards.nth(1);
    await expect(accepted.getByRole("heading")).toContainText("sTSLA-CC");
    await expect(accepted.getByRole("heading")).toContainText("Covered call");
    await expect(accepted.getByText("Propose", { exact: true })).toBeVisible();
    await expect(accepted.getByText("Claude", { exact: true })).toBeVisible();
    await expect(accepted.getByText("Accepted", { exact: true })).toBeVisible();
    await expect(accepted.getByText("$369.00")).toBeVisible();
    await expect(accepted.getByText("60.0%")).toBeVisible();
    await expect(accepted.getByText(/Epoch-open snapshot/)).toBeVisible();
    await expect(accepted.getByText("0.18 delta", { exact: true })).toBeVisible();
    await expect(accepted.getByText("premium 100% of fair value")).toBeVisible();
    await expect(accepted.getByText("$390.36")).toBeVisible();
    await expect(accepted.getByText(/1 accepted · 0 rejected/)).toBeVisible();

    // Every transaction links to Blockscout; the full record links to the markdown on GitHub.
    const txs = (files["2026-10-05-sTSLA-CC.json"] as unknown as { transactions: { hash: string }[] })
      .transactions;
    await expect(accepted.getByRole("link", { name: /openEpoch/ })).toHaveAttribute(
      "href",
      `${EXPLORER}/tx/${txs[0].hash}`,
    );
    await expect(accepted.getByRole("link", { name: /proposeByDelta/ })).toHaveAttribute(
      "href",
      `${EXPLORER}/tx/${txs[1].hash}`,
    );
    await expect(accepted.getByRole("link", { name: /Full record/ })).toHaveAttribute(
      "href",
      `${BLOB}/2026-10-05-sTSLA-CC.md`,
    );

    // The long reasoning is clamped with a toggle; the short one has none.
    const quote = accepted.locator("blockquote p");
    const more = accepted.getByRole("button", { name: "More" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const clamped = await quote.evaluate((el) => el.clientHeight);
    await more.click();
    await expect(accepted.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    expect(await quote.evaluate((el) => el.clientHeight)).toBeGreaterThan(clamped);
    if (test.info().project.name === "desktop") {
      await expect(rejected.getByRole("button", { name: /More|Less/ })).toHaveCount(0);
    }

    await log.scrollIntoViewIfNeeded();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test("an empty folder shows when the first record is due", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-09-30T12:00:00Z"));
    await mockGitHub(page, {});
    await page.goto("/app/agents");
    const log = page.locator("#decision-log");
    await expect(
      log.getByText("The weekly agent publishes its first record on Friday 2 Oct, 21:15 UTC."),
    ).toBeVisible();
    await expect(log.getByRole("article")).toHaveCount(0);
    await expect(log.getByRole("link", { name: /First live epoch/ })).toHaveAttribute(
      "href",
      "https://github.com/Prashant-thakur77/Strike/blob/main/docs/testnet-epochs/2026-09-29.md",
    );
    await expect(log.getByRole("link", { name: /weekly workflow/ })).toHaveAttribute(
      "href",
      "https://github.com/Prashant-thakur77/Strike/blob/main/.github/workflows/agent.yml",
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a rate-limited GitHub API falls back to the folder link", async ({ page }) => {
    await page.route(`${API}*`, (route) =>
      route.fulfill({
        status: 403,
        headers: { ...cors, "x-ratelimit-reset": String(Date.UTC(2026, 9, 5, 16, 2) / 1000) },
        contentType: "application/json",
        body: JSON.stringify({ message: "API rate limit exceeded" }),
      }),
    );
    await page.goto("/app/agents");
    const log = page.locator("#decision-log");
    await expect(log.getByText("The decision log couldn't load here.")).toBeVisible();
    await expect(log.getByText(/limit for unauthenticated requests .* resets at 16:02 UTC/)).toBeVisible();
    await expect(log.getByRole("link", { name: /Read the records on GitHub/ })).toHaveAttribute(
      "href",
      AGENT_LOG_FOLDER_URL,
    );
    await expect(log.getByRole("article")).toHaveCount(0);
  });

  test("a network failure falls back too", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "same code path as the rate limit");
    await page.route(`${API}*`, (route) => route.abort("internetdisconnected"));
    await page.goto("/app/agents");
    const log = page.locator("#decision-log");
    await expect(
      log.getByText("GitHub could not be reached from this browser.", { exact: false }),
    ).toBeVisible();
    await expect(log.getByRole("link", { name: /Read the records on GitHub/ })).toHaveAttribute(
      "href",
      AGENT_LOG_FOLDER_URL,
    );
    await expect(log.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
