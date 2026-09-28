"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/links";
import { Wordmark } from "./Wordmark";
import styles from "./site.module.css";

export interface NavItem {
  href: string;
  label: string;
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    first.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <div
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
      <nav aria-label="Mobile" className={styles.menuLinks}>
        {items.map((item, i) => (
          <Link
            key={item.href}
            ref={i === 0 ? first : undefined}
            href={item.href}
            onClick={onClose}
            className={styles.menuLink}
            style={{ ["--i" as string]: i }}
          >
            <span className="index">{String(i + 1).padStart(2, "0")}</span>
            {item.label}
          </Link>
        ))}
      </nav>
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
