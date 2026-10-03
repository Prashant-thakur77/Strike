/** The app's pages in the order a first-time visitor should walk them: what each page is for (one plain sentence,
 *  shown under every page title) and where to go next (the "Next:" link at the bottom of every page). */

export interface TourPage {
  href: string;
  label: string;
  /** What the page is for, in one plain sentence. */
  purpose: string;
  /** The "Next:" link at the bottom of the page. */
  next: { href: string; label: string; why: string };
}

export const TOUR: TourPage[] = [
  {
    href: "/app",
    label: "Vaults",
    purpose: "Pick a vault to see this week's option and what depositors earn from it.",
    next: {
      href: "/app/playground",
      label: "Try the playground",
      why: "See how the contract judges an agent's proposal, no wallet needed.",
    },
  },
  {
    href: "/app/vault",
    label: "Vault",
    purpose:
      "One vault up close: this week's option, what you'd earn, the risk, and the rules it can't break.",
    next: {
      href: "/app/playground",
      label: "Try the playground",
      why: "Propose a strike for this vault and see what the contract says.",
    },
  },
  {
    href: "/app/playground",
    label: "Playground",
    purpose: "Test a proposal against a live vault's rules and see what the contract would do.",
    next: {
      href: "/app/backtest",
      label: "See the backtest",
      why: "What these vaults would have earned since 2019.",
    },
  },
  {
    href: "/app/backtest",
    label: "Backtest",
    purpose: "See how these vaults would have done since 2019 before trusting them with anything.",
    next: {
      href: "/app/agents",
      label: "Watch the agents",
      why: "Who picks the strikes, their record and every rejection.",
    },
  },
  {
    href: "/app/agents",
    label: "Agents",
    purpose: "See who picks each week's strike, how often the contract said no, and what it cost them.",
    next: {
      href: "/app/monitor",
      label: "Open the monitor",
      why: "The live price checks every settlement depends on.",
    },
  },
  {
    href: "/app/monitor",
    label: "Monitor",
    purpose: "Check that the stock prices Strike settles on are safe to use, right now.",
    next: {
      href: "/app/proof",
      label: "Check the proof",
      why: "Every claim next to the contract, test or transaction behind it.",
    },
  },
  {
    href: "/app/proof",
    label: "Proof",
    purpose: "Check every claim yourself: each one links to the contract, test or transaction behind it.",
    next: {
      href: "/app/faucet",
      label: "Get test tokens",
      why: "Gas, USDG and a stock token to try a deposit yourself.",
    },
  },
  {
    href: "/app/faucet",
    label: "Faucet",
    purpose: "Get free test tokens so you can try a deposit or a buy yourself.",
    next: {
      href: "/app",
      label: "Back to the vaults",
      why: "Deposit your test tokens and earn this week's premium.",
    },
  },
  {
    href: "/app/glossary",
    label: "Glossary",
    purpose: "Every options and protocol term used in the app, in one plain sentence each.",
    next: { href: "/app", label: "Back to the vaults", why: "See the terms at work in a live vault." },
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    purpose:
      "See everything your wallet holds across the vaults: shares, premium to claim, requests and options.",
    next: { href: "/app", label: "Back to the vaults", why: "Deposit, or claim what is waiting for you." },
  },
  {
    href: "/app/lessons",
    label: "Lessons",
    purpose: "See what went wrong in the live runs, the evidence for it, and what changed because of it.",
    next: {
      href: "/app/proof",
      label: "Check the proof",
      why: "Every claim next to the contract, test or transaction behind it.",
    },
  },
  {
    href: "/app/governance",
    label: "Governance",
    purpose:
      "See who holds every admin key on Strike's contracts, what each key can do, and how that power shrinks before mainnet.",
    next: {
      href: "/app/proof",
      label: "Check the proof",
      why: "Every claim next to the contract, test or transaction behind it.",
    },
  },
];

/** The tour entry for a pathname (vault pages share one entry). */
export function tourPage(pathname: string): TourPage | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/app/vault/")) return TOUR.find((p) => p.href === "/app/vault") ?? null;
  return TOUR.find((p) => p.href === path) ?? null;
}

/** The "start here" path on the landing page and the vaults page. */
export const START_HERE = [
  { href: "/app", label: "See a vault", note: "What you deposit and what it pays" },
  { href: "/app/playground", label: "Try the playground", note: "Test a proposal, no wallet" },
  { href: "/app/agents", label: "Watch an agent's record", note: "Every strike it picked or got wrong" },
  { href: "/app/proof", label: "Check the proof", note: "Contracts, tests and transactions" },
] as const;
