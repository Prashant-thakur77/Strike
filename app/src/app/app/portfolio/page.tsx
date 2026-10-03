import type { Metadata } from "next";
import { Suspense } from "react";
import { PortfolioPage } from "@/components/app/portfolio/PortfolioPage";

export const metadata: Metadata = { title: "Portfolio" };

export default function Page() {
  // The page reads ?address= (a wallet to view read-only), so it renders inside a Suspense boundary.
  return (
    <Suspense>
      <PortfolioPage />
    </Suspense>
  );
}
