import { type Address, type Hex, getAddress, recoverTypedDataAddress } from "viem";

/**
 * v3's AgentRegistry makes a signer key consent before it is bound to an agent, so nobody can register someone
 * else's address as their signer and block it ("one agent per signer"). The consent is an EIP-712 signature by the
 * signer over `Register` (for `register`) or `SetSigner` (for `setSigner`), at the signer's next nonce
 * (`nonces(signer)`) and valid until `deadline`. A signer that is the sending wallet itself needs no consent (the
 * contract skips the check, so pass deadline 0 and empty bytes). v2's registry has no consent and takes
 * `register(signer, payout, erc8004Id)` and `setSigner(agentId, signer)`.
 */

/** Protocol version of an AgentRegistry: "v2" (no consent) or "v3" (EIP-712 signer consent). */
export type RegistryVersion = "v2" | "v3";

/** The registry's EIP-712 name and version (`EIP712("Strike AgentRegistry", "1")` in the v3 constructor). */
export const AGENT_REGISTRY_EIP712 = { name: "Strike AgentRegistry", version: "1" } as const;

/** `Register(address owner,address payout,uint256 erc8004Id,uint256 nonce,uint256 deadline)` */
export const REGISTER_CONSENT_TYPES = {
  Register: [
    { name: "owner", type: "address" },
    { name: "payout", type: "address" },
    { name: "erc8004Id", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** `SetSigner(address owner,uint256 agentId,uint256 nonce,uint256 deadline)` */
export const SET_SIGNER_CONSENT_TYPES = {
  SetSigner: [
    { name: "owner", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** How long a consent the SDK asks for stays valid by default: one hour after the latest block. */
export const DEFAULT_CONSENT_TTL = 3_600n;

/** The EIP-712 domain of an AgentRegistry. */
export interface AgentRegistryDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/** The domain the v3 constructor sets, for when `eip712Domain()` (EIP-5267) cannot be read. */
export function defaultAgentRegistryDomain(chainId: number, registry: Address): AgentRegistryDomain {
  return { ...AGENT_REGISTRY_EIP712, chainId, verifyingContract: getAddress(registry) };
}

/** What a signer consents to with `Register`: being the signer of a new agent `owner` registers. */
export interface RegisterConsentMessage {
  /** The wallet that will send `register` (the agent's owner). */
  owner: Address;
  payout: Address;
  erc8004Id: bigint;
  /** `nonces(signer)` when `register` is sent. */
  nonce: bigint;
  deadline: bigint;
}

/** What a signer consents to with `SetSigner`: becoming the signer of agent `agentId`, owned by `owner`. */
export interface SetSignerConsentMessage {
  owner: Address;
  agentId: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** EIP-712 typed data for a `Register` consent, ready for `signTypedData` (viem, wagmi or `eth_signTypedData_v4`). */
export function registerConsentTypedData(domain: AgentRegistryDomain, message: RegisterConsentMessage) {
  return {
    domain,
    types: REGISTER_CONSENT_TYPES,
    primaryType: "Register",
    message: {
      owner: getAddress(message.owner),
      payout: getAddress(message.payout),
      erc8004Id: message.erc8004Id,
      nonce: message.nonce,
      deadline: message.deadline,
    },
  } as const;
}

/** EIP-712 typed data for a `SetSigner` consent. */
export function setSignerConsentTypedData(domain: AgentRegistryDomain, message: SetSignerConsentMessage) {
  return {
    domain,
    types: SET_SIGNER_CONSENT_TYPES,
    primaryType: "SetSigner",
    message: {
      owner: getAddress(message.owner),
      agentId: message.agentId,
      nonce: message.nonce,
      deadline: message.deadline,
    },
  } as const;
}

export type RegisterConsentTypedData = ReturnType<typeof registerConsentTypedData>;
export type SetSignerConsentTypedData = ReturnType<typeof setSignerConsentTypedData>;

/** A signer's consent: the EIP-712 signature and the deadline it signed. */
export interface SignerConsent {
  signature: Hex;
  deadline: bigint;
}

/** The address that signed `typedData`, or null when the signature is malformed. */
export async function consentSignerOf(
  typedData: RegisterConsentTypedData | SetSignerConsentTypedData,
  signature: Hex,
): Promise<Address | null> {
  try {
    return getAddress(await recoverTypedDataAddress({ ...typedData, signature } as never));
  } catch {
    return null;
  }
}
