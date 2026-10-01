import type { ReactNode } from "react";
import { EligibilityGate } from "@/components/app/EligibilityGate";
import { NextStep } from "@/components/app/NextStep";
import { AppNav } from "@/components/site/AppNav";
import { Footer } from "@/components/site/Footer";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="theme-paper">
      <AppNav />
      {/* At least a screen tall, so the footer never sits in the first viewport while data loads and then jumps. */}
      <main id="main" style={{ minHeight: "calc(100svh - var(--banner-h))" }}>
        {children}
      </main>
      <NextStep />
      <div style={{ paddingTop: "clamp(64px, 8vw, 120px)" }}>
        <Footer />
      </div>
      <EligibilityGate />
    </div>
  );
}
