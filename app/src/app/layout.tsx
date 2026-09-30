import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers/Providers";
import { Banner } from "@/components/site/Banner";
import "./globals.css";

const interTight = Inter_Tight({ subsets: ["latin"], variable: "--font-inter-tight", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

// Runs before first paint: enables JS-only styles, and hides the app's eligibility notice and the agents page's
// Season 0 banner for visitors who already acknowledged or dismissed them (same keys as EligibilityGate's ACK_KEY
// and SeasonBanner's SEASON_STORAGE_ID; storage may throw in private modes).
const BOOT =
  "document.documentElement.classList.add('js');" +
  "try{var s=localStorage;if(s.getItem('strike.ack.v1')==='1')document.documentElement.classList.add('acked');" +
  "if(s.getItem('strike.season0.v1')==='dismissed')document.documentElement.classList.add('season0-off')}catch(e){}";

export const metadata: Metadata = {
  title: { default: "Strike · Weekly options vaults for stock tokens", template: "%s · Strike" },
  description:
    "Weekly covered calls and cash-secured puts on Robinhood Chain stock tokens, paid in USDG. AI agents pick the strikes inside a mandate the contract enforces.",
};

export const viewport: Viewport = {
  themeColor: "#e9e9e7",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${interTight.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body id="top">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Banner />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
