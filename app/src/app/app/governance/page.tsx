import type { Metadata } from "next";
import { GovernancePage } from "@/components/app/governance/GovernancePage";

export const metadata: Metadata = {
  title: "Governance",
  description:
    "Who holds each admin role on every Strike contract, read live from Robinhood Chain testnet and Arbitrum Sepolia: what each role can and cannot do, the last admin actions with their transactions, and the staged path to a timelocked Safe on mainnet.",
};

export default function Page() {
  return <GovernancePage />;
}
