import { usdgDripAbi } from "@strike/sdk";
import { BaseError, ContractFunctionRevertedError, erc20Abi, type Address, type PublicClient } from "viem";
import { chainNow } from "./chainNow";
import { chainDeployments } from "./deployment";
import { fmtAgain } from "./marketHours";

export { fmtAgain };

/** USDG per drip and the cooldown, as in UsdgDrip.sol (AMOUNT, COOLDOWN). */
export const DRIP_AMOUNT = 10_000_000n;
export const DRIP_COOLDOWN = 86_400;

/** The chain's team USDG faucet (UsdgDrip) and the USDG it hands out, or null where there is none. */
export function dripOf(chainId: number): { drip: Address; usdg: Address } | null {
  const d = chainDeployments(chainId).find((x) => x.usdgDrip);
  return d?.usdgDrip ? { drip: d.usdgDrip, usdg: d.usdg } : null;
}

export interface DripState {
  drip: Address;
  /** USDG left in the faucet (6 decimals). */
  remaining: bigint;
  /** The account's USDG balance (0 without an account). */
  balance: bigint;
  /** When the account can drip next (unix seconds), 0 when it can now. */
  nextAt: number;
  /** The chain's clock (latest block), which the cooldown is measured on. */
  now: number;
}

export async function dripState(
  client: PublicClient,
  chainId: number,
  account: Address | undefined,
): Promise<DripState | null> {
  const f = dripOf(chainId);
  if (!f) return null;
  const c = { address: f.drip, abi: usdgDripAbi } as const;
  const [now, remaining, balance, next] = await Promise.all([
    chainNow(client),
    client.readContract({ ...c, functionName: "remaining" }),
    account
      ? client.readContract({ address: f.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      : 0n,
    account ? client.readContract({ ...c, functionName: "nextDripAt", args: [account] }) : 0n,
  ]);
  return { drip: f.drip, remaining, balance, nextAt: Number(next) > now ? Number(next) : 0, now };
}

/** A drip revert in plain words: TooSoon(next) → "already claimed: again at 14:05", Empty() → refill pending. */
export function dripErrorMessage(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  if (revert.data?.errorName === "TooSoon") {
    const next = Number(revert.data.args?.[0] ?? 0);
    return `This wallet already got its 10 USDG today: again at ${fmtAgain(next)}.`;
  }
  if (revert.data?.errorName === "Empty")
    return "The faucet is empty for now. The team refills it; try faucet.paxos.com meanwhile.";
  return null;
}

/** The chain's GasDrip and the relayer the deployment file names, or null where there is none. */
export function gasDripOf(chainId: number): { drip: Address; relayer: Address | null } | null {
  for (const d of chainDeployments(chainId)) {
    const r = d as { gasDrip?: Address; gasDripRelayer?: Address };
    if (r.gasDrip) return { drip: r.gasDrip, relayer: r.gasDripRelayer ?? null };
  }
  return null;
}
