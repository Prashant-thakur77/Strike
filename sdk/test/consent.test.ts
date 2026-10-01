import {
  type Address,
  type Hex,
  concat,
  createWalletClient,
  custom,
  encodeAbiParameters,
  getAddress,
  keccak256,
  recoverAddress,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  AGENT_REGISTRY_EIP712,
  type StrikeAddresses,
  StrikeError,
  agentRegistryAbi,
  agentRegistryV3Abi,
  consentSignerOf,
  createStrikeClient,
  explainError,
  getDeployment,
  registerConsentTypedData,
} from "../src/index.js";
import { FakeRevert, eventLog, fakeChain } from "./fake-chain.js";

// v2 and v3 agent registration. v3's AgentRegistry makes a signer that is not the sending wallet consent with an
// EIP-712 signature; the fake v3 registry below recomputes the digest the way the contract does (abi.encode of the
// type hash and fields, the domain separator, 0x1901) and recovers the signer, independently of the SDK's viem
// typed-data path.

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
const CHAIN = 999; // the fake chain's eth_chainId
const MONDAY = 1_791_212_400n;
// Throwaway signer keys, fresh for each run.
const signerAccount = privateKeyToAccount(generatePrivateKey());
const otherAccount = privateKeyToAccount(generatePrivateKey());
const SIGNER = signerAccount.address;

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

const enc = (types: string[], values: unknown[]) =>
  encodeAbiParameters(
    types.map((type) => ({ type })),
    values,
  );
const hashString = (x: string) => keccak256(toHex(x));
const DOMAIN_TYPEHASH = hashString(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
);
const REGISTER_TYPEHASH = hashString(
  "Register(address owner,address payout,uint256 erc8004Id,uint256 nonce,uint256 deadline)",
);
const SET_SIGNER_TYPEHASH = hashString(
  "SetSigner(address owner,uint256 agentId,uint256 nonce,uint256 deadline)",
);
const domainSeparator = keccak256(
  enc(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      DOMAIN_TYPEHASH,
      hashString(AGENT_REGISTRY_EIP712.name),
      hashString(AGENT_REGISTRY_EIP712.version),
      BigInt(CHAIN),
      A.agentRegistry,
    ],
  ),
);
const digestOf = (structHash: Hex) => keccak256(concat(["0x1901", domainSeparator, structHash]));
const registerDigest = (owner: Address, payout: Address, id: bigint, nonce: bigint, deadline: bigint) =>
  digestOf(
    keccak256(
      enc(
        ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
        [REGISTER_TYPEHASH, owner, payout, id, nonce, deadline],
      ),
    ),
  );
const setSignerDigest = (owner: Address, agentId: bigint, nonce: bigint, deadline: bigint) =>
  digestOf(
    keccak256(
      enc(
        ["bytes32", "address", "uint256", "uint256", "uint256"],
        [SET_SIGNER_TYPEHASH, owner, agentId, nonce, deadline],
      ),
    ),
  );

/** A v3 AgentRegistry as the contract behaves: nonces, digests, consent checked in `register` and `setSigner`. */
function v3Chain(
  opts: { nonce?: bigint; wrongDigest?: boolean; revertRegister?: string; noDomain?: boolean } = {},
) {
  const nonce = opts.nonce ?? 0n;
  const checkConsent = async (signer: Address, digest: Hex, deadline: bigint, signature: Hex) => {
    if (MONDAY > deadline) throw new FakeRevert("ConsentExpired", [deadline]);
    let recovered: Address | null = null;
    try {
      recovered = await recoverAddress({ hash: digest, signature });
    } catch {
      recovered = null;
    }
    if (recovered !== signer) throw new FakeRevert("InvalidConsent", [signer]);
  };
  const fns: Record<string, unknown> = {
    REGISTER_TYPEHASH,
    nonces: () => nonce,
    registerDigest: ([, owner, payout, id, deadline]: readonly unknown[]) =>
      opts.wrongDigest
        ? keccak256(toHex("not the digest"))
        : registerDigest(owner as Address, payout as Address, id as bigint, nonce, deadline as bigint),
    setSignerDigest: ([, agentId, deadline]: readonly unknown[]) =>
      setSignerDigest(ME, agentId as bigint, nonce, deadline as bigint),
    getAgent: ([id]: readonly unknown[]) =>
      id === 7n ? { ...unknownAgent, owner: ME, signer: ME, payout: ME, status: 1 } : unknownAgent,
    register: async ([signer, payout, id, deadline, signature]: readonly unknown[]) => {
      if (opts.revertRegister) throw new FakeRevert(opts.revertRegister, [signer]);
      if (signer !== ME) {
        const digest = registerDigest(ME, payout as Address, id as bigint, nonce, deadline as bigint);
        await checkConsent(signer as Address, digest, deadline as bigint, signature as Hex);
      }
      return 7n;
    },
    setSigner: async ([agentId, signer, deadline, signature]: readonly unknown[]) => {
      if (signer !== ME) {
        const digest = setSignerDigest(ME, agentId as bigint, nonce, deadline as bigint);
        await checkConsent(signer as Address, digest, deadline as bigint, signature as Hex);
      }
      return [];
    },
  };
  if (!opts.noDomain) {
    fns.eip712Domain = [
      "0x0f",
      AGENT_REGISTRY_EIP712.name,
      AGENT_REGISTRY_EIP712.version,
      BigInt(CHAIN),
      A.agentRegistry,
      `0x${"00".repeat(32)}`,
      [],
    ];
  }
  const fake = fakeChain(
    {
      [A.agentRegistry]: {
        abi: agentRegistryV3Abi,
        fns,
        emits: {
          register: ([signer, , erc8004Id], from) => [
            eventLog(
              agentRegistryV3Abi,
              "AgentRegistered",
              { agentId: 7n, owner: from, signer, erc8004Id },
              A.agentRegistry,
            ),
          ],
          setSigner: ([agentId, signer]) => [
            eventLog(agentRegistryV3Abi, "SignerSet", { agentId, signer }, A.agentRegistry),
          ],
        },
      },
    },
    { timestamp: MONDAY, account: ME },
  );
  const strike = createStrikeClient({
    publicClient: fake.client,
    walletClient: fake.wallet,
    chainId: CHAIN,
    addresses: A,
  });
  return { strike, fake };
}

/** v2's registry: `register(signer, payout, erc8004Id)`, `setSigner(agentId, signer)`, no consent functions. */
function v2Chain() {
  const fake = fakeChain(
    {
      [A.agentRegistry]: {
        abi: agentRegistryAbi,
        fns: { register: 7n, setSigner: [] },
        emits: {
          register: ([signer, , erc8004Id], from) => [
            eventLog(
              agentRegistryAbi,
              "AgentRegistered",
              { agentId: 7n, owner: from, signer, erc8004Id },
              A.agentRegistry,
            ),
          ],
          setSigner: ([agentId, signer]) => [
            eventLog(agentRegistryAbi, "SignerSet", { agentId, signer }, A.agentRegistry),
          ],
        },
      },
    },
    { timestamp: MONDAY, account: ME },
  );
  const strike = createStrikeClient({
    publicClient: fake.client,
    walletClient: fake.wallet,
    chainId: CHAIN,
    addresses: A,
  });
  return { strike, fake };
}

/** A wallet holding a signer key (signs locally; never sends). */
const keyWallet = (account: typeof signerAccount) =>
  createWalletClient({
    account,
    transport: custom({
      request: async () => {
        throw new Error("the signer wallet sends nothing");
      },
    }),
  });

describe("registry version", () => {
  it("probes the chain: a registry without REGISTER_TYPEHASH is v2, one with it is v3", async () => {
    expect(await v2Chain().strike.registryVersion()).toBe("v2");
    const { strike, fake } = v3Chain();
    expect(await strike.registryVersion()).toBe("v3");
    await strike.registryVersion();
    expect(fake.calls.filter((c) => c === "REGISTER_TYPEHASH")).toHaveLength(1); // cached
  });

  it("uses the deployment map's version when the registry is the map's own, and the config when given", async () => {
    const { fake } = v2Chain();
    const arb = getDeployment(421614, {});
    const onArb = createStrikeClient({ publicClient: fake.client, chainId: 421614 });
    expect(arb.version).toBe("v3");
    expect(await onArb.registryVersion()).toBe("v3");
    const rh = createStrikeClient({ publicClient: fake.client, chainId: 46630 });
    expect(await rh.registryVersion()).toBe("v2");
    expect(fake.calls).toEqual([]); // no probe
    const forced = createStrikeClient({
      publicClient: fake.client,
      chainId: CHAIN,
      addresses: A,
      registryVersion: "v3",
    });
    expect(await forced.registryVersion()).toBe("v3");
  });
});

describe("v2 registration (no consent)", () => {
  it("sends register(signer, payout, erc8004Id) and setSigner(agentId, signer)", async () => {
    const { strike, fake } = v2Chain();
    const reg = await strike.registerAgent({ signer: SIGNER, payout: ME, erc8004Id: 114n });
    expect(reg).toMatchObject({ agentId: 7n, owner: ME, signer: SIGNER, erc8004Id: 114n });
    const rot = await strike.setSigner(7n, SIGNER);
    expect(rot).toMatchObject({ agentId: 7n, signer: SIGNER });
    expect(fake.sent.map((t) => [t.functionName, t.args])).toEqual([
      ["register", [SIGNER, ME, 114n]],
      ["setSigner", [7n, SIGNER]],
    ]);
  });

  it("refuses to build a consent for a v2 registry", async () => {
    const { strike } = v2Chain();
    await expect(strike.registerConsentTypedData({ signer: SIGNER, payout: ME })).rejects.toThrow(
      /v2, which takes no signer consent/,
    );
  });
});

describe("v3 registration (EIP-712 signer consent)", () => {
  it("the wallet as its own signer needs no consent: deadline 0 and empty bytes", async () => {
    const { strike, fake } = v3Chain();
    const reg = await strike.registerAgent({ signer: ME, payout: ME });
    expect(reg).toMatchObject({ agentId: 7n, owner: ME, signer: ME });
    expect(fake.sent).toEqual([
      { to: A.agentRegistry, from: ME, functionName: "register", args: [ME, ME, 0n, 0n, "0x"] },
    ]);
    expect(fake.calls).not.toContain("registerDigest");
  });

  it("builds the Register typed data from eip712Domain and the signer's nonce, matching registerDigest", async () => {
    const { strike } = v3Chain({ nonce: 3n });
    const td = await strike.registerConsentTypedData({
      signer: SIGNER,
      payout: ME,
      erc8004Id: 253n,
      deadline: MONDAY + 60n,
    });
    expect(td).toEqual(
      registerConsentTypedData(
        { name: "Strike AgentRegistry", version: "1", chainId: CHAIN, verifyingContract: A.agentRegistry },
        { owner: ME, payout: ME, erc8004Id: 253n, nonce: 3n, deadline: MONDAY + 60n },
      ),
    );
    expect(td.primaryType).toBe("Register");
    expect(await strike.consentNonce(SIGNER)).toBe(3n);
  });

  it("falls back to the constructor's name and version when eip712Domain cannot be read", async () => {
    const { strike } = v3Chain({ noDomain: true });
    expect(await strike.agentRegistryDomain()).toEqual({
      name: "Strike AgentRegistry",
      version: "1",
      chainId: CHAIN,
      verifyingContract: A.agentRegistry,
    });
  });

  it("a separate signer signs through signerWallet; the contract recovers it and registers", async () => {
    const { strike, fake } = v3Chain({ nonce: 1n });
    const reg = await strike.registerAgent({
      signer: SIGNER,
      payout: ME,
      erc8004Id: 253n,
      signerWallet: keyWallet(signerAccount),
    });
    expect(reg).toMatchObject({ agentId: 7n, owner: ME, signer: SIGNER, erc8004Id: 253n });
    const [tx] = fake.sent;
    expect(tx?.functionName).toBe("register");
    const [, , , deadline, signature] = tx!.args as [Address, Address, bigint, bigint, Hex];
    expect(deadline).toBe(MONDAY + 3_600n);
    expect(await recoverAddress({ hash: registerDigest(ME, ME, 253n, 1n, deadline), signature })).toBe(
      SIGNER,
    );
  });

  it("accepts a consent the signer made on its own client (two parties)", async () => {
    // The signer's side: its own client, its own wallet.
    const signerSide = v3Chain();
    const signerClient = createStrikeClient({
      publicClient: signerSide.fake.client,
      walletClient: keyWallet(signerAccount),
      chainId: CHAIN,
      addresses: A,
    });
    const consent = await signerClient.signRegisterConsent({
      owner: ME,
      payout: ME,
      deadline: MONDAY + 600n,
    });
    expect(consent.deadline).toBe(MONDAY + 600n);
    // The owner's side sends it.
    const { strike, fake } = v3Chain();
    await strike.registerAgent({ signer: SIGNER, payout: ME, consent });
    expect(fake.sent[0]?.args).toEqual([SIGNER, ME, 0n, MONDAY + 600n, consent.signature]);
  });

  it("rejects a wrong signature client-side and sends nothing", async () => {
    const { strike, fake } = v3Chain();
    const td = await strike.registerConsentTypedData({ signer: SIGNER, payout: ME, deadline: MONDAY + 600n });
    const forged = await otherAccount.signTypedData(td);
    expect(await consentSignerOf(td, forged)).toBe(otherAccount.address);
    const attempt = strike.registerAgent({
      signer: SIGNER,
      payout: ME,
      consent: { signature: forged, deadline: MONDAY + 600n },
    });
    await expect(attempt).rejects.toBeInstanceOf(StrikeError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`was made by ${otherAccount.address}, not by the signer ${SIGNER}.*InvalidConsent`),
    );
    // Signed for another owner (the signer consented to someone else registering it).
    const elsewhere = await signerAccount.signTypedData({
      ...td,
      message: { ...td.message, owner: addr(0xbad) },
    });
    await expect(
      strike.registerAgent({
        signer: SIGNER,
        payout: ME,
        consent: { signature: elsewhere, deadline: MONDAY + 600n },
      }),
    ).rejects.toThrow(/not by the signer/);
    await expect(
      strike.registerAgent({
        signer: SIGNER,
        payout: ME,
        consent: { signature: "0x1234", deadline: MONDAY + 600n },
      }),
    ).rejects.toThrow(/is malformed/);
    expect(fake.sent).toEqual([]);
  });

  it("rejects an expired consent and a missing one, explaining what is needed", async () => {
    const { strike, fake } = v3Chain();
    const td = await strike.registerConsentTypedData({ signer: SIGNER, payout: ME, deadline: MONDAY - 1n });
    const old = await signerAccount.signTypedData(td);
    await expect(
      strike.registerAgent({
        signer: SIGNER,
        payout: ME,
        consent: { signature: old, deadline: MONDAY - 1n },
      }),
    ).rejects.toThrow(/consent expired/);
    await expect(strike.registerAgent({ signer: SIGNER, payout: ME })).rejects.toThrow(
      /v3: the signer .* must consent with an EIP-712 signature/,
    );
    // A signerWallet holding another key is refused before anything is signed.
    await expect(
      strike.registerAgent({ signer: SIGNER, payout: ME, signerWallet: keyWallet(otherAccount) }),
    ).rejects.toThrow(/must be signed by the signer/);
    expect(fake.sent).toEqual([]);
  });

  it("never asks a wallet to sign typed data that does not match the registry's registerDigest", async () => {
    const { strike } = v3Chain({ wrongDigest: true });
    await expect(
      strike.registerAgent({ signer: SIGNER, payout: ME, signerWallet: keyWallet(signerAccount) }),
    ).rejects.toThrow(/does not match the registry's registerDigest/);
  });

  it("surfaces the contract's InvalidConsent revert, decoded, with a hint", async () => {
    const { strike, fake } = v3Chain({ revertRegister: "InvalidConsent" });
    const err = await strike
      .registerAgent({ signer: SIGNER, payout: ME, signerWallet: keyWallet(signerAccount) })
      .catch((e: unknown) => e);
    expect(explainError(err)).toMatch(
      new RegExp(`^InvalidConsent\\(${SIGNER}\\): v3: the signer's EIP-712 consent does not verify`),
    );
    expect(fake.sent).toEqual([]);
  });

  it("setSigner: self needs no consent; a new key consents with SetSigner", async () => {
    const { strike, fake } = v3Chain({ nonce: 2n });
    await strike.setSigner(7n, ME);
    const rot = await strike.setSigner(7n, SIGNER, { signerWallet: keyWallet(signerAccount) });
    expect(rot).toMatchObject({ agentId: 7n, signer: SIGNER });
    expect(fake.sent[0]?.args).toEqual([7n, ME, 0n, "0x"]);
    const [, , deadline, signature] = fake.sent[1]!.args as [bigint, Address, bigint, Hex];
    expect(await recoverAddress({ hash: setSignerDigest(ME, 7n, 2n, deadline), signature })).toBe(SIGNER);
    // The new signer's own client can make the consent too.
    const signerClient = createStrikeClient({
      publicClient: fake.client,
      walletClient: keyWallet(signerAccount),
      chainId: CHAIN,
      addresses: A,
    });
    const consent = await signerClient.signSetSignerConsent({ agentId: 7n });
    await strike.setSigner(7n, SIGNER, { consent });
    expect(fake.sent[2]?.args).toEqual([7n, SIGNER, consent.deadline, consent.signature]);
    await expect(strike.setSignerConsentTypedData({ agentId: 9n, signer: SIGNER })).rejects.toThrow(
      /agent #9 is not registered/,
    );
  });
});
