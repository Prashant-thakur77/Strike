"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { BaseError, UserRejectedRequestError, type Hash } from "viem";
import { useConnection, useSwitchChain, useWriteContract } from "wagmi";
import { useStrike } from "./useStrike";

export type TxPhase = "idle" | "wallet" | "pending" | "done" | "error";

export interface TxState {
  phase: TxPhase;
  label?: string;
  hash?: Hash;
  error?: string;
}

export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Request rejected in the wallet.";
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Send a contract write on the selected network: switch the wallet if needed, wait for the receipt, refresh. */
export function useTx() {
  const { client, chainId } = useStrike();
  const { chainId: walletChain } = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const exec = useCallback(
    async (label: string, send: (w: typeof write) => Promise<Hash>) => {
      setState({ phase: "wallet", label });
      try {
        if (walletChain !== chainId) await switchChain({ chainId });
        const hash = await send(write);
        setState({ phase: "pending", label, hash });
        const receipt = await client!.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Transaction reverted.");
        setState({ phase: "done", label, hash });
        await queryClient.invalidateQueries({ queryKey: ["strike", chainId] });
        return true;
      } catch (err) {
        setState({ phase: "error", label, error: errorMessage(err) });
        return false;
      }
    },
    [walletChain, chainId, switchChain, write, client, queryClient],
  );

  /** A wallet step that sends no transaction (an EIP-712 signature): switch the wallet if needed, then `run`. */
  const sign = useCallback(
    async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
      setState({ phase: "wallet", label });
      try {
        if (walletChain !== chainId) await switchChain({ chainId });
        const out = await run();
        setState({ phase: "done", label });
        return out;
      } catch (err) {
        setState({ phase: "error", label, error: errorMessage(err) });
        return null;
      }
    },
    [walletChain, chainId, switchChain],
  );

  const busy = state.phase === "wallet" || state.phase === "pending";
  return { ...state, busy, exec, sign, reset: () => setState({ phase: "idle" }) };
}
