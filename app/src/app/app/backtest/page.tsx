import type { Metadata } from "next";
import { BacktestPage } from "@/components/app/backtest/BacktestPage";

export const metadata: Metadata = {
  title: "Backtest",
  description:
    "403 weeks of Strike's weekly covered-call and cash-secured-put vaults on TSLA, NVDA, AMZN and SPY, 2019–2026, against buy-and-hold: equity curves, premium, stress periods, delta sensitivity and the caveats.",
};

export default function Page() {
  return <BacktestPage />;
}
