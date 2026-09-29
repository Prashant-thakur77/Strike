import type { Metadata } from "next";
import { PlaygroundPage } from "@/components/app/playground/PlaygroundPage";

export const metadata: Metadata = {
  title: "Mandate playground",
  description:
    "Test a strike proposal against a live vault's immutable mandate, no wallet needed: the deployed EpochManager says whether it would list the series or reject it and slash the agent.",
};

export default function Page() {
  return <PlaygroundPage />;
}
