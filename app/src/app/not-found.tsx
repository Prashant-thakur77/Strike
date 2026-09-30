import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import { SiteNav } from "@/components/site/SiteNav";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <SiteNav />
      <main
        id="main"
        className="theme-paper gutter"
        style={{
          minHeight: "calc(100svh - var(--banner-h))",
          display: "grid",
          alignContent: "center",
          gap: 32,
          paddingTop: "var(--nav-h)",
        }}
      >
        <span className="micro">Error 404</span>
        <h1 className="display-h1">Out of the money.</h1>
        <p className="lead">This page doesn&apos;t exist, or it expired worthless.</p>
        <Link href="/" className="pill" style={{ justifySelf: "start" }}>
          Back home <ArrowRight aria-hidden />
        </Link>
      </main>
    </>
  );
}
