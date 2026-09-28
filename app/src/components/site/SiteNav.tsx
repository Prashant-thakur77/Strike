"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowRight } from "lucide-react";
import { MobileMenu, type NavItem } from "./MobileMenu";
import { Wordmark } from "./Wordmark";
import styles from "./site.module.css";

const ITEMS: NavItem[] = [
  { href: "/#how", label: "How it works" },
  { href: "/#agents", label: "Agents" },
  { href: "/#safety", label: "Safety" },
];

/** Landing nav: fixed, transparent, difference-blended so it reads on paper, ink and colour alike. */
export function SiteNav() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <header className={styles.nav}>
        <Link href="/" aria-label="Strike home" className={styles.logo}>
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className={styles.links}>
          {ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={styles.navLink}>
              {item.label}
            </Link>
          ))}
          <Link href="/app" className={styles.navPill}>
            Open app <ArrowRight aria-hidden />
          </Link>
        </nav>
        <button
          type="button"
          className={`micro ${styles.menuBtn} ${styles.menuToggle}`}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen(true)}
        >
          Menu
        </button>
      </header>
      <MobileMenu open={open} onClose={close} items={[...ITEMS, { href: "/app", label: "Open app" }]} />
    </>
  );
}
