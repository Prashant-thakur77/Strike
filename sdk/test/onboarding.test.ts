import { type Address, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANDATE,
  MAX_TENOR_CAP,
  MIN_PREMIUM_FLOOR_BPS,
  type StrikeAddresses,
  StrikeError,
  agentRegistryAbi,
  createStrikeClient,
  epochManagerAbi,
  isValidMandate,
  mandateProblems,
  vaultFactoryAbi,
} from "../src/index.js";
import { type FakeContract, eventLog, fakeChain } from "./fake-chain.js";

// Joining as a new agent: register, bond, create a vault. Writes go through a fake wallet whose transactions are
// decoded and mined in memory, with the events the contracts would emit.

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const A: StrikeAddresses = {
  epochManager: addr(0xe1),
  agentRegistry: addr(0xa1),
  stockOracle: addr(0x0c),
  marketCalendar: addr(0xca),
  usdg: addr(0xd6),
  optionToken: addr(0x07),
  feeManager: addr(0xfe),
  vaultFactory: addr(0xfa),
};
const ME = addr(0xbeef);
const SIGNER = addr(0x5195);
const TSLA = addr(0x51);
const NEW_VAULT = addr(0x2002);
const IDENTITY = addr(0x8004);
const MONDAY = 1_791_212_400n;

const unknownAgent = {
  owner: addr(0),
  signer: addr(0),
  payout: addr(0),
  status: 0,
  strikes: 0,
  accepted: 0,
  rejected: 0,
  unbondAt: 0n,
  erc8004Id: 0n,
  bond: 0n,
  unbonding: 0n,
};

function chain(opts: { allowance?: bigint; identityRegistry?: Address } = {}) {
  const contracts: Record<Address, FakeContract> = {
    [A.agentRegistry]: {
      abi: agentRegistryAbi,
      fns: {
        register: 7n,
        postBond: [],
        minBond: 50_000_000n,
        slashAmount: 10_000_000n,
        maxStrikes: 3,
        unbondDelay: 691_200,
        identityRegistry: opts.identityRegistry ?? addr(0),
        reputationRegistry: addr(0),
        agentOfSigner: ([s]: readonly unknown[]) => (s === SIGNER ? 7n : 0n),
        getAgent: ([id]: readonly unknown[]) =>
          id === 7n ? { ...unknownAgent, owner: ME, signer: SIGNER, payout: ME, status: 1 } : unknownAgent,
        isActive: false,
        track: [0, 0n],
      },
      emits: {
        register: ([signer, , erc8004Id], from) => [
          eventLog(
            agentRegistryAbi,
            "AgentRegistered",
            { agentId: 7n, owner: from, signer, erc8004Id },
            A.agentRegistry,
          ),
        ],
        postBond: ([agentId, amount], from) => [
          eventLog(agentRegistryAbi, "BondPosted", { agentId, from, amount }, A.agentRegistry),
        ],
      },
    },
    [A.usdg]: {
      abi: erc20Abi,
      fns: { allowance: opts.allowance ?? 0n, approve: true },
    },
    [A.vaultFactory]: {
      abi: vaultFactoryAbi,
      fns: { createVault: NEW_VAULT, maxDepositCap: 5_000n * 10n ** 18n },
      emits: {
        createVault: ([p], from) => {
          const params = p as { underlying: Address; isCall: boolean; agentId: bigint };
          return [
            eventLog(
              vaultFactoryAbi,
              "VaultCreated",
              {
                vault: NEW_VAULT,
                curator: from,
                underlying: params.underlying,
                isCall: params.isCall,
                agentId: params.agentId,
              },
              A.vaultFactory,
            ),
          ];
        },
      },
    },
    [A.epochManager]: {
      abi: epochManagerAbi,
      fns: {
        underlyings: ([t]: readonly unknown[]) => [18, t === TSLA, 6n * 10n ** 17n, 0n, 0n, 50, 0],
      },
    },
    [IDENTITY]: {
      abi: [
        {
          type: "function",
          name: "ownerOf",
          stateMutability: "view",
          inputs: [{ name: "tokenId", type: "uint256" }],
          outputs: [{ name: "", type: "address" }],
        },
      ],
      fns: {
        ownerOf: ([id]: readonly unknown[]) => {
          if (id === 114n) return ME;
          throw new Error("ERC721NonexistentToken");
        },
      },
    },
  };
  const fake = fakeChain(contracts, { timestamp: MONDAY, account: ME });
  const strike = createStrikeClient({
    publicClient: fake.client,
    walletClient: fake.wallet,
    chainId: 999,
    addresses: A,
  });
  return { strike, sent: fake.sent };
}

const vaultParams = {
  underlying: TSLA,
  isCall: false,
  agentId: 7n,
  depositCap: 1_000_000_000n,
  name: "Strike TSLA Cash-Secured Put (agent 7)",
  symbol: "sTSLA-CSP-A7",
  mandate: DEFAULT_MANDATE,
};

describe("joining as an agent", () => {
  it("registers an agent and returns its id from AgentRegistered", async () => {
    const { strike, sent } = chain();
    const res = await strike.registerAgent({ signer: SIGNER, payout: ME, erc8004Id: 114n });
    expect(res).toMatchObject({ agentId: 7n, owner: ME, signer: SIGNER, erc8004Id: 114n });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).toEqual([
      { to: A.agentRegistry, from: ME, functionName: "register", args: [SIGNER, ME, 114n] },
    ]);
  });

  it("registers without an identity (erc8004Id 0)", async () => {
    const { strike, sent } = chain();
    expect((await strike.registerAgent({ signer: SIGNER, payout: ME })).erc8004Id).toBe(0n);
    expect(sent[0]?.args).toEqual([SIGNER, ME, 0n]);
  });

  it("approves USDG to the registry, then posts the bond", async () => {
    const { strike, sent } = chain();
    await strike.postBond(7n, 50_000_000n);
    expect(sent.map((t) => [t.to, t.functionName, t.args])).toEqual([
      [A.usdg, "approve", [A.agentRegistry, 50_000_000n]],
      [A.agentRegistry, "postBond", [7n, 50_000_000n]],
    ]);
  });

  it("skips the approval when the allowance already covers the bond", async () => {
    const { strike, sent } = chain({ allowance: 100_000_000n });
    await strike.postBond(7n, 50_000_000n);
    expect(sent.map((t) => t.functionName)).toEqual(["postBond"]);
    await expect(strike.postBond(7n, 0n)).rejects.toThrow(/positive/);
  });

  it("creates a vault run by the agent and returns its address from VaultCreated", async () => {
    const { strike, sent } = chain();
    const res = await strike.createVault(vaultParams);
    expect(res).toMatchObject({ vault: NEW_VAULT, curator: ME, agentId: 7n });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: A.vaultFactory, functionName: "createVault" });
    expect(sent[0]?.args[0]).toMatchObject({
      underlying: TSLA,
      isCall: false,
      agentId: 7n,
      symbol: "sTSLA-CSP-A7",
      mandate: DEFAULT_MANDATE,
    });
  });

  it("refuses a vault whose mandate breaks the floors, or whose agent does not exist", async () => {
    const { strike, sent } = chain();
    await expect(
      strike.createVault({ ...vaultParams, mandate: { ...DEFAULT_MANDATE, minPremiumBps: 8000 } }),
    ).rejects.toThrow(/minPremiumBps must be at least 9000/);
    await expect(
      strike.createVault({ ...vaultParams, mandate: { ...DEFAULT_MANDATE, maxTenor: 40 * 86_400 } }),
    ).rejects.toThrow(/35 days/);
    await expect(strike.createVault({ ...vaultParams, agentId: 99n })).rejects.toThrow(StrikeError);
    await expect(strike.createVault({ ...vaultParams, agentId: 99n })).rejects.toThrow(
      /#99 is not registered/,
    );
    expect(sent).toEqual([]);
  });

  it("reads what joining costs and whether a signer is taken", async () => {
    const { strike } = chain();
    expect(await strike.agentRegistryParams()).toMatchObject({
      minBond: 50_000_000n,
      slashAmount: 10_000_000n,
      maxStrikes: 3,
    });
    expect(await strike.agentOfSigner(SIGNER)).toBe(7n);
    expect(await strike.agentOfSigner(ME)).toBe(0n);
    expect(await strike.isUnderlyingAllowed(TSLA)).toBe(true);
    expect(await strike.isUnderlyingAllowed(addr(0x99))).toBe(false);
    expect(await strike.maxDepositCap()).toBe(5_000n * 10n ** 18n);
  });

  it("looks up ERC-8004 identity owners (null without a registry or a token)", async () => {
    expect(await chain().strike.identityOwner(114n)).toBeNull();
    const { strike } = chain({ identityRegistry: IDENTITY });
    expect(await strike.identityOwner(114n)).toBe(ME);
    expect(await strike.identityOwner(5n)).toBeNull();
  });
});

describe("mandate floors", () => {
  it("accepts the default mandate", () => {
    expect(mandateProblems(DEFAULT_MANDATE)).toEqual([]);
    expect(isValidMandate(DEFAULT_MANDATE)).toBe(true);
    expect(MIN_PREMIUM_FLOOR_BPS).toBe(9000);
    expect(MAX_TENOR_CAP).toBe(35 * 86_400);
  });

  it("names every rule MandateGuard.validate enforces", () => {
    const m = DEFAULT_MANDATE;
    const cases: [Partial<typeof m>, RegExp][] = [
      [{ minDeltaBps: 4000 }, /minDeltaBps must not exceed maxDeltaBps/],
      [{ maxDeltaBps: 10_001 }, /maxDeltaBps must be at most 10000/],
      [{ maxShareSoldBps: 0 }, /maxShareSoldBps/],
      [{ maxShareSoldBps: 10_001 }, /maxShareSoldBps/],
      [{ minPremiumBps: 8999 }, /at least 9000/],
      [{ minPremiumBps: 30_001 }, /at most 30000/],
      [{ minYieldBps: 10_001 }, /minYieldBps/],
      [{ minTenor: 0 }, /minTenor must be at least 1 second/],
      [{ minTenor: 9 * 86_400 }, /minTenor must not exceed maxTenor/],
      [{ maxTenor: MAX_TENOR_CAP + 1 }, /35 days/],
      [{ minDeltaBps: 1.5 }, /whole number of bps/],
      [{ maxTenor: -1 }, /whole number of seconds/],
    ];
    for (const [patch, re] of cases) {
      const problems = mandateProblems({ ...m, ...patch });
      expect(problems.join("; "), JSON.stringify(patch)).toMatch(re);
      expect(isValidMandate({ ...m, ...patch })).toBe(false);
    }
    // The boundaries themselves are allowed.
    expect(mandateProblems({ ...m, minPremiumBps: 9000, maxTenor: MAX_TENOR_CAP })).toEqual([]);
  });
});
