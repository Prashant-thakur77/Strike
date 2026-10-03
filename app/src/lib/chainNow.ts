import { parseAbi, type PublicClient } from "viem";

const multicall3Abi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

/**
 * The chain's clock (the latest block's timestamp, unix seconds). Where the chain has Multicall3, it is read as
 * `getCurrentBlockTimestamp()`, so on a batching client it rides in the same Multicall3 call as the reads made in
 * the same tick instead of costing an `eth_getBlockByNumber` of its own. Elsewhere (the local devnet) it is the
 * latest block.
 */
export async function chainNow(client: PublicClient): Promise<number> {
  const multicall3 = client.chain?.contracts?.multicall3?.address;
  if (multicall3) {
    const ts = await client
      .readContract({ address: multicall3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" })
      .catch(() => null);
    if (ts !== null) return Number(ts);
  }
  return Number((await client.getBlock()).timestamp);
}
