"use client";

import { ArrowUpRight } from "lucide-react";
import { useStrike } from "@/hooks/useStrike";
import { explorerUrl } from "@/lib/chains";
import { shortAddr } from "@/lib/format";

export function AddressLink({ address, className }: { address: string; className?: string }) {
  const { chainId } = useStrike();
  const url = explorerUrl(chainId, "address", address);
  if (!url) {
    return (
      <span className={`mono ${className ?? ""}`} title={address}>
        {shortAddr(address)}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`mono text-link ${className ?? ""}`}
      title={address}
    >
      {shortAddr(address)} <ArrowUpRight size={12} aria-hidden />
    </a>
  );
}
