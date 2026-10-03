import type { Metadata } from "next";
import { PortfolioPage } from "@/components/app/portfolio/PortfolioPage";

export const metadata: Metadata = { title: "Portfolio" };

export default function Page() {
  return <PortfolioPage />;
}
