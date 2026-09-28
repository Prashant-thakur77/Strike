import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  toHex,
} from "viem";

/** A function's canned result, or a function of its decoded arguments. */
export type FakeResult = unknown | ((args: readonly unknown[]) => unknown);

export interface FakeContract {
  abi: Abi;
  fns: Record<string, FakeResult>;
}

/**
 * A viem public client over an in-memory "chain": `eth_call`s are decoded with each contract's ABI and answered
 * from `fns`. Enough for the SDK's read paths without a node.
 */
export function fakePublicClient(
  contracts: Record<Address, FakeContract>,
  opts: { timestamp: bigint },
): { client: PublicClient; calls: string[] } {
  const byAddress = new Map(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const calls: string[] = [];
  const client: PublicClient = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        switch (method) {
          case "eth_chainId":
            return toHex(999);
          case "eth_blockNumber":
            return "0x1";
          case "eth_getBlockByNumber":
            return {
              number: "0x1",
              hash: `0x${"11".repeat(32)}`,
              parentHash: `0x${"00".repeat(32)}`,
              timestamp: toHex(opts.timestamp),
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              baseFeePerGas: "0x1",
              transactions: [],
            };
          case "eth_call": {
            const [{ to, data }] = params as [{ to: Address; data: Hex }];
            const contract = byAddress.get(to.toLowerCase());
            if (!contract) throw new Error(`no fake contract at ${to}`);
            const { functionName, args } = decodeFunctionData({ abi: contract.abi, data });
            calls.push(functionName);
            if (!(functionName in contract.fns)) throw new Error(`unmocked ${functionName} on ${to}`);
            const fn = contract.fns[functionName];
            const result = typeof fn === "function" ? fn(args ?? []) : fn;
            return encodeFunctionResult({ abi: contract.abi, functionName, result } as never);
          }
          default:
            throw new Error(`unmocked RPC method ${method}`);
        }
      },
    }),
  });
  return { client, calls };
}
