import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPage } from "@/components/app/decision/DecisionPage";
import { DECISION_CHAINS, isRecordName } from "@/lib/decision";

type Params = Promise<{ chain: string; record: string }>;
type Search = Promise<{ dry?: string | string[] }>;

function parse(chain: string, record: string): { chainId: number; name: string } | null {
  const chainId = Number(chain);
  let name: string;
  try {
    name = decodeURIComponent(record);
  } catch {
    return null;
  }
  if (!/^\d+$/.test(chain) || !DECISION_CHAINS[chainId] || !isRecordName(name)) return null;
  return { chainId, name };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chain, record } = await params;
  const p = parse(chain, record);
  if (!p) return { title: "Decision" };
  return {
    title: `Decision ${p.name}`,
    description: `Why the agent chose this strike and not the others: the mandate check with headroom, the strike ladder recomputed from the anchored inputs, the break-even, and the record's on-chain hash check (${p.name}, chain ${p.chainId}).`,
  };
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { chain, record } = await params;
  const { dry } = await searchParams;
  const p = parse(chain, record);
  if (!p) notFound();
  // ?dry=1: a specialist-pipeline dry run from docs/agent-log/dry-runs (never anchored).
  return <DecisionPage chainId={p.chainId} name={p.name} dryRun={dry === "1"} />;
}
