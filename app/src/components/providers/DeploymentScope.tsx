"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Deployment } from "@/lib/deployment";

// A chain can run more than one Strike deployment (v2 and v3 on Robinhood Chain testnet). A vault page wraps its
// panels in the scope of the vault's own deployment (found from the vault's EpochManager), so every read, the buy
// panel and redeem use that deployment's addresses; outside a scope `useStrike` gives the chain's default one.

const DeploymentContext = createContext<Deployment | null>(null);

export function DeploymentScope({ deployment, children }: { deployment: Deployment; children: ReactNode }) {
  return <DeploymentContext.Provider value={deployment}>{children}</DeploymentContext.Provider>;
}

/** The deployment of the enclosing scope, or null outside one. */
export function useScopedDeployment(): Deployment | null {
  return useContext(DeploymentContext);
}
