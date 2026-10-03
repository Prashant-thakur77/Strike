"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BadgeCheck, Bot, ChevronDown, Ellipsis, Layers, Wallet } from "lucide-react";
import { NAV, TABS, groupIsCurrent, isCurrent, isGroup, type NavGroup } from "@/lib/nav";
import { ChainSwitcher } from "./ChainSwitcher";
import { ConnectButton } from "./ConnectButton";
import { MobileMenu, type NavItem } from "./MobileMenu";
import { Wordmark } from "./Wordmark";
import styles from "./site.module.css";

/** The menu's items: top-level pages first, then each group's pages under its name. */
const MENU_ITEMS: NavItem[] = NAV.flatMap((e) =>
  isGroup(e)
    ? e.links.map((l) => ({ href: l.href, label: l.label, group: e.label, external: l.external }))
    : [{ href: e.href, label: e.label }],
);

const TAB_ICONS: Record<string, typeof Layers> = {
  "/app": Layers,
  "/app/portfolio": Wallet,
  "/app/agents": Bot,
  "/app/proof": BadgeCheck,
};

/** A nav group: a button that opens a short list of pages, each with one line on what it is for. */
function NavMenu({ group, pathname }: { group: NavGroup; pathname: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const current = groupIsCurrent(pathname, group);

  // Navigating closes it.
  const shownAt = useRef(pathname);
  useEffect(() => {
    if (pathname !== shownAt.current) setOpen(false);
    shownAt.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    // Focus leaving the group (Tab past its last link) closes it.
    const onFocus = (e: FocusEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  return (
    <div className={styles.navGroup} ref={root}>
      <button
        ref={button}
        type="button"
        className={styles.appLink}
        aria-expanded={open}
        aria-controls={group.id}
        data-current={current || undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {group.label} <ChevronDown size={13} aria-hidden className={styles.navChevron} />
      </button>
      <ul id={group.id} className={`theme-paper ${styles.navPanel}`} hidden={!open} aria-label={group.label}>
        {group.links.map((l) => (
          <li key={l.href}>
            {l.external ? (
              <a href={l.href} className={styles.navPanelLink} target="_blank" rel="noreferrer">
                <span className={styles.navPanelLabel}>
                  {l.label} <ArrowUpRight size={13} aria-hidden />
                </span>
                {l.note ? <span className={styles.navPanelNote}>{l.note}</span> : null}
              </a>
            ) : (
              <Link
                href={l.href}
                className={styles.navPanelLink}
                aria-current={isCurrent(pathname, l.href) ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span className={styles.navPanelLabel}>{l.label}</span>
                {l.note ? <span className={styles.navPanelNote}>{l.note}</span> : null}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** App nav: five places (two of them short menus), network and wallet on the right; on phones a bottom tab bar. */
export function AppNav() {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <header className={`theme-paper ${styles.appNav}`}>
        <Link href="/" aria-label="Strike home" className={styles.logo}>
          <Wordmark />
        </Link>
        <nav aria-label="App" className={styles.appLinks}>
          {NAV.map((e) =>
            isGroup(e) ? (
              <NavMenu key={e.id} group={e} pathname={pathname} />
            ) : (
              <Link
                key={e.href}
                href={e.href}
                className={styles.appLink}
                aria-current={isCurrent(pathname, e.href) ? "page" : undefined}
              >
                {e.label}
              </Link>
            ),
          )}
        </nav>
        <div className={styles.appRight}>
          <ChainSwitcher />
          <span className={styles.desktopOnly}>
            <ConnectButton />
          </span>
          <button
            type="button"
            className={`micro ${styles.menuBtn} ${styles.menuToggle}`}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen(true)}
          >
            Menu
          </button>
        </div>
      </header>
      <nav aria-label="Tabs" className={`theme-paper ${styles.tabBar}`} data-testid="tab-bar">
        {TABS.map((t) => {
          const Icon = TAB_ICONS[t.href] ?? Layers;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={styles.tab}
              aria-current={isCurrent(pathname, t.href) ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.6} aria-hidden />
              <span>{t.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={styles.tab}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label="More pages"
          onClick={() => setOpen(true)}
        >
          <Ellipsis size={20} strokeWidth={1.6} aria-hidden />
          <span aria-hidden>More</span>
        </button>
      </nav>
      <MobileMenu open={open} onClose={close} items={MENU_ITEMS}>
        <div className={styles.menuField}>
          <span className="micro micro-muted" aria-hidden>
            Network
          </span>
          <ChainSwitcher block />
        </div>
        <div className={styles.menuField}>
          <span className="micro micro-muted" aria-hidden>
            Wallet
          </span>
          <ConnectButton block />
        </div>
      </MobileMenu>
    </>
  );
}
