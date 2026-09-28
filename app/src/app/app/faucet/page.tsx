import type { Metadata } from "next";
import { FaucetPage } from "@/components/app/faucet/FaucetPage";

export const metadata: Metadata = { title: "Faucet" };

export default function Page() {
  return <FaucetPage />;
}
