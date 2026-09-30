// The 3-minute demo, scene by scene. Each scene: what is said (`lines`, captioned word for word), what is on screen
// (`prepare` runs before the clock starts, `run` on the clock), and its caption tag. Durations come from the
// narration audio, so editing a line re-times its scene. Numbers come from README.md (facts) or the live app.
// Plan and reasons: docs/submission/demo-script.md.
import { L } from "./lib/engine.mjs";
import { sayDec, sayInt, sayUsd } from "./lib/facts.mjs";
import { signingContext, signingPrepare, signingRun } from "./lib/wallet.mjs";

export const APP = (process.env.APP_URL ?? "https://strike-options.vercel.app").replace(/\/$/, "");
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const REJECT_TX = "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0";
const CC_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"; // sTSLA-CC, v2 on 46630
const U = "U S D G"; // Chatterbox reads "USDG" as a word
const EM = "Eepok Manager"; // "Epoch Manager" as Chatterbox should say it (Whisper hears "epoch manager")

/** Read before narrating: values the app shows live. */
export async function probe(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("strike.ack.v1", "1");
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(`${APP}/app/monitor`);
  await page.getByText("NVIDIA").first().waitFor({ timeout: 60_000 });
  const mult = await nvdaMultiplier(page);
  if (!mult) throw new Error("NVDA multiplier not found on /app/monitor");
  // the vault's worst case this week, from the Stylus risk engine (the Risk section of the vault page)
  await page.goto(`${APP}/app/vault/${CC_VAULT}`);
  const worst = await page
    .waitForFunction(() => document.body.innerText.match(/Worst\s*[−-]\$([\d,]+\.\d\d)/)?.[1], null, {
      timeout: 60_000,
    })
    .then((h) => h.jsonValue());
  await ctx.close();
  return {
    nvdaMultiplier: mult,
    nvdaMultiplierSaid: Number(mult).toFixed(6),
    riskWorst: worst.replace(/,/g, ""),
  };
}

async function nvdaMultiplier(page) {
  return page
    .waitForFunction(
      () => {
        const leaf = (root, test) =>
          [...root.querySelectorAll("*")].find(
            (el) => el.children.length === 0 && test(el.textContent.trim()),
          );
        const isMult = (t) => /^1\.\d{6,}$/.test(t);
        let row = leaf(document.body, (t) => t === "NVIDIA");
        while (row && !leaf(row, isMult)) row = row.parentElement;
        if (!row || leaf(row, (t) => t === "Tesla" || t === "Amazon")) return null;
        return leaf(row, isMult).textContent.trim();
      },
      null,
      { timeout: 60_000 },
    )
    .then((h) => h.jsonValue());
}

async function openApp(page, path, ready) {
  await page.goto(`${APP}${path}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  if (ready) await ready();
  await page.evaluate(() => document.fonts.ready);
}

export function scenes(f, live) {
  const mult = live.nvdaMultiplierSaid;
  return [
    {
      id: "hook",
      screen: `The landing page ("Stock tokens that pay every week"), then a zoom on its payoff sketch (covered call against the stock alone) and on the one-line definition.`,
      tag: "Strike",
      lines: [
        L("This is Strike: weekly options vaults for Robinhood Chain stock tokens."),
        L("A covered call pays a weekly premium, | but someone has to pick the strike."),
        L("Here an AI agent picks it, | and the contract checks it against a mandate."),
      ],
      async prepare(page) {
        await page.goto(`${APP}/`);
        await page.waitForLoadState("load");
        await page.evaluate(() => document.fonts.ready);
        await page.locator("#live").getByText("DeltaOutOfBand").first().waitFor({ timeout: 60_000 });
      },
      async run(h) {
        // the hero's payoff sketch (covered call against the stock alone), then the one-line definition
        await h.cue(1, -0.2);
        await h.page.evaluate(() => {
          let el = window.__v.leaf("^Covered call$", "i");
          while (el && !el.querySelector("svg")) el = el.parentElement;
          if (el) window.__v.zoom(el, 1.7, 700);
        });
        await h.cue(2, -0.2);
        await h.zoom(h.page.locator("p", { hasText: "Weekly options vaults for Robinhood Chain" }).first(), {
          scale: 1.8,
          ms: 700,
        });
      },
    },
    {
      id: "playground",
      screen: `\`/app/playground\`, no wallet. Zoom on the honest 0.20-delta call preset, click it, zoom on **Accepted**; click the reckless at-the-money preset, zoom on **Rejected: DeltaOutOfBand**, then on the ${f.slash} USDG slash panel.`,
      tag: "Playground",
      lines: [
        L(
          "The playground asks the deployed Epoch Manager about a proposal, | with no wallet.",
          `The playground asks the deployed ${EM} about a proposal, | with no wallet.`,
        ),
        L("An honest 0.20-delta call: accepted.", "An honest zero point two oh delta call: accepted."),
        L("A reckless at-the-money strike: | rejected, delta out of band."),
        L(
          `A real one would cost the agent ${f.slash} USDG of its bond.`,
          `A real one would cost the agent ${sayInt(f.slash)} ${U} of its bond.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/playground", () =>
          page.locator('[data-testid="verdict"][data-kind="accepted"]').waitFor({ timeout: 60_000 }),
        );
        const presets = page.getByRole("group", { name: "Preset proposals" });
        const y = await presets.evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 175, 0), y);
      },
      async run(h) {
        const page = h.page;
        const presets = page.getByRole("group", { name: "Preset proposals" });
        const honest = presets.getByRole("button", { name: /0\.20-delta call/ });
        const verdict = page.getByTestId("verdict");
        await h.at(1.2);
        await h.zoom(honest, { scale: 1.5 });
        await h.at(2.2);
        await honest.click();
        await h.cue(1, -0.3);
        await h.zoom(verdict.getByText(/^Accepted/).first(), { scale: 1.6 });
        await h.cue(2, -0.5);
        await h.zoom(presets.getByRole("button", { name: /At-the-money/ }), { scale: 1.5 });
        await presets.getByRole("button", { name: /At-the-money/ }).click();
        await page.locator('[data-testid="verdict"][data-kind="rejected"]').waitFor({ timeout: 30_000 });
        await verdict.getByText("DeltaOutOfBand").first().waitFor({ timeout: 15_000 });
        await h.chunk(2, 1, -0.3);
        await h.zoom(verdict.getByText(/^Rejected/).first(), { scale: 1.6 });
        await h.cue(3, -0.2);
        await h.expectText(`slashed by ${f.slash} USDG`);
        await h.zoom(verdict.getByText(/slashed by/).first(), { scale: 1.5 });
      },
    },
    {
      id: "epoch",
      screen: `A terminal replay of the real run on 29 September ([testnet-epochs/2026-09-29.md](../testnet-epochs/2026-09-29.md)), opening half-printed: the seller agent's \`proposeByDelta\` accepted at $${f.strike}, then the reckless agent's forced put rejected and its bond going from ${f.bondBefore} to ${f.bondAfter} USDG.`,
      tag: "Live epoch",
      kind: "replay",
      replay: {
        mode: "terminal",
        wintitle: "~/strike · Robinhood Chain testnet (46630) · live run, 2026-09-29 17:08 UTC",
        sublabel: "docs/testnet-epochs/2026-09-29.md",
      },
      lines: [
        L("It happened for real on September 29.", "It happened for real on September twenty-ninth."),
        L(
          `The seller agent asked for a 0.20-delta Tesla call, | and the contract solved the strike on-chain: $${f.strike}, accepted.`,
          `The seller agent asked for a zero point two oh delta Tesla call, | and the contract solved the strike on-chain: ${sayUsd(f.strike)}. Accepted.`,
        ),
        L("Then a reckless agent forced an at-the-money put."),
        L(
          `Rejected, and ${f.slash} USDG slashed: | its bond went from ${f.bondBefore} to ${f.bondAfter}.`,
          `Rejected, and ${sayInt(f.slash)} ${U} slashed: | its bond went from ${sayInt(f.bondBefore)} to ${sayInt(f.bondAfter)}.`,
        ),
      ],
      async prepare(page, env) {
        await page.evaluate(
          (seg) => {
            window.__term.load(seg);
            window.__term.prefill("^\\[3\\]");
          },
          {
            ...env.epoch.seller,
            label: "Seller agent · 0.20-delta covered call",
            command: "pnpm --filter @strike/agent-example start -- --vault sTSLA-CC",
          },
        );
      },
      async run(h, env) {
        const t = (until, pause) => h.page.evaluate(([u, p]) => window.__term.type(u, p), [until, pause]);
        await h.cue(1, 0.2);
        await t("^\\s*Verdict: None", 120);
        await h.chunk(1, 1, -0.6);
        await t("^\\s*Accepted", 110);
        await h.page.evaluate(() => window.__term.mark("^\\s*Accepted", "hl"));
        await h.cue(2, -0.5);
        await h.page.evaluate(
          (seg) => {
            window.__term.load(seg);
            window.__term.prefill("^\\[2\\]");
          },
          {
            ...env.epoch.reckless,
            label: "Reckless agent · at-the-money put, forced",
            command: "pnpm --filter @strike/agent-example start -- --reckless --vault sTSLA-CSP",
          },
        );
        await t("^\\s*A careful agent", 130);
        await h.cue(3, -0.8);
        await t("REJECTED", 110);
        await h.page.evaluate(() => window.__term.mark("REJECTED", "hlbad"));
        await h.chunk(3, 1, -0.4);
        await t("^\\s*Agent now", 90);
        await h.page.evaluate(() => window.__term.mark("^\\s*Agent now", "hlbad"));
      },
    },
    {
      id: "explorer",
      screen: `The rejected \`proposeSeries\` transaction on the Robinhood Chain explorer ([0x3df523aa…c6a0](${EXPLORER}/tx/${REJECT_TX})): zoom on the **Success** status, then a highlight box and zoom on "Tokens transferred: AgentRegistry → EpochManager for ${f.slash} USDG".`,
      tag: "Explorer",
      minDur: 13,
      lines: [
        L("Here it is on the Robinhood Chain explorer."),
        L("The status says Success, because a rejection is not a revert."),
        L(
          `The transaction ran, the contract refused the proposal, | and ${f.slash} USDG left the agent's bond.`,
          `The transaction ran, the contract refused the proposal, | and ${sayInt(f.slash)} ${U} left the agent's bond.`,
        ),
      ],
      async prepare(page) {
        await page.goto(`${EXPLORER}/tx/${REJECT_TX}`, { waitUntil: "domcontentloaded" });
        await page.getByText("proposeSeries").first().waitFor({ timeout: 60_000 });
        await page.getByText("Tokens transferred").first().waitFor({ timeout: 60_000 });
        await page.mouse.move(1900, 700); // off the explorer's hover menus
        await page.waitForTimeout(2500);
      },
      async run(h) {
        await h.cue(1, -0.3);
        await h.zoom(/^Success$/, { scale: 1.8 });
        await h.cue(2, -0.3);
        await h.unzoom(350);
        await h.at(h.tl.lines[2].start + 0.1);
        // the "Tokens transferred" row: its label and value, boxed together
        await h.page.evaluate(() => {
          const v = window.__v;
          const label = v.leaf("^Tokens transferred$", "i");
          const from = v.leaf("^AgentRegistry$", "");
          const usdg = [...document.querySelectorAll("*")].filter(
            (e) =>
              e.children.length === 0 &&
              e.textContent.trim() === "USDG" &&
              Math.abs(v.rect(e).y - v.rect(from).y) < 30,
          )[0];
          const r = v.union([v.rect(label), v.rect(from), v.rect(usdg ?? from)]);
          v.box(r, { pad: 14, dim: 0.35 });
          v.zoomRect(r, 1.5);
        });
      },
    },
    signingScene(f),
    {
      id: "vault",
      screen: `The TSLA covered-call vault page: zoom on the $${f.strike} strike and the ${f.premium} USDG premium collected, then the payoff chart with a zoom on the $372.36 breakeven, then the Risk section (greeks and a ±30% stress test from the Rust risk engine on Stylus) with a zoom on the worst case, −$${live.riskWorst}, read at render time.`,
      tag: "Vault",
      lines: [
        L(
          `The Tesla covered-call vault this week: | the $${f.strike} call, all four sold | to a buyer agent, for ${f.premium} USDG.`,
          `The Tesla covered-call vault this week: | the ${sayUsd(f.strike)} call, all four sold | to a buyer agent, for ${sayDec(f.premium)} ${U}.`,
        ),
        L(
          "The buyer profits above $372.36. | At or below the strike, depositors keep the whole premium.",
          `The buyer profits above ${sayUsd("372.36")}. | At or below the strike, depositors keep the whole premium.`,
        ),
        L("A risk engine written in Rust on Stylus | stress-tests this week's option on-chain."),
        L(
          `Its worst case: a 30% jump in Tesla, | and −$${live.riskWorst} for the vault.`,
          `Its worst case: a thirty percent jump in Tesla, | and minus ${sayUsd(live.riskWorst)} for the vault.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, `/app/vault/${CC_VAULT}`, () =>
          page.getByText("How the buy price is set").first().waitFor({ timeout: 60_000 }),
        );
        for (const t of [`$${f.strike}`, "Breakeven $372.36", "4 of 4 sold", `${f.premium} USDG`])
          await page.getByText(t, { exact: false }).first().waitFor({ timeout: 30_000 });
        const y = await page
          .getByRole("heading", { name: /This week's option/ })
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 120, 0), y);
      },
      async run(h) {
        await h.chunk(0, 1, -0.3);
        await h.zoom(h.page.locator('[class*="seriesStrike"]').first(), { scale: 1.5 });
        await h.chunk(0, 2, -0.4);
        await h.box(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { pad: 10, dim: 0.15 });
        await h.zoom(new RegExp(`^${f.premium.replace(".", "\\.")} USDG$`), { scale: 1.8 });
        await h.cue(1, -0.5);
        await h.unbox();
        await h.unzoom(300);
        await h.scrollTo(/^Result at expiry/, { offset: 110, ms: 900 });
        await h.at(h.tl.lines[1].start + 0.6);
        await h.box(/^Breakeven \$372\.36$/, { pad: 8, dim: 0.12 });
        await h.zoom(/^Breakeven \$372\.36$/, { scale: 1.6 });
        // the Risk section: greeks and the ±30% stress test, read from the Stylus risk engine
        await h.cue(2, -0.6);
        await h.unbox();
        await h.unzoom(300);
        // any value: the engine re-reads the live spot, so check it still matches what the narration says
        const worst = /^Worst\s*[−-]\$[\d,]+\.\d\d$/;
        const shown = await h.page.evaluate(
          () => document.body.innerText.match(/Worst\s*[−-]\$([\d,]+\.\d\d)/)?.[1],
        );
        if (shown?.replace(/,/g, "") !== live.riskWorst)
          console.warn(
            `[video] WARNING: the risk panel now shows −$${shown}; the narration says −$${live.riskWorst}. Re-render.`,
          );
        await h.scrollTo(worst, { offset: 640, ms: 1100 });
        await h.cue(3, -0.3);
        await h.box(worst, { pad: 8, dim: 0.12 });
        await h.zoom(worst, { scale: 1.6 });
      },
    },
    {
      id: "agents",
      screen: `\`/app/agents\` leaderboard: zoom on agent #1's ERC-8004 #${f.identity} link, then on its ${f.bondAfter} USDG bond.`,
      tag: "Agents",
      lines: [
        L(
          `Agent one is ERC-8004 identity ${f.identity}: | one accepted, one rejected, and a ${f.bondAfter} USDG bond.`,
          `Agent one is E R C eighty oh four, identity ${f.identity === "114" ? "one-fourteen" : sayInt(f.identity)}: | one accepted, one rejected, and a ${sayInt(f.bondAfter)} ${U} bond.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/agents", () =>
          page
            .getByText(new RegExp(`ERC-8004 #${f.identity}`))
            .first()
            .waitFor({ timeout: 60_000 }),
        );
        const y = await page
          .getByText("Leaderboard")
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 140, 0), y);
      },
      async run(h) {
        await h.at(0.8);
        const row = h.page.getByRole("button", { name: /about agent 1$/ }).first();
        if ((await row.getAttribute("aria-expanded").catch(() => null)) === "false") await row.click();
        await h.at(0.6);
        const board = h.page.getByRole("region", { name: "Leaderboard" });
        await h.zoom(board.getByText(new RegExp(`ERC-8004 #${f.identity}`)).first(), { scale: 1.8 });
        await h.chunk(0, 1, -0.2);
        await h.zoom(board.getByText(new RegExp(`^${f.bondAfter} USDG$`)).first(), { scale: 1.6 });
      },
    },
    {
      id: "monitor",
      screen: `\`/app/monitor\`, live from Robinhood Chain mainnet: scroll to NVDA and zoom on its multiplier (${live.nvdaMultiplier}, read from the page at render time).`,
      tag: "Monitor",
      lines: [
        L("This monitor reads every stock token | on Robinhood Chain mainnet, live."),
        L(
          `Nvidia's multiplier, ${mult}, is already in the price, | so Strike never applies it twice.`,
          `Nvidia's multiplier, ${sayDec(mult).replace(/^one point zero zero zero /, "one point zero zero zero, ")}, is already in the price, | so Strike never applies it twice.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/monitor", () =>
          page.getByText("NVIDIA").first().waitFor({ timeout: 60_000 }),
        );
        const now = await nvdaMultiplier(page);
        if (Number(now).toFixed(6) !== mult)
          throw new Error(`NVDA multiplier changed: ${now} (narration says ${mult})`);
        const y = await page
          .getByText("TSLA", { exact: true })
          .first()
          .evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 300, 0), y);
      },
      async run(h) {
        await h.chunk(0, 1, 0.3);
        await h.scrollTo("NVIDIA", { offset: 380, ms: 1400 });
        await h.cue(1, -0.2);
        await h.zoom(new RegExp(`^${live.nvdaMultiplier.replace(".", "\\.")}$`), { scale: 1.8 });
      },
    },
    {
      id: "backtest",
      screen: `\`/app/backtest\`: zoom on the volatility figures, switch the stock to NVDA, zoom again.`,
      tag: "Backtest",
      lines: [
        L(
          `Over ${f.backtestWeeks} weekly epochs since 2019, | the covered call traded upside for ${f.volCut}% lower volatility.`,
          `Over ${sayInt(f.backtestWeeks)} weekly eepoks since twenty nineteen, | the covered call traded upside for ${f.volCut.split(" to ").map(sayInt).join(" to ")} percent lower volatility.`,
        ),
        L(
          `On Nvidia, from ${f.nvdaHeldVol}% down to ${f.nvdaCcVol}%.`,
          `On Nvidia, from ${sayDec(f.nvdaHeldVol)} percent, down to ${sayDec(f.nvdaCcVol)} percent.`,
        ),
      ],
      async prepare(page) {
        await openApp(page, "/app/backtest", () =>
          page.getByText(`${f.backtestWeeks} weeks`).first().waitFor({ timeout: 60_000 }),
        );
        await page.locator("#bt-equity-body svg").waitFor();
        const stock = page.getByRole("group", { name: "Stock" });
        const y = await stock.evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.__v.scrollTo(y - 110, 0), y);
      },
      async run(h) {
        const stock = h.page.getByRole("group", { name: "Stock" });
        await h.chunk(0, 1, -0.2);
        await h.zoom(h.page.locator('[data-metric="vol"]'), { scale: 1.5 });
        await h.cue(1, -1.1);
        await h.unzoom(250);
        await stock.getByRole("button", { name: "NVDA", exact: true }).click();
        await h.page.getByRole("region", { name: "Headline figures, NVDA" }).waitFor();
        const v = await h.page
          .locator('[data-metric="vol"]')
          .evaluate((el) => [...el.querySelectorAll("dd")].map((d) => d.textContent));
        if (!v[0].includes(`${f.nvdaCcVol}%`) || !v[1].includes(`${f.nvdaHeldVol}%`))
          throw new Error(`NVDA volatility on /app/backtest: ${JSON.stringify(v)}`);
        await h.at(h.tl.lines[1].start + 0.1);
        await h.zoom(h.page.locator('[data-metric="vol"]'), { scale: 1.6 });
      },
    },
    {
      id: "evidence",
      screen: `One card with five numbers from the README, each lit as it is said.`,
      tag: "Evidence",
      kind: "replay",
      replay: {
        mode: "evidence",
        kicker: "Evidence, not claims",
        title: "Each number links to a command in the README.",
        items: [
          { big: f.testsTotal, small: "tests and proofs" },
          { big: `${f.coverage}%`, small: "line coverage" },
          { big: f.halmos, small: "properties proven with Halmos" },
          { big: `${f.reviewFindings}/${f.reviewFindings}`, small: "internal-review findings fixed" },
          { big: `${f.stylusSolverX}×`, small: "less gas: the strike solver in Stylus" },
        ],
        source: "README.md · Evidence in numbers",
      },
      lines: [
        L(
          `${f.testsTotal} tests and proofs, | ${f.coverage}% line coverage, | ${sayInt(f.halmos)} properties proven with Halmos,`,
          `${sayInt(f.testsTotal)} tests and proofs, | ${sayDec(f.coverage)} percent line coverage, | ${sayInt(f.halmos)} properties proven with Halmos,`,
        ),
        L(
          `all ${f.reviewFindings} internal-review findings fixed, | and a Stylus strike solver that uses ${f.stylusSolverX} times less gas.`,
          `all ${sayInt(f.reviewFindings)} internal review findings fixed, | and a Stylus strike solver that uses ${sayDec(f.stylusSolverX)} times less gas.`,
        ),
      ],
      async run(h) {
        const focus = (i) => h.page.evaluate((i) => window.__ev.focus(i), i);
        await focus(0);
        await h.chunk(0, 1, -0.2);
        await focus(1);
        await h.chunk(0, 2, -0.2);
        await focus(2);
        await h.cue(1, -0.2);
        await focus(3);
        await h.chunk(1, 1, 0.3);
        await focus(4);
        await h.at(h.tl.lines[1].end + 0.2);
        await h.page.evaluate(() => window.__ev.all());
      },
    },
    {
      id: "close",
      screen: `The closing card: the line, **strike-options.vercel.app**, the repository and "Unaudited · testnet", then a few seconds of silence.`,
      tag: "Strike",
      kind: "replay",
      tail: 2.2,
      replay: {
        mode: "close",
        title: "Options on Robinhood Chain, run by agents the contract holds to a mandate.",
        app: "strike-options.vercel.app",
        repo: "github.com/Prashant-thakur77/Strike",
        badge: "Unaudited · testnet",
      },
      lines: [
        L("Strike: options on Robinhood Chain, | run by agents the contract holds to a mandate."),
        L(
          "Try the playground at strike-options.vercel.app. | It is unaudited, and on testnet.",
          "Try the playground at strike dash options dot vercel dot app. | It is unaudited, and on testnet.",
        ),
      ],
      async run(h) {
        await h.page.evaluate(() => window.__close.show(2));
        await h.cue(1, -0.3);
        await h.page.evaluate(() => window.__close.show(4));
        await h.chunk(1, 1, -0.3);
        await h.page.evaluate(() => window.__close.show(5));
      },
    },
  ];
}

/** Recorded once with a real signature (`--live-sign`), then replayed from video/clips on every render. */
function signingScene(f) {
  return {
    id: "signing",
    screen:
      '`/app/agents`, "Run your own agent": a test wallet connects, fills the form (50 USDG bond) and signs two transactions (register, then bond; the USDG allowance was set before the take) in a confirmation panel labelled as the test wallet; the app shows each pending and done state; then the bond transaction on the explorer.',
    tag: "Run an agent",
    kind: "clip",
    clip: "video/clips/signing.mp4",
    minDur: 33.5,
    lines: [
      L("Anyone can run an agent, with no permission."),
      L(
        "Here a test wallet registers an agent | and bonds 50 USDG, the minimum.",
        `Here a test wallet registers an agent | and bonds fifty ${U}, the minimum.`,
      ),
      L("The wallet signs each step: | register, then bond."),
      L(
        "Each one waits for its block on Robinhood Chain testnet.",
        "Each one waits for its block on Robinhood Chain testnet.",
        { pre: 1.6 },
      ),
      L(
        `Now it can propose. | Every rejected proposal costs it ${f.slash} USDG.`,
        `Now it can propose. | Every rejected proposal costs it ${sayInt(f.slash)} ${U}.`,
        { pre: 4.6 },
      ),
    ],
    context: signingContext,
    prepare: signingPrepare,
    run: signingRun,
  };
}

export const outputs = {
  silent: "strike-demo.mp4",
  narrated: "strike-demo-narrated.mp4",
  srt: "strike-demo.srt",
  poster: "strike-demo-poster.png",
  gif: "strike-demo.gif",
  transcript: "strike-demo-narration.txt",
};
export const poster = { scene: "vault", at: 2 };
export const timing = { lead: 0.2, gap: 0.3, tail: 0.3 };
export const crf = 24;

export const scriptDoc = {
  path: "docs/submission/demo-script.md",
  head: ({ total, words, wpm, mmss }) => `# Demo video script (${mmss(total)})

The narration of [docs/media/strike-demo-narrated.mp4](../media/strike-demo-narrated.mp4) (${total.toFixed(1)} s, 1920×1080), and the captions of the silent cut [strike-demo.mp4](../media/strike-demo.mp4). Both are rendered by \`node video/record.mjs demo\` from the scene list in [video/demo.mjs](../../video/demo.mjs), and this file is written by the same run, so the times and words below are the video's own. The captions show the spoken words (two lines of at most about 42 characters); the timed captions are in [strike-demo.srt](../media/strike-demo.srt).

The voice is Chatterbox TTS (open source, Resemble AI) with a synthetic reference voice, ${words} words in ${total.toFixed(0)} s (${wpm} words a minute, numbers counted as one word). Every number is read from README.md at render time; the NVDA multiplier is read from the live monitor. Nothing here is audited: the close says so.`,
};
