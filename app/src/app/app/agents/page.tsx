import type { Metadata } from "next";
import { AgentsPage } from "@/components/app/agents/AgentsPage";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return <AgentsPage />;
}
