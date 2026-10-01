import {
  type Address,
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type StrikeClient,
  StrikeError,
  agentRegistryV3Abi,
  createStrikeClient,
  explainError,
  strikeLocalChain,
} from "../src/index.js";
import { type Devnet, devnetUnavailableReason, startDevnet, v3ContractsDir } from "./devnet.mjs";

// v3 agent registration against the real v3 AgentRegistry: anvil plus Deploy.s.sol and Seed.s.sol from a checkout of
// the `v3-contracts` branch (STRIKE_V3_CONTRACTS, or a git worktree on that branch). Skipped without one.
const v3Dir = v3ContractsDir();
const unavailable = v3Dir === null ? "no v3-contracts checkout" : devnetUnavailableReason(v3Dir);
const usdgFaucetAbi = parseAbi(["function faucet(uint256 amount)"]);

describe.skipIf(unavailable !== null)("v3 agent registration on a local devnet", () => {
  let devnet: Devnet;
  let pub: PublicClient;
  let registry: Address;
  const chainFor = (url: string) => ({ ...strikeLocalChain, rpcUrls: { default: { http: [url] } } });

  /** A fresh funded account and a Strike client sending from it. */
  async function party(): Promise<{
    address: Address;
    client: StrikeClient;
    wallet: ReturnType<typeof walletOf>;
  }> {
    const account = privateKeyToAccount(generatePrivateKey());
    const test = createTestClient({
      mode: "anvil",
      chain: chainFor(devnet.rpcUrl),
      transport: http(devnet.rpcUrl),
    });
    await test.setBalance({ address: account.address, value: parseEther("1") });
    const wallet = walletOf(account);
    const client = createStrikeClient({
      publicClient: pub,
      walletClient: wallet,
      chainId: 31337,
      addresses: devnet.deployment,
    });
    return { address: account.address, client, wallet };
  }
  function walletOf(account: ReturnType<typeof privateKeyToAccount>) {
    return createWalletClient({ account, chain: chainFor(devnet.rpcUrl), transport: http(devnet.rpcUrl) });
  }
  const agentOf = (id: bigint) =>
    pub.readContract({ address: registry, abi: agentRegistryV3Abi, functionName: "getAgent", args: [id] });
  const nonceOf = (who: Address) =>
    pub.readContract({ address: registry, abi: agentRegistryV3Abi, functionName: "nonces", args: [who] });

  beforeAll(async () => {
    devnet = await startDevnet({ contractsDir: v3Dir! });
    pub = createPublicClient({
      chain: chainFor(devnet.rpcUrl),
      transport: http(devnet.rpcUrl),
      pollingInterval: 50,
    });
    registry = devnet.deployment.agentRegistry;
  }, 300_000);

  afterAll(() => devnet?.stop());

  it("detects v3 and reads the EIP-712 domain from eip712Domain()", async () => {
    const { client } = await party();
    expect(await client.registryVersion()).toBe("v3");
    expect(await client.agentRegistryDomain()).toEqual({
      name: "Strike AgentRegistry",
      version: "1",
      chainId: 31337,
      verifyingContract: registry,
    });
  });

  it("an owner registers a separate signer that consents through signerWallet, then bonds", async () => {
    const owner = await party();
    const signerKey = privateKeyToAccount(generatePrivateKey());
    const reg = await owner.client.registerAgent({
      signer: signerKey.address,
      payout: owner.address,
      signerWallet: walletOf(signerKey),
    });
    expect(reg).toMatchObject({ owner: owner.address, signer: signerKey.address, erc8004Id: 0n });
    expect(reg.agentId).toBeGreaterThan(1n); // Seed.s.sol registered agent 1
    expect(await agentOf(reg.agentId)).toMatchObject({
      owner: owner.address,
      signer: signerKey.address,
      status: 1,
    });
    expect(await nonceOf(signerKey.address)).toBe(1n); // the consent is spent

    const { minBond } = await owner.client.registryParams();
    await owner.wallet.writeContract({
      address: devnet.deployment.usdg,
      abi: usdgFaucetAbi,
      functionName: "faucet",
      args: [minBond],
    });
    await owner.client.postBond(reg.agentId, minBond);
    expect((await owner.client.getAgent(reg.agentId)).active).toBe(true);
  });

  it("two parties: the signer signs on its own client, the owner sends the consent", async () => {
    const owner = await party();
    const signer = await party();
    const consent = await signer.client.signRegisterConsent({ owner: owner.address, payout: owner.address });
    const reg = await owner.client.registerAgent({ signer: signer.address, payout: owner.address, consent });
    expect(reg.signer).toBe(signer.address);
    // The same consent cannot be used twice: the nonce moved on. Refused before sending...
    const again = await party();
    await expect(
      again.client.registerAgent({ signer: signer.address, payout: again.address, consent }),
    ).rejects.toBeInstanceOf(StrikeError);
  });

  it("a wallet that is its own signer registers without a consent signature", async () => {
    const me = await party();
    const reg = await me.client.registerAgent({ signer: me.address, payout: me.address });
    expect(reg).toMatchObject({ owner: me.address, signer: me.address });
    expect(await nonceOf(me.address)).toBe(0n);
  });

  it("a wrong signature: the SDK refuses it, and the contract reverts InvalidConsent (decoded)", async () => {
    const owner = await party();
    const signer = privateKeyToAccount(generatePrivateKey());
    const forger = privateKeyToAccount(generatePrivateKey());
    const td = await owner.client.registerConsentTypedData({ signer: signer.address, payout: owner.address });
    const forged = await forger.signTypedData(td);
    const consent = { signature: forged, deadline: td.message.deadline };
    await expect(
      owner.client.registerAgent({ signer: signer.address, payout: owner.address, consent }),
    ).rejects.toThrow(/not by the signer/);
    // Straight to the contract, bypassing the SDK's check.
    const err = await pub
      .simulateContract({
        account: owner.address,
        address: registry,
        abi: agentRegistryV3Abi,
        functionName: "register",
        args: [signer.address, owner.address, 0n, td.message.deadline, forged],
      })
      .catch((e: unknown) => e);
    expect(explainError(err)).toMatch(new RegExp(`^InvalidConsent\\(${signer.address}\\): v3:`));
    // An expired deadline reverts ConsentExpired.
    const now = await owner.client.blockTimestamp();
    const late = await owner.client.registerConsentTypedData({
      signer: signer.address,
      payout: owner.address,
      deadline: now - 1n,
    });
    const lateErr = await pub
      .simulateContract({
        account: owner.address,
        address: registry,
        abi: agentRegistryV3Abi,
        functionName: "register",
        args: [signer.address, owner.address, 0n, now - 1n, await signer.signTypedData(late)],
      })
      .catch((e: unknown) => e);
    expect(explainError(lateErr)).toMatch(/^ConsentExpired\(/);
  });

  it("setSigner rotates to a new key with its SetSigner consent", async () => {
    const owner = await party();
    const reg = await owner.client.registerAgent({ signer: owner.address, payout: owner.address });
    const next = privateKeyToAccount(generatePrivateKey());
    const rot = await owner.client.setSigner(reg.agentId, next.address, { signerWallet: walletOf(next) });
    expect(rot).toMatchObject({ agentId: reg.agentId, signer: next.address });
    expect((await agentOf(reg.agentId)).signer).toBe(next.address);
    expect(await owner.client.agentOfSigner(owner.address)).toBe(0n);
    // And back to the owner itself: no consent needed.
    await owner.client.setSigner(reg.agentId, owner.address);
    expect((await agentOf(reg.agentId)).signer).toBe(owner.address);
  });
});
