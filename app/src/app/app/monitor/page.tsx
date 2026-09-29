import type { Metadata } from "next";
import { MonitorPage } from "@/components/app/monitor/MonitorPage";

export const metadata: Metadata = {
  title: "Monitor",
  description:
    "Live safety checks for Robinhood Chain stock tokens: ERC-8056 multipliers, pause flags, Chainlink prices and the SafeStockFeed verdict.",
};

export default function Page() {
  return <MonitorPage />;
}
