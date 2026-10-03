/** The app's navigation: five top-level places, two of them groups. SDK-free, so the Playwright specs can import it.
 *  Every route stays reachable: pages that are not top level sit in a group, with one plain line saying what each
 *  is for. */

import strikeConfig from "../../../strike.config.json";
import { TOUR } from "./tour";

const REPO = strikeConfig.services.repository;

export interface NavLink {
  href: string;
  label: string;
  /** One plain line under the label in a group's menu. */
  note?: string;
  /** Opens a document outside the app (GitHub). */
  external?: boolean;
}

export interface NavGroup {
  /** Stable id for aria-controls. */
  id: string;
  label: string;
  links: NavLink[];
}

export type NavEntry = NavLink | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => "links" in e;

/** A page joins the nav only once its route exists (the governance page lands from another branch). */
const inTour = (href: string) => TOUR.some((p) => p.href === href);

export const NAV: NavEntry[] = [
  { href: "/app", label: "Vaults" },
  { href: "/app/portfolio", label: "Portfolio" },
  { href: "/app/agents", label: "Agents" },
  {
    id: "nav-proof",
    label: "Proof",
    links: [
      {
        href: "/app/proof",
        label: "Proof",
        note: "Every claim, linked to its contract, test or transaction",
      },
      { href: "/app/monitor", label: "Price monitor", note: "The live price checks settlement depends on" },
      { href: "/app/lessons", label: "Lessons", note: "What went wrong in the live runs, and what changed" },
      ...(inTour("/app/governance")
        ? [
            {
              href: "/app/governance",
              label: "Governance",
              note: "Who holds each admin key, and what it can do",
            },
          ]
        : []),
      {
        href: `${REPO}/blob/main/docs/design/pendle-collateral.md`,
        label: "Pendle collateral design",
        note: "Idle put collateral earning yield: a tested prototype, not deployed",
        external: true,
      },
      {
        href: `${REPO}/blob/main/docs/ENDPOINTS.md#paid-route-x402`,
        label: "Agent API (x402)",
        note: "A paid risk report that AI agents buy per call",
        external: true,
      },
    ],
  },
  {
    id: "nav-learn",
    label: "Learn",
    links: [
      { href: "/app/playground", label: "Playground", note: "Test the contract's rules, no wallet needed" },
      { href: "/app/backtest", label: "Backtest", note: "What these vaults would have earned since 2019" },
      { href: "/app/glossary", label: "Glossary", note: "Every options term in one plain sentence" },
      { href: "/app/faucet", label: "Get started", note: "Connect, free gas and test USDG, then a vault" },
      { href: "/waitlist", label: "Mainnet waitlist", note: "Hear when Strike opens on mainnet" },
    ],
  },
];

/** The phone's bottom bar: the four places used most, then "More" for the rest. */
export const TABS: NavLink[] = [
  { href: "/app", label: "Vaults" },
  { href: "/app/portfolio", label: "Portfolio" },
  { href: "/app/agents", label: "Agents" },
  { href: "/app/proof", label: "Proof" },
];

/** Is `href` the page at `pathname`? Vault pages count as Vaults; decision pages as Agents. */
export function isCurrent(pathname: string, href: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (href.startsWith("http") || href.startsWith("#") || href.startsWith("/#")) return false;
  if (href === "/app") return path === "/app" || path.startsWith("/app/vault");
  if (href === "/app/agents") return path.startsWith("/app/agents") || path.startsWith("/app/decision");
  return href !== "/" && (path === href || path.startsWith(`${href}/`));
}

/** Does a group hold the current page? */
export function groupIsCurrent(pathname: string, g: NavGroup): boolean {
  return g.links.some((l) => isCurrent(pathname, l.href));
}

/** Every in-app route the nav reaches (for the specs). */
export function navRoutes(): string[] {
  return NAV.flatMap((e) => (isGroup(e) ? e.links : [e]))
    .filter((l) => !l.external)
    .map((l) => l.href);
}
