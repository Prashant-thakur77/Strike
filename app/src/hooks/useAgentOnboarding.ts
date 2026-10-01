"use client";

import {
  type RegistryVersion,
  agentRegistryAbi,
  createStrikeClient,
  epochManagerAbi,
  vaultFactoryAbi,
} from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { type Address, type PublicClient, erc20Abi, parseAbi } from "viem";
import { useConnection } from "wagmi";
import type { Deployment } from "@/lib/deployment";
import { useStrike } from "./useStrike";

// Reads behind the "Run your own agent" section: what joining costs, the stock tokens a vault may use, the wallet's
// USDG, and the live checks (is this signer free, who owns this ERC-8004 identity).

const ownerOfAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

export interface OnboardingStock {
  symbol: string;
  address: Address;
  decimals: number;
  allowed: boolean;
}

export interface OnboardingState {
  minBond: bigint;
  slashAmount: bigint;
  maxStrikes: number;
  /** Seconds between an unbond request and withdrawal. */
  unbondDelay: number;
  identityRegistry: Address | null;
  usdgDecimals: number;
  /** `VaultFactory.maxDepositCap`, collateral base units. */
  maxDepositCap: bigint;
  stocks: OnboardingStock[];
  /** The connected wallet's USDG and its allowance to the AgentRegistry (null without a wallet). */
  balance: bigint | null;
  allowance: bigint | null;
  /** "v3": a signer that is not the sending wallet must consent to `register` with an EIP-712 signature. */
  registryVersion: RegistryVersion;
}

async function onboardingState(
  client: PublicClient,
  dep: Deployment,
  chainId: number,
  wallet: Address | undefined,
): Promise<OnboardingState> {
  const r = { address: dep.agentRegistry, abi: agentRegistryAbi } as const;
  const usdg = { address: dep.usdg, abi: erc20Abi } as const;
  const stocks = Object.entries(dep.stocks);
  const [
    minBond,
    slashAmount,
    maxStrikes,
    unbondDelay,
    identityRegistry,
    usdgDecimals,
    maxDepositCap,
    configs,
    registryVersion,
  ] = await Promise.all([
    client.readContract({ ...r, functionName: "minBond" }),
    client.readContract({ ...r, functionName: "slashAmount" }),
    client.readContract({ ...r, functionName: "maxStrikes" }),
    client.readContract({ ...r, functionName: "unbondDelay" }),
    client.readContract({ ...r, functionName: "identityRegistry" }),
    client.readContract({ ...usdg, functionName: "decimals" }),
    client.readContract({ address: dep.vaultFactory, abi: vaultFactoryAbi, functionName: "maxDepositCap" }),
    Promise.all(
      stocks.map(([, s]) =>
        client.readContract({
          address: dep.epochManager,
          abi: epochManagerAbi,
          functionName: "underlyings",
          args: [s.token],
        }),
      ),
    ),
    // The map's version where it names one, else read from the registry (a local devnet may run v2 or v3).
    createStrikeClient({ publicClient: client, chainId, addresses: dep }).registryVersion(),
  ]);
  const [balance, allowance] = wallet
    ? await Promise.all([
        client.readContract({ ...usdg, functionName: "balanceOf", args: [wallet] }),
        client.readContract({ ...usdg, functionName: "allowance", args: [wallet, dep.agentRegistry] }),
      ])
    : [null, null];
  return {
    minBond,
    slashAmount,
    maxStrikes,
    unbondDelay,
    identityRegistry: identityRegistry.toLowerCase() === ZERO ? null : identityRegistry,
    usdgDecimals,
    maxDepositCap,
    stocks: stocks.map(([symbol, s], i) => ({
      symbol,
      address: s.token,
      decimals: configs[i]![0],
      allowed: configs[i]![1],
    })),
    balance,
    allowance,
    registryVersion,
  };
}

/** Registry parameters, allowed stocks and the connected wallet's USDG, refreshed with every transaction. */
export function useOnboarding() {
  const { client, deployment, chainId, ready } = useStrike();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["strike", chainId, "onboarding", address],
    enabled: ready && !!client && !!deployment,
    refetchInterval: 15_000,
    queryFn: () => onboardingState(client!, deployment!, chainId, address),
  });
}

/** `AgentRegistry.agentOfSigner(signer)`: the agent a key already signs for (0n when free). */
export function useSignerAgent(signer: Address | null) {
  const { client, deployment, chainId } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "signer-agent", signer],
    enabled: !!client && !!deployment && !!signer,
    queryFn: () =>
      client!.readContract({
        address: deployment!.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "agentOfSigner",
        args: [signer!],
      }),
  });
}

/** Holder of an ERC-8004 identity on `registry` (null when it does not exist). */
export function useIdentityOwner(registry: Address | null, id: bigint | null) {
  const { client, chainId } = useStrike();
  return useQuery({
    queryKey: ["strike", chainId, "identity-owner", registry, id?.toString()],
    enabled: !!client && !!registry && id !== null && id > 0n,
    queryFn: async (): Promise<Address | null> => {
      try {
        return await client!.readContract({
          address: registry!,
          abi: ownerOfAbi,
          functionName: "ownerOf",
          args: [id!],
        });
      } catch {
        return null;
      }
    },
  });
}

/**
 * The newest vault `curator` created for `agentId`: walks back from the end of `EpochManager.allVaults`. Used after
 * `createVault`, whose transaction hash is all the tx hook returns.
 */
export async function findCreatedVault(
  client: PublicClient,
  dep: Deployment,
  curator: Address,
  agentId: bigint,
): Promise<Address | null> {
  const em = { address: dep.epochManager, abi: epochManagerAbi } as const;
  const count = await client.readContract({ ...em, functionName: "vaultCount" });
  for (let i = count - 1n; i >= 0n && i >= count - 10n; i--) {
    const vault = await client.readContract({ ...em, functionName: "allVaults", args: [i] });
    const cfg = await client.readContract({ ...em, functionName: "vaultConfig", args: [vault] });
    if (cfg.agentId === agentId && cfg.curator.toLowerCase() === curator.toLowerCase()) return vault;
  }
  return null;
}
