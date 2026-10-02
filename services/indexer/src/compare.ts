import type { DeploymentUsage, UsageCounts, UsageStats } from "./stats.js";

/** The /stats figures that are counted from logs (value locked moves with the spot price and is not compared). */
export const COUNTED = [
  "vaults",
  "epochsOpened",
  "epochsSettled",
  "epochsAborted",
  "proposalsAccepted",
  "proposalsRejected",
  "buys",
  "optionsBought",
  "premiumUsdg",
  "slashedUsdg",
  "deposits",
  "queuedDeposits",
  "withdrawals",
  "agentsRegistered",
  "bondsPosted",
  "bondedUsdg",
  "decisionRecords",
  "wallets",
  "outsideWallets",
] as const satisfies readonly (keyof UsageCounts)[];

export interface Difference {
  key: string;
  field: string;
  indexer: unknown;
  live: unknown;
}

/** Counted fields that differ between two /stats answers, per deployment and in the total. */
export function compareStats(
  a: Pick<UsageStats, "deployments" | "total">,
  b: Pick<UsageStats, "deployments" | "total">,
): Difference[] {
  const out: Difference[] = [];
  const bDeps = new Map(b.deployments.map((d) => [d.key, d]));
  const check = (
    key: string,
    x: Partial<DeploymentUsage> | UsageCounts,
    y: Partial<DeploymentUsage> | UsageCounts,
  ) => {
    for (const f of COUNTED) {
      if (x[f] !== y[f]) out.push({ key, field: f, indexer: x[f], live: y[f] });
    }
  };
  for (const d of a.deployments) {
    const l = bDeps.get(d.key);
    if (!l) {
      out.push({ key: d.key, field: "deployment", indexer: "present", live: "missing" });
      continue;
    }
    check(d.key, d, l);
    if (d.fromBlock !== l.fromBlock)
      out.push({ key: d.key, field: "fromBlock", indexer: d.fromBlock, live: l.fromBlock });
  }
  for (const l of b.deployments) {
    if (!a.deployments.some((d) => d.key === l.key)) {
      out.push({ key: l.key, field: "deployment", indexer: "missing", live: "present" });
    }
  }
  check("total", a.total, b.total);
  return out;
}
