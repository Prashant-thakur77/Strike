"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { ChainSwitcher } from "./ChainSwitcher";
import { ConnectButton } from "./ConnectButton";
import { MobileMenu, type NavItem } from "./MobileMenu";
import { Wordmark } from "./Wordmark";
import styles from "./site.module.css";

const ITEMS: NavItem[] = [
  { href: "/app", label: "Vaults" },
  { href: "/app/agents", label: "Agents" },
  { href: "/app/faucet", label: "Faucet" },
];

function isActive(pathname: string, href: string) {
  return href === "/app"
    ? pathname === "/app" || pathname.startsWith("/app/vault")
    : pathname.startsWith(href);
}

/** App nav: solid paper with a hairline (data scrolls beneath it), network and wallet on the right. */
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
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={styles.appLink}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
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
      <MobileMenu open={open} onClose={close} items={ITEMS}>
        <ConnectButton block />
      </MobileMenu>
    </>
  );
}
