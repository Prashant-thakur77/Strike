"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { tourPage } from "@/lib/tour";
import styles from "./app.module.css";

/** "Next:" at the bottom of every app page: the logical next page, so a visitor can walk the app in order. */
export function NextStep() {
  const page = tourPage(usePathname() ?? "");
  if (!page) return null;
  const { next } = page;
  return (
    <nav className={`gutter ${styles.nextStep}`} aria-label="Next page">
      <Link href={next.href} className={styles.nextLink} data-testid="next-step">
        <span className="micro micro-muted">Next</span>
        <span className={styles.nextLabel}>
          {next.label} <ArrowRight aria-hidden />
        </span>
        <span className={styles.nextWhy}>{next.why}</span>
      </Link>
    </nav>
  );
}
