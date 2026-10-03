"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/links";
import { isCurrent } from "@/lib/nav";
import { Wordmark } from "./Wordmark";
import styles from "./site.module.css";

export interface NavItem {
  href: string;
  label: string;
  /** Items with a group are listed under its name, after the ungrouped ones. */
  group?: string;
  /** A document outside the app: opens in a new tab. */
  external?: boolean;
}

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  items: NavItem[];
  children?: ReactNode;
}

/** Full-screen ink overlay with display-size links. Escape or any link closes it. */
export function MobileMenu({ open, onClose, items, children }: MobileMenuProps) {
  const first = useRef<HTMLAnchorElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pathname = usePathname() ?? "";

  // Navigating (a link, or back/forward) closes the menu.
  const shownAt = useRef(pathname);
  useEffect(() => {
    if (open && pathname !== shownAt.current) onClose();
    shownAt.current = pathname;
  }, [pathname, open, onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // A modal dialog: Tab cycles inside the menu until it closes.
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = [
        ...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), select, input"),
      ].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    first.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // Back to the Menu button that opened it.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, onClose]);

  return (
    <div
      ref={panel}
      id="mobile-menu"
      className={`theme-ink ${styles.menu}`}
      data-open={open}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      hidden={!open}
    >
      <div className={styles.menuTop}>
        <Link href="/" onClick={onClose} aria-label="Strike home">
          <Wordmark />
        </Link>
        <button type="button" className={`micro ${styles.menuBtn}`} onClick={onClose}>
          Close
        </button>
      </div>
      {items.some((i) => i.group) ? (
        <GroupedLinks items={items} pathname={pathname} onClose={onClose} first={first} />
      ) : (
        <nav aria-label="Mobile" className={styles.menuLinks}>
          {items.map((item, i) => (
            <Link
              key={item.href}
              ref={i === 0 ? first : undefined}
              href={item.href}
              onClick={onClose}
              className={styles.menuLink}
              aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
              style={{ ["--i" as string]: i }}
            >
              <span className="index">{String(i + 1).padStart(2, "0")}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      {children ? <div className={styles.menuExtra}>{children}</div> : null}
      <div className={styles.menuFoot}>
        <span className="rule" />
        <a className="micro" href={LINKS.github} target="_blank" rel="noreferrer">
          GitHub <ArrowUpRight size={12} style={{ display: "inline" }} />
        </a>
      </div>
    </div>
  );
}

/** The app menu: the main places large, then each group's pages under its name, smaller. */
function GroupedLinks({
  items,
  pathname,
  onClose,
  first,
}: {
  items: NavItem[];
  pathname: string;
  onClose: () => void;
  first: React.RefObject<HTMLAnchorElement | null>;
}) {
  const top = items.filter((i) => !i.group);
  const groups = [...new Set(items.filter((i) => i.group).map((i) => i.group!))];
  return (
    <nav aria-label="Mobile" className={styles.menuGrouped}>
      <div className={styles.menuLinks}>
        {top.map((item, i) => (
          <Link
            key={item.href}
            ref={i === 0 ? first : undefined}
            href={item.href}
            onClick={onClose}
            className={styles.menuLink}
            aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
            style={{ ["--i" as string]: i }}
          >
            <span className="index">{String(i + 1).padStart(2, "0")}</span>
            {item.label}
          </Link>
        ))}
      </div>
      <div className={styles.menuGroups}>
        {groups.map((g) => (
          <section key={g} className={styles.menuGroup} aria-label={g}>
            <h2 className="micro micro-muted">{g}</h2>
            <ul>
              {items
                .filter((i) => i.group === g)
                .map((item) => (
                  <li key={item.href}>
                    {item.external ? (
                      <a href={item.href} target="_blank" rel="noreferrer" className={styles.menuSubLink}>
                        {item.label} <ArrowUpRight size={14} aria-hidden style={{ display: "inline" }} />
                      </a>
                    ) : (
                      <Link
                        href={item.href}
                        onClick={onClose}
                        className={styles.menuSubLink}
                        aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                      >
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
