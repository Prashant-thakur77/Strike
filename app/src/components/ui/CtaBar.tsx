import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import styles from "./ui.module.css";

interface CtaBarProps {
  href: string;
  label: string;
  text: string;
}

/** Full-width outline pill: micro label, big text, a circular arrow. An ink fill wipes in from the left on hover. */
export function CtaBar({ href, label, text }: CtaBarProps) {
  return (
    <Link href={href} className={styles.cta}>
      <span className={styles.ctaText}>
        <span className="micro">{label}</span>
        <span className={styles.ctaBig}>{text}</span>
      </span>
      <span className={styles.ctaCircle} aria-hidden>
        <ArrowUpRight strokeWidth={1.25} />
      </span>
    </Link>
  );
}
