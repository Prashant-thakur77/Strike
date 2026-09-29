import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  toHex,
} from "viem";

/** A function's canned result, or a function of its decoded arguments. */
export type FakeResult = unknown | ((args: readonly unknown[]) => unknown);

/** A log a fake transaction emits. */
export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface FakeContract {
  abi: Abi;
  fns: Record<string, FakeResult>;
  /** Logs a sent transaction to this function emits (writes only). */
  emits?: Record<string, (args: readonly unknown[], from: Address) => FakeLog[]>;
}

/** A transaction sent through the fake wallet, decoded. */
export interface SentTx {
  to: Address;
  from: Address;
  functionName: string;
  args: readonly unknown[];
}

/** An event log with its indexed and data fields encoded the way a node returns them. */
export function eventLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
): FakeLog {
  const event = abi.find((x) => x.type === "event" && x.name === eventName);
  if (!event || event.type !== "event") throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics,
    data: encodeAbiParameters(
      data,
      data.map((i) => args[i.name as string]),
    ),
  };
}

/**
 * An in-memory "chain" behind viem clients: `eth_call`s are decoded with each contract's ABI and answered from
 * `fns`; `eth_sendTransaction` (from the fake wallet's JSON-RPC account) is decoded, recorded in `sent`, and mined
 * at once with the logs from `emits`. Enough for the SDK's read and write paths without a node.
 */
export function fakeChain(
  contracts: Record<Address, FakeContract>,
  opts: { timestamp: bigint; account?: Address },
): { client: PublicClient; wallet: WalletClient; calls: string[]; sent: SentTx[] } {
  const byAddress = new Map(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const calls: string[] = [];
  const sent: SentTx[] = [];
  const receipts = new Map<string, FakeLog[]>();
  const contractAt = (to: Address) => {
    const contract = byAddress.get(to.toLowerCase());
    if (!contract) throw new Error(`no fake contract at ${to}`);
    return contract;
  };
  const transport = custom({
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
          const contract = contractAt(to);
          const { functionName, args } = decodeFunctionData({ abi: contract.abi, data });
          calls.push(functionName);
          if (!(functionName in contract.fns)) throw new Error(`unmocked ${functionName} on ${to}`);
          const fn = contract.fns[functionName];
          const result = typeof fn === "function" ? fn(args ?? []) : fn;
          return encodeFunctionResult({ abi: contract.abi, functionName, result } as never);
        }
        case "eth_sendTransaction": {
          const [{ to, from, data }] = params as [{ to: Address; from: Address; data: Hex }];
          const contract = contractAt(to);
          const { functionName, args = [] } = decodeFunctionData({ abi: contract.abi, data });
          sent.push({ to, from, functionName, args });
          const hash = keccak256(toHex(`tx-${sent.length}`));
          receipts.set(hash, contract.emits?.[functionName]?.(args, from) ?? []);
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const [hash] = params as [Hex];
          const logs = receipts.get(hash);
          if (!logs) return null;
          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: `0x${"11".repeat(32)}`,
            blockNumber: "0x1",
            from: opts.account,
            to: null,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            contractAddress: null,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x2",
            logs: logs.map((l, i) => ({
              ...l,
              blockHash: `0x${"11".repeat(32)}`,
              blockNumber: "0x1",
              transactionHash: hash,
              transactionIndex: "0x0",
              logIndex: toHex(i),
              removed: false,
            })),
          };
        }
        default:
          throw new Error(`unmocked RPC method ${method}`);
      }
    },
  });
  const client: PublicClient = createPublicClient({ transport, pollingInterval: 1 });
  const wallet = createWalletClient({ account: opts.account, transport });
  return { client, wallet, calls, sent };
}

/** A read-only view of {@link fakeChain}: just the public client and the names of the functions called. */
export function fakePublicClient(
  contracts: Record<Address, FakeContract>,
  opts: { timestamp: bigint },
): { client: PublicClient; calls: string[] } {
  const { client, calls } = fakeChain(contracts, opts);
  return { client, calls };
}
