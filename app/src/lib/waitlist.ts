// The mainnet waitlist page, /waitlist (D46). Sign-up is the form on the page (components/waitlist/WaitlistForm.tsx),
// which POSTs to /api/waitlist; each entry is encrypted with the team's public key and kept in a private Vercel Blob
// store (lib/waitlistServer.ts). The testnet figures come from docs/evidence/facts.json, which
// scripts/check-numbers.mjs measures, so they change with it.
//
// Data only (no SDK import), so the Playwright specs can load it as CommonJS.
import strikeConfig from "../../../strike.config.json";
import facts from "../../../docs/evidence/facts.json";

const REPO = strikeConfig.services.repository;

export const TELEGRAM_BOT = strikeConfig.services.telegramBot;

/** The bot's @name, for the privacy notice ("message @strike_options_bot"). */
export const TELEGRAM_BOT_HANDLE = `@${TELEGRAM_BOT.replace(/^https:\/\/t\.me\//, "").replace(/\/.*$/, "")}`;

/** The privacy notice next to the form: what is stored, who can read it, how long, and how to be removed. */
export const PRIVACY = [
  {
    term: "What we store",
    text: "Your email, the interests you pick, and the optional name, Telegram handle, wallet address and note, with the two confirmations and the time you signed up. Nothing else is stored with it: not your IP address (the rate limit keeps a keyed hash of it in server memory for up to 10 minutes) and no cookies.",
  },
  {
    term: "Why",
    text: "Only to contact you about Strike's mainnet launch: when the audit report is out and when the first vault opens.",
  },
  {
    term: "Who can read it",
    text: "Only the Strike team. Each entry is encrypted on our server before it is stored, with a key whose private half the team holds outside the app; the app itself can write entries but cannot read them back. The store is private, and the file name is a keyed hash, not your email.",
  },
  {
    term: "How long",
    text: "Until the mainnet launch plus 12 months, then deleted.",
  },
  {
    term: "Removal",
    text: `Reply to any message we send you, or message ${TELEGRAM_BOT_HANDLE} on Telegram, and we delete your entry. No reason needed.`,
  },
] as const;

const chains = new Set(Object.keys(facts.deployments).map((k) => k.split("-")[0]));

/** Testnet evidence, read from facts.json at build time. */
export const EVIDENCE = [
  {
    value: String(chains.size),
    label: "Testnets live",
    detail: "Robinhood Chain testnet and Arbitrum Sepolia",
  },
  {
    value: facts.totals.testsAndProofs.toLocaleString("en-US"),
    label: "Tests and proofs",
    detail: "Foundry, fork, differential, Halmos, Rust, TypeScript, subgraph and Playwright",
  },
  {
    value: `${facts.coverage.lines}%`,
    label: "Line coverage",
    detail: `of the contracts, ${facts.coverage.branches}% of branches`,
  },
  {
    value: String(facts.threats),
    label: "Threats modelled",
    detail: "each with its mitigation and a test",
  },
] as const;

export const FACTS_SOURCE = "docs/evidence/facts.json";
export const FACTS_DATE = facts.measured.date;

export type StageStatus = "done" | "next" | "later";

export interface Stage {
  status: StageStatus;
  title: string;
  text: string;
  link: { href: string; label: string };
}

/** What launches first, in order. Statuses are what is true today; there are no dates because none are fixed. */
export const STAGES: readonly Stage[] = [
  {
    status: "done",
    title: "Live on two testnets",
    text: "Weekly vaults run on Robinhood Chain testnet (v2 and v3) and Arbitrum Sepolia (v3), every contract verified, with live epochs, proposals, a rejected proposal's slash and decision records anchored on-chain.",
    link: { href: "/app/proof", label: "See the proof" },
  },
  {
    status: "done",
    title: "Mainnet admin: a Safe behind a 73\u2011day timelock",
    text: "The mainnet deploy path hands every admin role to a timelock only a Safe can use, so a feed, oracle or pricer change is public for 73 days and cannot land inside a running epoch. Written and tested, simulated on a read-only mainnet fork; not deployed yet.",
    link: {
      href: `${REPO}/blob/main/docs/trust-model.md#staged-path-for-the-admin-keys`,
      label: "Trust model, stage 1",
    },
  },
  {
    status: "next",
    title: "Eight settled weeks on both testnets",
    text: "The keeper and the weekly agent run on their schedule on both chains, and each week is opened, proposed, sold, settled and redeemed, with a public log.",
    link: {
      href: `${REPO}/blob/main/docs/MILESTONES.md#2-eight-settled-weeks-on-both-testnets-weeks-19-4000`,
      label: "Milestone 2",
    },
  },
  {
    status: "next",
    title: "External audit",
    text: "Not started. The scope and the auditor's starting points are written: the v3 contracts and the Stylus program. Every High and Medium finding gets a fix and a regression test, and the report is published.",
    link: { href: `${REPO}/blob/main/docs/audit-readiness.md`, label: "Audit readiness" },
  },
  {
    status: "later",
    title: "One capped vault on Robinhood Chain mainnet",
    text: "After the audit: one TSLA covered-call vault with a deposit cap agreed in advance, the admin roles in the Safe, and the real Chainlink feeds read directly, with no MirrorFeed. The mainnet configuration is in the deploy script and has never been run.",
    link: {
      href: `${REPO}/blob/main/docs/MILESTONES.md#3-external-audit-then-a-capped-mainnet-vault-weeks-618-17000`,
      label: "Milestone 3",
    },
  },
];

export const STATUS_LABEL: Record<StageStatus, string> = { done: "Done", next: "Next", later: "Later" };

export const BENEFITS = [
  {
    title: "Early access to the capped vault",
    text: "The first mainnet vault has a deposit cap, so it holds a limited amount. People on the list hear before it is announced anywhere else.",
  },
  {
    title: "Launch contact",
    text: "A message when the audit report is out and when the vault opens. Nothing else, and your details are not shared.",
  },
  {
    title: "An invitation to run an agent",
    text: "Agents post a USDG bond and propose each week's strike inside the vault's mandate. If you build one, you are invited to run it when outside agents open on mainnet.",
  },
] as const;

export const TRY_TODAY = [
  {
    href: "/app/playground",
    name: "Playground",
    text: "Test a proposal against a live vault's rules, or run the agent in your browser.",
  },
  {
    href: "/app/faucet",
    name: "Faucet",
    text: "Free test tokens, so you can try a deposit or a buy yourself.",
  },
  {
    href: "/app",
    name: "Vaults",
    text: "Pick a vault to see this week's option and what depositors earn from it.",
  },
  {
    href: "/app/decision/46630/2026-10-02-sTSLA-CSP-A2",
    name: "A decision",
    text: "Why an agent chose its strike: the mandate check, the strikes it passed over, the risk.",
  },
  { href: "/app/lessons", name: "Lessons", text: "What went wrong in the live runs, and what changed." },
] as const;

/** The site footer's eligibility sentence, word for word. */
export const ELIGIBILITY =
  "Robinhood stock tokens are offered only to non-US persons, and Strike is not available to anyone in the United States.";
