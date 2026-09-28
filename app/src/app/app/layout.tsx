import type { ReactNode } from "react";
import { AppNav } from "@/components/site/AppNav";
import { Footer } from "@/components/site/Footer";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="theme-paper">
      <AppNav />
      <main id="main">{children}</main>
      <div style={{ paddingTop: "clamp(64px, 8vw, 120px)" }}>
        <Footer />
      </div>
    </div>
  );
}
