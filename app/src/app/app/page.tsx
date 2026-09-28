import type { Metadata } from "next";
import { VaultsPage } from "@/components/app/VaultList";

export const metadata: Metadata = { title: "Vaults" };

export default function Page() {
  return <VaultsPage />;
}
