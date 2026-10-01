import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type StrikeClient, createStrikeClient, strikeLocalChain } from "@strike/sdk";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Devnet, devnetUnavailableReason, startDevnet, v3ContractsDir } from "../../sdk/test/devnet.mjs";
import { createStrikeMcpServer } from "../src/server.js";

// register_agent and set_signer through the MCP server against the real v3 AgentRegistry (anvil plus Deploy and
// Seed from a `v3-contracts` checkout: STRIKE_V3_CONTRACTS or a git worktree on that branch). Skipped without one.
const v3Dir = v3ContractsDir();
const unavailable = v3Dir === null ? "no v3-contracts checkout" : devnetUnavailableReason(v3Dir);

describe.skipIf(unavailable !== null)("Strike MCP server on a v3 devnet", () => {
  let devnet: Devnet;
  const chainFor = (url: string) => ({ ...strikeLocalChain, rpcUrls: { default: { http: [url] } } });

  const clientFor = (account: ReturnType<typeof privateKeyToAccount>): StrikeClient => {
    const chain = chainFor(devnet.rpcUrl);
    const transport = http(devnet.rpcUrl);
    return createStrikeClient({
      publicClient: createPublicClient({ chain, transport, pollingInterval: 50 }),
      walletClient: createWalletClient({ account, chain, transport }),
      chainId: 31337,
      addresses: devnet.deployment,
    });
  };
  const connect = async (client: StrikeClient) => {
    const server = createStrikeMcpServer({ chainId: 31337, client: () => client });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: "strike-e2e-v3", version: "0.0.0" });
    await c.connect(clientTransport);
    return c;
  };
  const callOn = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) throw new Error(`${name} failed: ${(r.content[0] as { text: string }).text}`);
    return r.structuredContent as Record<string, unknown>;
  };

  beforeAll(async () => {
    devnet = await startDevnet({ contractsDir: v3Dir! });
  }, 300_000);

  afterAll(() => devnet?.stop());

  it("a new agent joins with register_agent and moves proposing to a separate key with set_signer", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const test = createTestClient({
      mode: "anvil",
      chain: chainFor(devnet.rpcUrl),
      transport: http(devnet.rpcUrl),
    });
    await test.setBalance({ address: owner.address, value: parseEther("1") });
    const strike = clientFor(owner);
    await strike.viem.publicClient.waitForTransactionReceipt({
      hash: await strike.viem.walletClient!.writeContract({
        account: owner,
        chain: chainFor(devnet.rpcUrl),
        address: devnet.deployment.usdg,
        abi: parseAbi(["function faucet(uint256 amount)"]),
        functionName: "faucet",
        args: [100_000_000n],
      }),
    });
    const mcp = await connect(strike);
    try {
      const reg = await callOn(mcp, "register_agent", { bond: "min" });
      expect(reg).toMatchObject({
        submitted: true,
        registryVersion: "v3",
        signer: owner.address,
        bond: "50",
        active: true,
      });
      const agentId = reg.agentId as string;
      expect(BigInt(agentId)).toBeGreaterThan(1n);

      // A separate signer key: without its consent set_signer refuses and hands back the typed data.
      const signerKey = privateKeyToAccount(generatePrivateKey());
      const refused = await callOn(mcp, "set_signer", { agentId, signer: signerKey.address });
      expect(refused).toMatchObject({ submitted: false, consentRequired: true });
      const typed = JSON.parse(refused.consentTypedData as string);
      expect(typed.message).toMatchObject({ owner: owner.address, agentId, nonce: "0" });

      // The key's holder signs with the SDK (it needs no ETH: signing sends nothing).
      const consent = await clientFor(signerKey).signSetSignerConsent({ agentId: BigInt(agentId) });
      const rotated = await callOn(mcp, "set_signer", {
        agentId,
        signer: signerKey.address,
        consentSignature: consent.signature,
        consentDeadline: consent.deadline.toString(),
      });
      expect(rotated).toMatchObject({
        submitted: true,
        previousSigner: owner.address,
        signer: signerKey.address,
      });
      expect(await strike.agentOfSigner(signerKey.address)).toBe(BigInt(agentId));

      // Back to the server's own key: no consent.
      const back = await callOn(mcp, "set_signer", { agentId, signer: owner.address });
      expect(back).toMatchObject({ submitted: true, consentRequired: false });
      expect(await strike.agentOfSigner(owner.address)).toBe(BigInt(agentId));
    } finally {
      await mcp.close();
    }
  });
});
