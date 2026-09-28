import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { VaultDetail } from "@/components/app/vault/VaultDetail";

export const metadata: Metadata = { title: "Vault" };

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isAddress(address, { strict: false })) notFound();
  return <VaultDetail address={getAddress(address)} />;
}
