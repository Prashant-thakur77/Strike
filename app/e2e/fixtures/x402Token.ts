import { eip3009ABI } from "@x402/evm";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  encodeFunctionResult,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";

// An in-memory EIP-3009 token behind x402's FacilitatorEvmSigner interface, so the paid route's flow runs through
// x402's real ExactEvmScheme facilitator (signature, recipient, amount, validity window, balance and nonce checks,
// then transferWithAuthorization) without a chain. transferWithAuthorization recovers the signer from the signature
// and refuses a used nonce, an expired or not-yet-valid authorization and an empty balance, like USDC and USDG do.

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall3Abi = [
  {
    type: "function",
    name: "tryAggregate",
    stateMutability: "payable",
    inputs: [
      { name: "requireSuccess", type: "bool" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface FakeTokenOptions {
  address: Address;
  chainId: number;
  name: string;
  version: string;
  relayer: Address;
  balances: Record<string, bigint>;
}

export class FakeToken {
  readonly balances = new Map<string, bigint>();
  readonly used = new Set<string>();
  readonly sent: Hex[] = [];
  /** The Transfer log of each sent transaction, as a receipt carries it (x402 checks it after settling). */
  readonly logs = new Map<Hex, unknown[]>();
  /** Seconds; tests move it to expire an authorization. */
  now = () => Math.floor(Date.now() / 1000);

  constructor(readonly opts: FakeTokenOptions) {
    for (const [a, b] of Object.entries(opts.balances)) this.balances.set(a.toLowerCase(), b);
  }

  balanceOf(a: string): bigint {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }

  private async transfer(args: readonly unknown[], apply: boolean): Promise<void> {
    const [from, to, value, validAfter, validBefore, nonce, v, r, s] = args as [
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      Hex,
      number,
      Hex,
      Hex,
    ];
    const now = BigInt(this.now());
    if (this.used.has(`${from.toLowerCase()}:${nonce}`))
      throw new Error("FiatTokenV2: authorization is used");
    if (now <= validAfter) throw new Error("authorization is not yet valid");
    if (now >= validBefore) throw new Error("authorization is expired");
    const signer = await recoverTypedDataAddress({
      domain: {
        name: this.opts.name,
        version: this.opts.version,
        chainId: this.opts.chainId,
        verifyingContract: this.opts.address,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from, to, value, validAfter, validBefore, nonce },
      signature: { v: BigInt(v), r, s },
    });
    if (getAddress(signer) !== getAddress(from)) throw new Error("invalid signature");
    if (this.balanceOf(from) < value) throw new Error("transfer amount exceeds balance");
    if (!apply) return;
    this.used.add(`${from.toLowerCase()}:${nonce}`);
    this.balances.set(from.toLowerCase(), this.balanceOf(from) - value);
    this.balances.set(to.toLowerCase(), this.balanceOf(to) + value);
  }

  private read(functionName: string, args: readonly unknown[] = []): unknown {
    switch (functionName) {
      case "name":
        return this.opts.name;
      case "version":
        return this.opts.version;
      case "balanceOf":
        return this.balanceOf(args[0] as string);
      case "authorizationState":
        return this.used.has(`${String(args[0]).toLowerCase()}:${args[1]}`);
      default:
        throw new Error(`fake token: no ${functionName}`);
    }
  }

  /** x402's FacilitatorEvmSigner over this token. */
  signer() {
    const token = this;
    const isToken = (a: string) => a.toLowerCase() === token.opts.address.toLowerCase();
    return {
      getAddresses: () => [token.opts.relayer] as const,
      async readContract(a: { address: Address; functionName: string; args?: readonly unknown[] }) {
        if (a.address.toLowerCase() === MULTICALL3.toLowerCase() && a.functionName === "tryAggregate") {
          const calls = (a.args?.[1] ?? []) as { target: Address; callData: Hex }[];
          return Promise.all(
            calls.map(async (c) => {
              try {
                const d = decodeFunctionData({ abi: eip3009ABI, data: c.callData });
                if (d.functionName === "transferWithAuthorization") {
                  await token.transfer(d.args ?? [], false);
                  return { success: true, returnData: "0x" as Hex };
                }
                const value = token.read(d.functionName, d.args ?? []);
                return {
                  success: true,
                  returnData: encodeFunctionResult({
                    abi: eip3009ABI,
                    functionName: d.functionName,
                    result: value,
                  } as never),
                };
              } catch {
                return { success: false, returnData: "0x" as Hex };
              }
            }),
          );
        }
        if (!isToken(a.address)) throw new Error(`fake chain: no contract at ${a.address}`);
        if (a.functionName === "transferWithAuthorization") {
          await token.transfer(a.args ?? [], false);
          return undefined;
        }
        return token.read(a.functionName, a.args);
      },
      async verifyTypedData(a: Parameters<typeof verifyTypedData>[0]) {
        return verifyTypedData(a);
      },
      async writeContract(a: { address: Address; functionName: string; args: readonly unknown[] }) {
        if (!isToken(a.address) || a.functionName !== "transferWithAuthorization") {
          throw new Error(`fake chain: cannot send ${a.functionName}`);
        }
        await token.transfer(a.args, true);
        const hash = keccak256(toHex(`tx-${token.sent.length}-${Date.now()}`));
        token.sent.push(hash);
        const [from, to, value] = a.args as [Address, Address, bigint];
        token.logs.set(hash, [
          {
            address: token.opts.address,
            topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
            data: encodeAbiParameters([{ type: "uint256" }], [value]),
          },
        ]);
        return hash;
      },
      async sendTransaction(): Promise<Hex> {
        throw new Error("fake chain: sendTransaction is not supported");
      },
      async waitForTransactionReceipt(a: { hash: Hex }) {
        return { status: "success", logs: (token.logs.get(a.hash) ?? []) as never[] };
      },
      async getCode(a: { address: Address }) {
        return isToken(a.address) ? ("0x6080" as Hex) : undefined;
      },
    };
  }
}

/** Sign an EIP-3009 TransferWithAuthorization by hand (the negative tests change one field at a time). */
export async function signAuthorization(
  account: { address: Address; signTypedData: (a: never) => Promise<Hex> },
  token: FakeTokenOptions,
  message: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex },
): Promise<Hex> {
  return account.signTypedData({
    domain: {
      name: token.name,
      version: token.version,
      chainId: token.chainId,
      verifyingContract: token.address,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  } as never);
}
