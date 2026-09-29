import type { Metadata } from "next";
import { ProofPage } from "@/components/app/proof/ProofPage";

export const metadata: Metadata = {
  title: "Proof",
  description:
    "Every Strike claim with its evidence: verified contracts on Robinhood Chain testnet, the Stylus pricer, gas, tests, coverage, invariants, the security review and live on-chain activity.",
};

export default function Page() {
  return <ProofPage />;
}
