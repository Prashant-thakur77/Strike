import { type Address, type PublicClient, createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  agentRegistryV3Abi,
  createStrikeClient,
  explainError,
  getDeployment,
  getStrikeChain,
  registerConsentTypedData,
} from "../src/index.js";

// Opt-in (STRIKE_LIVE=1): v3 registration against the deployed AgentRegistries on Arbitrum Sepolia (the map's
// 421614 entry) and Robinhood Chain testnet (v3 next to v2: the registry passed as an address override, so the
// version is read from the chain), by simulation only. Fresh random keys, eth_call / simulateContract: no transaction
// is sent and no key is needed. Proves the SDK's typed data hashes to the contract's own registerDigest and that a
// signature over it verifies in `register`. RPC: STRIKE_LIVE_RPC_<chainId>, else the chain's public RPC.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const live = env.STRIKE_LIVE === "1";
/** v3's AgentRegistry on Robinhood Chain testnet (contracts/deployments/46630-v3.json). */
const RH_V3_REGISTRY: Address = "0x1c42740145B245b2f894d8e989ca29dfd9A9052f";

describe.skipIf(!live).each([
  { name: "Arbitrum Sepolia", chainId: 421614, override: undefined },
  { name: "Robinhood Chain testnet (v3)", chainId: 46630, override: RH_V3_REGISTRY },
])("v3 register on $name (simulation only)", ({ chainId: CHAIN_ID, override }) => {
  let pub: PublicClient;
  let registry: Address;
  const owner = privateKeyToAccount(generatePrivateKey());
  const signer = privateKeyToAccount(generatePrivateKey());

  beforeAll(() => {
    const chain = getStrikeChain(CHAIN_ID);
    const url = env[`STRIKE_LIVE_RPC_${CHAIN_ID}`] ?? chain.rpcUrls.default.http[0];
    pub = createPublicClient({ chain, transport: http(url) });
    registry = override ?? getDeployment(CHAIN_ID, {}).agentRegistry;
  });

  const simulateRegister = (args: readonly [Address, Address, bigint, bigint, `0x${string}`]) =>
    pub.simulateContract({
      account: owner.address,
      address: registry,
      abi: agentRegistryV3Abi,
      functionName: "register",
      args,
    });

  it("a fresh signer's consent verifies in register; a forged one reverts InvalidConsent", async () => {
    const strike = createStrikeClient({
      publicClient: pub,
      chainId: CHAIN_ID,
      addresses: override ? { agentRegistry: override } : undefined,
    });
    expect(await strike.registryVersion()).toBe("v3");
    const domain = await strike.agentRegistryDomain();
    expect(domain).toEqual({
      name: "Strike AgentRegistry",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: registry,
    });
    // Checked against the contract's registerDigest inside registerConsentTypedData.
    const td = await strike.registerConsentTypedData({
      signer: signer.address,
      payout: owner.address,
      owner: owner.address,
    });
    expect(td).toEqual(
      registerConsentTypedData(domain, {
        owner: owner.address,
        payout: owner.address,
        erc8004Id: 0n,
        nonce: 0n,
        deadline: td.message.deadline,
      }),
    );
    const agentCount = await pub.readContract({
      address: registry,
      abi: agentRegistryV3Abi,
      functionName: "agentCount",
    });
    const signature = await signer.signTypedData(td);
    const ok = await simulateRegister([signer.address, owner.address, 0n, td.message.deadline, signature]);
    expect(ok.result).toBe(agentCount + 1n);

    const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(td);
    const err = await simulateRegister([
      signer.address,
      owner.address,
      0n,
      td.message.deadline,
      forged,
    ]).catch((e: unknown) => e);
    expect(explainError(err)).toMatch(new RegExp(`^InvalidConsent\\(${signer.address}\\)`));

    // A wallet that is its own signer: no consent.
    const self = await pub.simulateContract({
      account: owner.address,
      address: registry,
      abi: agentRegistryV3Abi,
      functionName: "register",
      args: [owner.address, owner.address, 0n, 0n, "0x"],
    });
    expect(self.result).toBe(agentCount + 1n);
    console.log(
      `${CHAIN_ID} AgentRegistry ${registry}: agentCount ${agentCount}; simulated register with consent from ${signer.address} -> agent #${ok.result}; forged -> ${explainError(err).split(":")[0]}`,
    );
  }, 60_000);
});
