import {
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  getAddress,
  hashTypedData,
  parseEventLogs,
} from "viem";
import {
  agentRegistryAbi,
  agentRegistryV3Abi,
  blackScholesRefAbi,
  epochManagerAbi,
  feeManagerAbi,
  marketCalendarAbi,
  mirrorFeedAbi,
  optionTokenAbi,
  stockOracleAbi,
  strikeVaultAbi,
  vaultFactoryAbi,
} from "./abi/index.js";
import {
  type AgentRegistryDomain,
  DEFAULT_CONSENT_TTL,
  type RegisterConsentTypedData,
  type RegistryVersion,
  type SetSignerConsentTypedData,
  type SignerConsent,
  consentSignerOf,
  defaultAgentRegistryDomain,
  registerConsentTypedData,
  setSignerConsentTypedData,
} from "./consent.js";
import { deployments, getDeployment } from "./deployments.js";
import { StrikeError } from "./errors.js";
import { mandateProblems } from "./mandate.js";
import { agentStatusName, epochStateName, feedStatusName, mandateReasonName } from "./names.js";
import { roundStrikeToCent } from "./pricing.js";
import { type SeriesRisk, type SeriesRiskOptions, computeSeriesRisk } from "./risk.js";
import { type CorporateAction, type FeedRound, findSettlementHints } from "./settlement.js";
import type {
  AgentInfo,
  AgentRegistryParams,
  AgentStats,
  BuyQuote,
  BuyResult,
  Claimables,
  CreateVaultParams,
  CreateVaultResult,
  DeltaProposalParams,
  DeltaProposalPreview,
  Mandate,
  OracleStatus,
  ProposalParams,
  ProposalPreview,
  ProposeResult,
  QueueableTxResult,
  RedeemOptionsResult,
  RegisterAgentParams,
  RegisterAgentResult,
  SeriesState,
  SetSignerOptions,
  SetSignerResult,
  SettleResult,
  TxResult,
  VaultState,
} from "./types.js";
import { BPS } from "./units.js";

/** ERC-8056: when the pending UI multiplier takes effect. */
const erc8056EffectiveAtAbi = [
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** ERC-721 `ownerOf`, for ERC-8004 identities. */
const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Gas limit as a percentage of the node's estimate (see `execute`). */
const GAS_MARGIN_PCT = 125n;

/** Contract addresses the client talks to. */

export interface StrikeAddresses {
  epochManager: Address;
  agentRegistry: Address;
  stockOracle: Address;
  marketCalendar: Address;
  usdg: Address;
  optionToken: Address;
  feeManager: Address;
  vaultFactory: Address;
}

/** Options for {@link createStrikeClient}. */
export interface StrikeClientConfig {
  /** Reads (and receipts). */
  publicClient: PublicClient;
  /** Signs writes. It must carry an `account`. Omit for a read-only client. */
  walletClient?: WalletClient;
  chainId: number;
  /** Override (or supply) contract addresses; by default they come from the SDK's deployments map. */
  addresses?: Partial<StrikeAddresses>;
  /** Risk engine (IRiskEngine) for `seriesRisk`; by default the deployment map's `riskEngine`, when it has one. */
  riskEngine?: Address;
  /** RiskLens (v3) for `seriesRisk`; by default the deployment map's `riskLens`, when it has one. */
  riskLens?: Address;
  /**
   * The AgentRegistry's version. By default the deployment map's `version` when the registry is the map's own, else
   * read from the chain (a v3 registry answers `REGISTER_TYPEHASH()`).
   */
  registryVersion?: RegistryVersion;
}

/** The viem clients a Strike client uses. */
export interface StrikeViemClients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

const ADDRESS_KEYS = [
  "epochManager",
  "agentRegistry",
  "stockOracle",
  "marketCalendar",
  "usdg",
  "optionToken",
  "feeManager",
  "vaultFactory",
] as const satisfies readonly (keyof StrikeAddresses)[];

/** Contract addresses for a chain: the deployments map, with `overrides` on top. */
export function resolveAddresses(chainId: number, overrides: Partial<StrikeAddresses> = {}): StrikeAddresses {
  const complete = ADDRESS_KEYS.every((k) => overrides[k] !== undefined);
  const base: Partial<StrikeAddresses> = complete ? {} : getDeployment(chainId);
  const out = {} as StrikeAddresses;
  for (const k of ADDRESS_KEYS) {
    const value = overrides[k] ?? base[k];
    if (!value) throw new StrikeError(`missing ${k} address for chain ${chainId}`);
    out[k] = getAddress(value);
  }
  return out;
}

type WriteFn<abi extends Abi> = ContractFunctionName<abi, "nonpayable" | "payable">;
interface WriteCall<abi extends Abi, fn extends WriteFn<abi>> {
  address: Address;
  abi: abi;
  functionName: fn;
  args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
}

const WEEK = 7n * 86_400n;

function assertDeltaBps(bps: number): void {
  if (!Number.isInteger(bps) || bps <= 0 || bps >= BPS) {
    throw new StrikeError(`targetDeltaBps must be an integer between 1 and 9999, got ${bps}`);
  }
}

/**
 * Create a typed Strike client over viem.
 *
 * ```ts
 * const strike = createStrikeClient({ publicClient, walletClient, chainId: 46630 });
 * const vaults = await strike.listVaults();
 * ```
 *
 * Reads work with only a `publicClient`. Writes simulate first (so a revert surfaces as a decoded custom error
 * such as `MarketClosed`), send with `walletClient`, and wait for the receipt. Token approvals are automatic.
 */
export function createStrikeClient(config: StrikeClientConfig) {
  const { publicClient, walletClient, chainId } = config;
  const addresses = resolveAddresses(chainId, config.addresses);
  const em = addresses.epochManager;
  let usdgDecimalsCache: number | undefined;
  const deployment = (() => {
    try {
      return getDeployment(chainId);
    } catch {
      return undefined; // a chain outside the map (addresses passed in full)
    }
  })();
  const riskEngine = config.riskEngine ?? deployment?.riskEngine;
  const riskLens = config.riskLens ?? deployment?.riskLens;
  // The map's own record (no env override): which EpochManager carries which protocol version.
  const mapped = deployments[String(chainId)];
  const deployBlock = typeof deployment?.block === "number" ? BigInt(deployment.block) : 0n;

  function requireAccount(): { wallet: WalletClient; account: Account } {
    if (!walletClient)
      throw new StrikeError("this Strike client is read-only: pass a walletClient to send transactions");
    if (!walletClient.account) throw new StrikeError("the walletClient has no account");
    return { wallet: walletClient, account: walletClient.account };
  }

  /**
   * Simulate, send, and wait. Reverts surface from the simulation as decoded contract errors.
   *
   * The gas limit is the estimate plus a margin: the pricer's series expansions run a number of terms that depends
   * on the tenor, so the same call can cost more in the block it lands in, a second or more after the estimate.
   */
  async function execute<const abi extends Abi, fn extends WriteFn<abi>>(
    call: WriteCall<abi, fn>,
  ): Promise<TxResult> {
    const { wallet, account } = requireAccount();
    const { request } = await publicClient.simulateContract({ ...call, account } as never);
    const estimate = await publicClient.estimateContractGas({ ...call, account } as never);
    const gas = (estimate * GAS_MARGIN_PCT) / 100n;
    const hash: Hex = await wallet.writeContract({
      ...(request as object),
      gas,
      chain: wallet.chain ?? null,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      const outOfGas = receipt.gasUsed >= (gas * 99n) / 100n;
      throw new StrikeError(
        outOfGas
          ? `transaction ${hash} ran out of gas (used ${receipt.gasUsed} of ${gas})`
          : `transaction ${hash} reverted (gas used ${receipt.gasUsed} of ${gas})`,
      );
    }
    return { hash, receipt };
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    const { account } = requireAccount();
    const current = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (current >= amount) return;
    await execute({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  }

  async function blockTimestamp(): Promise<bigint> {
    return (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
  }

  async function usdgDecimals(): Promise<number> {
    usdgDecimalsCache ??= await publicClient.readContract({
      address: em,
      abi: epochManagerAbi,
      functionName: "usdgDecimals",
    });
    return usdgDecimalsCache;
  }

  async function tokenMeta(token: Address): Promise<{ symbol: string; decimals: number }> {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  }

  async function getSeries(seriesId: bigint): Promise<SeriesState | null> {
    const s = await publicClient.readContract({
      address: em,
      abi: epochManagerAbi,
      functionName: "getSeries",
      args: [seriesId],
    });
    if (s.vault === "0x0000000000000000000000000000000000000000") return null;
    return { id: seriesId, ...s };
  }

  async function getVault(vaultAddress: Address): Promise<VaultState> {
    const vault = getAddress(vaultAddress);
    const v = { address: vault, abi: strikeVaultAbi } as const;
    const [
      name,
      symbol,
      decimals,
      asset,
      underlying,
      isCall,
      premiumToken,
      totalAssets,
      totalSupply,
      depositCap,
      locked,
      currentEpoch,
      lastProcessedEpoch,
      pendingDepositAssets,
      pendingRedeemShares,
      cfg,
      epoch,
      compensation,
    ] = await Promise.all([
      publicClient.readContract({ ...v, functionName: "name" }),
      publicClient.readContract({ ...v, functionName: "symbol" }),
      publicClient.readContract({ ...v, functionName: "decimals" }),
      publicClient.readContract({ ...v, functionName: "asset" }),
      publicClient.readContract({ ...v, functionName: "underlying" }),
      publicClient.readContract({ ...v, functionName: "isCall" }),
      publicClient.readContract({ ...v, functionName: "premiumToken" }),
      publicClient.readContract({ ...v, functionName: "totalAssets" }),
      publicClient.readContract({ ...v, functionName: "totalSupply" }),
      publicClient.readContract({ ...v, functionName: "depositCap" }),
      publicClient.readContract({ ...v, functionName: "locked" }),
      publicClient.readContract({ ...v, functionName: "currentEpoch" }),
      publicClient.readContract({ ...v, functionName: "lastProcessedEpoch" }),
      publicClient.readContract({ ...v, functionName: "pendingDepositAssets" }),
      publicClient.readContract({ ...v, functionName: "pendingRedeemShares" }),
      publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "vaultConfig",
        args: [vault],
      }),
      publicClient.readContract({ address: em, abi: epochManagerAbi, functionName: "epochs", args: [vault] }),
      publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "compensation",
        args: [vault],
      }),
    ]);
    if (!cfg.registered) throw new StrikeError(`${vault} is not a registered Strike vault`);
    const [state, openedAt, seriesId] = epoch;
    const [assetMeta, underlyingMeta, underlyingCfg, pricePerShare, series] = await Promise.all([
      tokenMeta(asset),
      tokenMeta(underlying),
      publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "underlyings",
        args: [underlying],
      }),
      publicClient.readContract({ ...v, functionName: "convertToAssets", args: [10n ** BigInt(decimals)] }),
      seriesId === 0n ? Promise.resolve(null) : getSeries(seriesId),
    ]);
    return {
      address: vault,
      name,
      symbol,
      decimals,
      kind: isCall ? "covered-call" : "cash-secured-put",
      isCall,
      asset,
      assetSymbol: assetMeta.symbol,
      assetDecimals: assetMeta.decimals,
      underlying,
      underlyingSymbol: underlyingMeta.symbol,
      underlyingDecimals: underlyingMeta.decimals,
      premiumToken,
      totalAssets,
      totalSupply,
      pricePerShare,
      depositCap,
      locked,
      currentEpoch,
      lastProcessedEpoch,
      pendingDepositAssets,
      pendingRedeemShares,
      curator: cfg.curator,
      agentId: cfg.agentId,
      mandate: { ...cfg.mandate } satisfies Mandate,
      sigma: underlyingCfg[2],
      compensation,
      epoch: { state: epochStateName(state), openedAt, seriesId },
      series,
    };
  }

  async function vaultAddresses(): Promise<Address[]> {
    const count = await publicClient.readContract({
      address: em,
      abi: epochManagerAbi,
      functionName: "vaultCount",
    });
    return Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        publicClient.readContract({
          address: em,
          abi: epochManagerAbi,
          functionName: "allVaults",
          args: [BigInt(i)],
        }),
      ),
    );
  }

  async function previewProposal(vault: Address, p: ProposalParams): Promise<ProposalPreview> {
    const [code, fairValue, delta, capacity] = await publicClient.readContract({
      address: em,
      abi: epochManagerAbi,
      functionName: "previewProposal",
      args: [getAddress(vault), p.strike, p.expiry, p.size, p.premiumBps],
    });
    const reason = mandateReasonName(code);
    return { reason, reasonCode: code, accepted: reason === "None", fairValue, delta, capacity };
  }

  async function pricerStrikeForDelta(args: {
    spot: bigint;
    targetDelta: bigint;
    tenorSeconds: bigint;
    sigma: bigint;
    isCall: boolean;
  }): Promise<bigint> {
    const pricer = await publicClient.readContract({
      address: em,
      abi: epochManagerAbi,
      functionName: "pricer",
    });
    return publicClient.readContract({
      address: pricer,
      abi: blackScholesRefAbi,
      functionName: "strikeForDelta",
      args: [args.spot, args.targetDelta, args.tenorSeconds, args.sigma, args.isCall],
    });
  }

  async function solveStrike(vault: Address, p: { targetDeltaBps: number; expiry: bigint }): Promise<bigint> {
    assertDeltaBps(p.targetDeltaBps);
    const v = getAddress(vault);
    const [underlying, isCall, now, epoch, vcfg] = await Promise.all([
      publicClient.readContract({ address: v, abi: strikeVaultAbi, functionName: "underlying" }),
      publicClient.readContract({ address: v, abi: strikeVaultAbi, functionName: "isCall" }),
      blockTimestamp(),
      publicClient.readContract({ address: em, abi: epochManagerAbi, functionName: "epochs", args: [v] }),
      publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "vaultConfig",
        args: [v],
      }),
    ]);
    // While the epoch is Open the contract solves against the snapshot taken at open; otherwise use live values.
    let spotPrice: bigint;
    let sigma: bigint;
    if (epoch[0] === 1) {
      spotPrice = epoch[3];
      sigma = epoch[4];
    } else {
      const [live, cfg] = await Promise.all([
        publicClient.readContract({
          address: em,
          abi: epochManagerAbi,
          functionName: "spot",
          args: [underlying],
        }),
        publicClient.readContract({
          address: em,
          abi: epochManagerAbi,
          functionName: "underlyings",
          args: [underlying],
        }),
      ]);
      spotPrice = live;
      sigma = cfg[2];
    }
    const strike = await pricerStrikeForDelta({
      spot: spotPrice,
      targetDelta: BigInt(p.targetDeltaBps) * 10n ** 14n,
      tenorSeconds: p.expiry > now ? p.expiry - now : 1n,
      sigma,
      isCall,
    });
    return roundStrikeToCent(strike, isCall, p.targetDeltaBps, vcfg.mandate);
  }

  async function getAgent(agentId: bigint): Promise<AgentInfo> {
    const r = { address: addresses.agentRegistry, abi: agentRegistryAbi } as const;
    const [a, active, [settledEpochs, cumulativePnl]] = await Promise.all([
      publicClient.readContract({ ...r, functionName: "getAgent", args: [agentId] }),
      publicClient.readContract({ ...r, functionName: "isActive", args: [agentId] }),
      publicClient.readContract({ ...r, functionName: "track", args: [agentId] }),
    ]);
    return { agentId, ...a, status: agentStatusName(a.status), active, settledEpochs, cumulativePnl };
  }

  async function registryParams(): Promise<AgentRegistryParams> {
    const r = { address: addresses.agentRegistry, abi: agentRegistryAbi } as const;
    const [minBond, slashAmount, maxStrikes, unbondDelay, identityRegistry, reputationRegistry] =
      await Promise.all([
        publicClient.readContract({ ...r, functionName: "minBond" }),
        publicClient.readContract({ ...r, functionName: "slashAmount" }),
        publicClient.readContract({ ...r, functionName: "maxStrikes" }),
        publicClient.readContract({ ...r, functionName: "unbondDelay" }),
        publicClient.readContract({ ...r, functionName: "identityRegistry" }),
        publicClient.readContract({ ...r, functionName: "reputationRegistry" }),
      ]);
    return { minBond, slashAmount, maxStrikes, unbondDelay, identityRegistry, reputationRegistry };
  }

  // ------------------------------------------------------------------ registry version and signer consent (v3)

  let registryVersionCache: Promise<RegistryVersion> | undefined;
  let registryDomainCache: Promise<AgentRegistryDomain> | undefined;

  /** "v3" when the registry takes an EIP-712 signer consent on `register` and `setSigner`, else "v2". */
  function registryVersion(): Promise<RegistryVersion> {
    registryVersionCache ??= (async (): Promise<RegistryVersion> => {
      if (config.registryVersion) return config.registryVersion;
      const mappedVersion = mapped?.version;
      if (
        mapped &&
        (mappedVersion === "v2" || mappedVersion === "v3") &&
        getAddress(mapped.agentRegistry) === addresses.agentRegistry
      ) {
        return mappedVersion;
      }
      try {
        await publicClient.readContract({
          address: addresses.agentRegistry,
          abi: agentRegistryV3Abi,
          functionName: "REGISTER_TYPEHASH",
        });
        return "v3";
      } catch (err) {
        // A v2 registry has no such function: the call reverts or returns no data. Anything else is a real error.
        const missing =
          err instanceof BaseError &&
          err.walk(
            (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
          );
        if (missing) return "v2";
        throw err;
      }
    })();
    registryVersionCache.catch(() => (registryVersionCache = undefined));
    return registryVersionCache;
  }

  /** The registry's EIP-712 domain: `eip712Domain()` (EIP-5267), else the constructor's name and version. */
  function registryDomain(): Promise<AgentRegistryDomain> {
    registryDomainCache ??= (async () => {
      try {
        const [, name, version, domainChainId, verifyingContract] = await publicClient.readContract({
          address: addresses.agentRegistry,
          abi: agentRegistryV3Abi,
          functionName: "eip712Domain",
        });
        return {
          name,
          version,
          chainId: Number(domainChainId),
          verifyingContract: getAddress(verifyingContract),
        };
      } catch {
        return defaultAgentRegistryDomain(chainId, addresses.agentRegistry);
      }
    })();
    return registryDomainCache;
  }

  async function signerNonce(signer: Address): Promise<bigint> {
    return publicClient.readContract({
      address: addresses.agentRegistry,
      abi: agentRegistryV3Abi,
      functionName: "nonces",
      args: [signer],
    });
  }

  async function consentDeadline(deadline: bigint | undefined): Promise<bigint> {
    return deadline ?? (await blockTimestamp()) + DEFAULT_CONSENT_TTL;
  }

  async function requireV3(what: string): Promise<void> {
    if ((await registryVersion()) !== "v3") {
      throw new StrikeError(`${what}: this AgentRegistry is v2, which takes no signer consent`);
    }
  }

  /**
   * The `Register` typed data `signer` signs so that `owner` can register it, at the signer's current nonce. Checked
   * against the registry's own `registerDigest`, so a wallet is never asked to sign a message the contract would
   * not accept.
   */
  async function registerConsentData(p: {
    signer: Address;
    owner: Address;
    payout: Address;
    erc8004Id?: bigint;
    deadline?: bigint;
  }): Promise<RegisterConsentTypedData> {
    await requireV3("register consent");
    const signer = getAddress(p.signer);
    const owner = getAddress(p.owner);
    const payout = getAddress(p.payout);
    const erc8004Id = p.erc8004Id ?? 0n;
    const [domain, nonce, deadline] = await Promise.all([
      registryDomain(),
      signerNonce(signer),
      consentDeadline(p.deadline),
    ]);
    const typedData = registerConsentTypedData(domain, { owner, payout, erc8004Id, nonce, deadline });
    const onChain = await publicClient.readContract({
      address: addresses.agentRegistry,
      abi: agentRegistryV3Abi,
      functionName: "registerDigest",
      args: [signer, owner, payout, erc8004Id, deadline],
    });
    if (hashTypedData(typedData) !== onChain) {
      throw new StrikeError(
        `the Register typed data does not match the registry's registerDigest (domain ${domain.name} / ${domain.version} on chain ${domain.chainId})`,
      );
    }
    return typedData;
  }

  /** The `SetSigner` typed data `signer` signs to become agent `agentId`'s signer (checked against `setSignerDigest`). */
  async function setSignerConsentData(p: {
    agentId: bigint;
    signer: Address;
    deadline?: bigint;
  }): Promise<SetSignerConsentTypedData> {
    await requireV3("setSigner consent");
    const signer = getAddress(p.signer);
    const [domain, nonce, deadline, agent] = await Promise.all([
      registryDomain(),
      signerNonce(signer),
      consentDeadline(p.deadline),
      publicClient.readContract({
        address: addresses.agentRegistry,
        abi: agentRegistryV3Abi,
        functionName: "getAgent",
        args: [p.agentId],
      }),
    ]);
    if (agent.status === 0) throw new StrikeError(`agent #${p.agentId} is not registered`);
    const typedData = setSignerConsentTypedData(domain, {
      owner: agent.owner,
      agentId: p.agentId,
      nonce,
      deadline,
    });
    const onChain = await publicClient.readContract({
      address: addresses.agentRegistry,
      abi: agentRegistryV3Abi,
      functionName: "setSignerDigest",
      args: [signer, p.agentId, deadline],
    });
    if (hashTypedData(typedData) !== onChain) {
      throw new StrikeError(
        `the SetSigner typed data does not match the registry's setSignerDigest (domain ${domain.name} / ${domain.version} on chain ${domain.chainId})`,
      );
    }
    return typedData;
  }

  /** Sign `typedData` with `wallet`'s account (by default this client's wallet), which must be `signer`. */
  async function signConsent(
    typedData: RegisterConsentTypedData | SetSignerConsentTypedData,
    signer: Address,
    wallet: WalletClient | undefined,
  ): Promise<SignerConsent> {
    const w = wallet ?? requireAccount().wallet;
    if (!w.account) throw new StrikeError("the signer's walletClient has no account");
    if (getAddress(w.account.address) !== getAddress(signer)) {
      throw new StrikeError(`the consent must be signed by the signer ${signer}, not ${w.account.address}`);
    }
    const signature = await w.signTypedData({ ...typedData, account: w.account } as never);
    return { signature, deadline: typedData.message.deadline };
  }

  /**
   * The consent to send with a v3 `register` or `setSigner`: none when the signer is the sending wallet; else the
   * given signature (checked here: it must recover to the signer, unexpired) or one made by `signerWallet`.
   */
  async function consentFor(
    signer: Address,
    sender: Address,
    build: (deadline?: bigint) => Promise<RegisterConsentTypedData | SetSignerConsentTypedData>,
    opts: { consent?: SignerConsent; signerWallet?: WalletClient; deadline?: bigint },
  ): Promise<SignerConsent> {
    if (signer === sender) return { signature: "0x", deadline: 0n };
    if (opts.consent) {
      const typedData = await build(opts.consent.deadline);
      const now = await blockTimestamp();
      if (opts.consent.deadline < now) {
        throw new StrikeError(
          `the signer's consent expired at ${opts.consent.deadline} (latest block ${now}); ask the signer to sign again`,
        );
      }
      const recovered = await consentSignerOf(typedData, opts.consent.signature);
      if (recovered !== signer) {
        throw new StrikeError(
          `the consent signature ${recovered ? `was made by ${recovered}` : "is malformed"}, not by the signer ${signer} for this ${typedData.primaryType} message (owner ${typedData.message.owner}, nonce ${typedData.message.nonce}, deadline ${typedData.message.deadline}, chain ${typedData.domain.chainId}); the registry would revert InvalidConsent`,
        );
      }
      return opts.consent;
    }
    if (opts.signerWallet) return signConsent(await build(opts.deadline), signer, opts.signerWallet);
    throw new StrikeError(
      `this AgentRegistry is v3: the signer ${signer} is not the sending wallet ${sender}, so it must consent with an EIP-712 signature. Pass consent (from the signer's signRegisterConsent / signSetSignerConsent) or signerWallet`,
    );
  }

  function decodeProposal(tx: TxResult, vault: Address): ProposeResult {
    const logs = parseEventLogs({ abi: epochManagerAbi, logs: tx.receipt.logs }).filter(
      (l) => getAddress(l.address) === em,
    );
    for (const log of logs) {
      if (log.eventName === "SeriesProposed" && getAddress(log.args.vault) === vault) {
        const a = log.args;
        return {
          ...tx,
          accepted: true,
          reason: "None",
          epoch: a.epoch,
          strike: a.strike,
          expiry: a.expiry,
          size: a.size,
          premiumBps: a.premiumBps,
          seriesId: a.seriesId,
          fairValue: a.fairValue,
          delta: a.delta,
          slashed: 0n,
        };
      }
      if (log.eventName === "ProposalRejected" && getAddress(log.args.vault) === vault) {
        const a = log.args;
        return {
          ...tx,
          accepted: false,
          reason: mandateReasonName(a.reason),
          epoch: a.epoch,
          strike: a.strike,
          expiry: a.expiry,
          size: a.size,
          premiumBps: a.premiumBps,
          seriesId: null,
          fairValue: null,
          delta: null,
          slashed: a.slashed,
        };
      }
    }
    throw new StrikeError(`transaction ${tx.hash} emitted neither SeriesProposed nor ProposalRejected`);
  }

  /** Hints proving the settlement round for (token, expiry); see `findSettlementHints`. */
  async function settlementHintsFor(token: Address, expiry: bigint): Promise<bigint[]> {
    const cfg = await publicClient.readContract({
      address: addresses.stockOracle,
      abi: stockOracleAbi,
      functionName: "feedConfig",
      args: [getAddress(token)],
    });
    const feed = { address: cfg.feed, abi: mirrorFeedAbi } as const;
    const [roundId, answer, , updatedAt] = await publicClient.readContract({
      ...feed,
      functionName: "latestRoundData",
    });
    const latest: FeedRound = { roundId, answer, updatedAt };
    let action: CorporateAction | undefined;
    try {
      const effectiveAt = await publicClient.readContract({
        address: getAddress(token),
        abi: erc8056EffectiveAtAbi,
        functionName: "effectiveAt",
      });
      action = { effectiveAt, grace: BigInt(cfg.corporateActionGrace) };
    } catch {
      action = undefined; // a plain ERC-20: no corporate actions
    }
    return findSettlementHints(
      latest,
      async (id) => {
        try {
          const [rid, ans, , upd] = await publicClient.readContract({
            ...feed,
            functionName: "getRoundData",
            args: [id],
          });
          return upd === 0n ? null : { roundId: rid, answer: ans, updatedAt: upd };
        } catch {
          return null;
        }
      },
      expiry,
      action,
    );
  }

  async function settlementRoundFor(token: Address, expiry: bigint): Promise<bigint> {
    const hints = await settlementHintsFor(token, expiry);
    return hints[0] as bigint;
  }

  async function accountOr(account?: Address): Promise<Address> {
    if (account) return getAddress(account);
    return requireAccount().account.address;
  }

  return {
    chainId,
    addresses,
    /** The viem clients behind this Strike client. */
    viem: { publicClient, walletClient } as StrikeViemClients,

    // ------------------------------------------------------------------ reads

    /** Timestamp of the latest block (use this, not the wall clock: devnets warp time). */
    blockTimestamp,

    /** USDG decimals, as the EpochManager read them (cached). */
    usdgDecimals,

    /** Addresses of every registered vault, in creation order. */
    vaultAddresses,

    /** Full state of every registered vault. */
    async listVaults(): Promise<VaultState[]> {
      return Promise.all((await vaultAddresses()).map(getVault));
    },

    /** Full state of one vault: tokens, share price, lock, mandate, curator, agent, epoch and live series. */
    getVault,

    /** A series by id, or null if it does not exist. */
    getSeries,

    /**
     * USDG premium and vault collateral for buying `amount` options (underlying base units) of a series now.
     * The premium is oracle-anchored: fair value × the series' premium factor, at the oracle spot moved against the buyer by the token's `spotBufferBps`, never below intrinsic value.
     */
    async quoteBuy(seriesId: bigint, amount: bigint): Promise<BuyQuote> {
      const [premium, collateral] = await publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "quoteBuy",
        args: [seriesId, amount],
      });
      return { premium, collateral };
    },

    /** Seconds before expiry when a series stops selling (`EpochManager.saleCutoff`, 1 hour by default). */
    async saleCutoff(): Promise<number> {
      return publicClient.readContract({ address: em, abi: epochManagerAbi, functionName: "saleCutoff" });
    },

    /**
     * Ids of every series a vault has put on sale, newest first, from the EpochManager's `SeriesProposed` logs
     * (scanned from `fromBlock`, default 0). Finds settled series to redeem after the vault's epoch moved on.
     */
    async vaultSeriesIds(vault: Address, opts: { fromBlock?: bigint } = {}): Promise<bigint[]> {
      const logs = await publicClient.getContractEvents({
        address: em,
        abi: epochManagerAbi,
        eventName: "SeriesProposed",
        args: { vault: getAddress(vault) },
        fromBlock: opts.fromBlock ?? 0n,
        toBlock: "latest",
        strict: true,
      });
      return logs.map((l) => l.args.seriesId).reverse();
    },

    /**
     * Dry-run a proposal against the vault's mandate (`EpochManager.previewProposal`). Returns the verdict as a
     * `MandateGuard.Reason` name, the fair value and delta the contract measured, and the vault's capacity.
     * Reverts (as a decoded error) if the price feed is unsafe.
     */
    previewProposal,

    /**
     * Dry-run a delta proposal: solve the strike with the on-chain pricer exactly as `proposeByDelta` does (the
     * epoch's opening snapshot while it is Open, rounded to a cent toward the middle of the delta band), then preview it.
     */
    async previewProposeByDelta(vault: Address, p: DeltaProposalParams): Promise<DeltaProposalPreview> {
      const strike = await solveStrike(vault, p);
      const preview = await previewProposal(vault, {
        strike,
        expiry: p.expiry,
        size: p.size,
        premiumBps: p.premiumBps,
      });
      return { ...preview, strike };
    },

    /**
     * The strike `proposeByDelta` would use right now for `targetDeltaBps` (on-chain pricer; the opening snapshot's
     * spot and sigma while the epoch is Open; rounded to a cent toward the middle of the mandate's delta band).
     */
    solveStrike,

    /** Raw `IPricer.strikeForDelta` call on the EpochManager's pricer (all values WAD, tenor in seconds). */
    pricerStrikeForDelta,

    /**
     * Live risk of a series from the risk engine contract (IRiskEngine): greeks per option at the live spot and the
     * series' sigma (the epoch's opening sigma, and the current one when it differs), the vault's exposure
     * (−greeks × sold), the payout over a spot-shock grid (default −30%…+30% in 5% steps, as RiskLens) against the
     * locked collateral, and the implied volatility of the last buy. Expired series have zero greeks.
     */
    async seriesRisk(series: bigint | SeriesState, opts?: SeriesRiskOptions): Promise<SeriesRisk> {
      return computeSeriesRisk(
        {
          publicClient,
          epochManager: em,
          stockOracle: addresses.stockOracle,
          riskEngine: riskEngine ? getAddress(riskEngine) : undefined,
          riskLens: riskLens ? getAddress(riskLens) : undefined,
          mapped: mapped
            ? { epochManager: getAddress(mapped.epochManager), version: mapped.version }
            : undefined,
          fromBlock: deployBlock,
          chainId,
          blockTimestamp,
          usdgDecimals,
          getSeries,
        },
        series,
        opts,
      );
    },

    /** Current spot (WAD per raw token) after every SafeStockFeed check; reverts if the price is unsafe. */
    async spot(token: Address): Promise<bigint> {
      return publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "spot",
        args: [token],
      });
    },

    /** Non-reverting SafeStockFeed status of a token's price (`Ok`, `StalePrice`, `TokenPaused`, ...). */
    async oracleStatus(token: Address): Promise<OracleStatus> {
      const [code, price, updatedAt] = await publicClient.readContract({
        address: addresses.stockOracle,
        abi: stockOracleAbi,
        functionName: "status",
        args: [token],
      });
      const status = feedStatusName(code);
      return { status, ok: status === "Ok", price, updatedAt };
    },

    /** Whether the NYSE regular session is open at the latest block. */
    async marketOpen(): Promise<boolean> {
      return publicClient.readContract({
        address: addresses.stockOracle,
        abi: stockOracleAbi,
        functionName: "isMarketOpen",
      });
    },

    /**
     * The Friday 16:00 New York close of the week containing `at` (default: the latest block), or Thursday's
     * close when Friday is a holiday. Unix seconds.
     */
    async weeklyExpiry(at?: bigint): Promise<bigint> {
      return publicClient.readContract({
        address: addresses.marketCalendar,
        abi: marketCalendarAbi,
        functionName: "weeklyExpiry",
        args: [at ?? (await blockTimestamp())],
      });
    },

    /**
     * The nearest weekly expiry that is still ahead and, if a mandate is given, inside its tenor limits: this
     * week's close, else next week's. Null when neither fits.
     */
    async nextExpiry(mandate?: Mandate): Promise<bigint | null> {
      const now = await blockTimestamp();
      for (const at of [now, now + WEEK]) {
        const expiry = await publicClient.readContract({
          address: addresses.marketCalendar,
          abi: marketCalendarAbi,
          functionName: "weeklyExpiry",
          args: [at],
        });
        if (expiry <= now) continue;
        const tenor = expiry - now;
        if (mandate && (tenor < BigInt(mandate.minTenor) || tenor > BigInt(mandate.maxTenor))) continue;
        return expiry;
      }
      return null;
    },

    /** An agent's registry entry, whether it may propose now, and its on-chain track record (settled PnL). */
    getAgent,

    /** The agent id registered for a signer key (0n if none). */
    async agentOfSigner(signer: Address): Promise<bigint> {
      return publicClient.readContract({
        address: addresses.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "agentOfSigner",
        args: [getAddress(signer)],
      });
    },

    /** Bond, slash and strike parameters of the agent registry, and its ERC-8004 registries. */
    registryParams,

    /**
     * What joining costs: `minBond` (USDG an agent must keep bonded to propose), `slashAmount` (lost per rejected
     * proposal), `maxStrikes` (rejections that suspend it), plus the unbond delay and the ERC-8004 registries.
     * The same read as `registryParams`.
     */
    agentRegistryParams: registryParams,

    /**
     * The AgentRegistry's version: "v3" takes the signer's EIP-712 consent on `register` and `setSigner`, "v2" does
     * not. `registerAgent` and `setSigner` pick the right call on their own.
     */
    registryVersion,

    /** The AgentRegistry's EIP-712 domain (v3), from `eip712Domain()`. */
    agentRegistryDomain: registryDomain,

    /** The signer's next EIP-712 consent nonce on a v3 AgentRegistry (`nonces(signer)`). */
    consentNonce: (signer: Address) => signerNonce(getAddress(signer)),

    /**
     * v3: the EIP-712 `Register` typed data `signer` signs to consent to `register` by `owner` (default: this wallet),
     * at its current nonce, valid until `deadline` (default: one hour after the latest block). Checked against the
     * registry's `registerDigest`. Sign it with any EIP-712 wallet (wagmi `signTypedData`, `eth_signTypedData_v4`).
     */
    async registerConsentTypedData(p: {
      signer: Address;
      payout: Address;
      erc8004Id?: bigint;
      owner?: Address;
      deadline?: bigint;
    }): Promise<RegisterConsentTypedData> {
      return registerConsentData({ ...p, owner: await accountOr(p.owner) });
    },

    /**
     * v3, run by the signer: sign the `Register` consent that lets `owner` register this client's wallet (or
     * `signerWallet`) as an agent's signer. Hand the result to the owner's `registerAgent({ consent })`.
     */
    async signRegisterConsent(
      p: { owner: Address; payout: Address; erc8004Id?: bigint; deadline?: bigint },
      signerWallet?: WalletClient,
    ): Promise<SignerConsent> {
      const w = signerWallet ?? requireAccount().wallet;
      if (!w.account) throw new StrikeError("the signer's walletClient has no account");
      const signer = getAddress(w.account.address);
      return signConsent(await registerConsentData({ ...p, signer }), signer, w);
    },

    /** v3: the EIP-712 `SetSigner` typed data `signer` signs to become agent `agentId`'s signer. */
    async setSignerConsentTypedData(p: {
      agentId: bigint;
      signer: Address;
      deadline?: bigint;
    }): Promise<SetSignerConsentTypedData> {
      return setSignerConsentData(p);
    },

    /** v3, run by the new signer: sign the `SetSigner` consent for agent `agentId`. */
    async signSetSignerConsent(
      p: { agentId: bigint; deadline?: bigint },
      signerWallet?: WalletClient,
    ): Promise<SignerConsent> {
      const w = signerWallet ?? requireAccount().wallet;
      if (!w.account) throw new StrikeError("the signer's walletClient has no account");
      const signer = getAddress(w.account.address);
      return signConsent(await setSignerConsentData({ ...p, signer }), signer, w);
    },

    /**
     * Holder of an ERC-8004 identity on the registry the AgentRegistry checks (`ownerOf`). Null when the registry is
     * disabled (zero address: any id links unchecked) or the identity does not exist.
     */
    async identityOwner(erc8004Id: bigint): Promise<Address | null> {
      const registry = await publicClient.readContract({
        address: addresses.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "identityRegistry",
      });
      if (registry === ZERO_ADDRESS) return null;
      try {
        return await publicClient.readContract({
          address: registry,
          abi: ownerOfAbi,
          functionName: "ownerOf",
          args: [erc8004Id],
        });
      } catch {
        return null;
      }
    },

    /** Whether vaults may be created on a stock token (`EpochManager.underlyings(token).allowed`). */
    async isUnderlyingAllowed(token: Address): Promise<boolean> {
      const cfg = await publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "underlyings",
        args: [getAddress(token)],
      });
      return cfg[1];
    },

    /** Largest deposit cap a new vault may set (`VaultFactory.maxDepositCap`, collateral base units). */
    async maxDepositCap(): Promise<bigint> {
      return publicClient.readContract({
        address: addresses.vaultFactory,
        abi: vaultFactoryAbi,
        functionName: "maxDepositCap",
      });
    },

    /** An agent's registry entry, track record, remaining room before suspension, and claimable fees. */
    async agentStats(agentId: bigint): Promise<AgentStats> {
      const [agent, params] = await Promise.all([getAgent(agentId), registryParams()]);
      const claimableFees = await publicClient.readContract({
        address: addresses.feeManager,
        abi: feeManagerAbi,
        functionName: "claimable",
        args: [agent.payout],
      });
      const proposals = agent.accepted + agent.rejected;
      const strikesLeft = Math.max(params.maxStrikes - agent.strikes, 0);
      let byBond = Number.POSITIVE_INFINITY;
      if (agent.bond < params.minBond) byBond = 0;
      else if (params.slashAmount > 0n)
        byBond = Number((agent.bond - params.minBond) / params.slashAmount) + 1;
      return {
        ...agent,
        params,
        proposals,
        acceptanceRate: proposals === 0 ? null : agent.accepted / proposals,
        strikesLeft,
        rejectionsUntilInactive: agent.status === "Active" ? Math.min(strikesLeft, byBond) : 0,
        claimableFees,
      };
    },

    /** USDG premium `account` can claim from a vault. */
    async pendingPremium(vault: Address, account: Address): Promise<bigint> {
      return publicClient.readContract({
        address: getAddress(vault),
        abi: strikeVaultAbi,
        functionName: "pendingPremium",
        args: [getAddress(account)],
      });
    },

    /** Everything `account` can claim from a vault (default: the wallet's account). */
    async claimables(vault: Address, account?: Address): Promise<Claimables> {
      const who = await accountOr(account);
      const v = { address: getAddress(vault), abi: strikeVaultAbi } as const;
      const [premium, depositShares, redeemAssets, dep, red, shares] = await Promise.all([
        publicClient.readContract({ ...v, functionName: "pendingPremium", args: [who] }),
        publicClient.readContract({ ...v, functionName: "claimableDepositShares", args: [who] }),
        publicClient.readContract({ ...v, functionName: "claimableRedeemAssets", args: [who] }),
        publicClient.readContract({ ...v, functionName: "depositRequests", args: [who] }),
        publicClient.readContract({ ...v, functionName: "redeemRequests", args: [who] }),
        publicClient.readContract({ ...v, functionName: "balanceOf", args: [who] }),
      ]);
      return {
        premium,
        depositShares,
        redeemAssets,
        depositRequest: { epoch: dep[0], amount: dep[1] },
        redeemRequest: { epoch: red[0], amount: red[1] },
        shares,
      };
    },

    /** ERC-1155 option balance of `account` for a series. */
    async optionBalance(seriesId: bigint, account?: Address): Promise<bigint> {
      return publicClient.readContract({
        address: addresses.optionToken,
        abi: optionTokenAbi,
        functionName: "balanceOf",
        args: [await accountOr(account), seriesId],
      });
    },

    /** ERC-20 balance (USDG, a stock token, or vault shares). */
    async tokenBalance(token: Address, account?: Address): Promise<bigint> {
      return publicClient.readContract({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [await accountOr(account)],
      });
    },

    /**
     * The settlement round id for a token and expiry: the first feed round with `updatedAt >= expiry`, found by
     * walking back from `latestRoundData` on the feed registered in `StockOracle.feedConfig`.
     */
    findSettlementRound: settlementRoundFor,
    findSettlementHints: settlementHintsFor,

    // ------------------------------------------------------------------ writes (need walletClient)

    /**
     * Deposit `assets` (asset base units). Instant ERC-4626 deposit while the vault is unlocked; queued
     * (`requestDeposit`) while an epoch runs, claimable after settlement. Approves the vault if needed.
     */
    async deposit(
      vault: Address,
      assets: bigint,
      opts: { receiver?: Address } = {},
    ): Promise<QueueableTxResult> {
      const v = getAddress(vault);
      const receiver = await accountOr(opts.receiver);
      const [asset, locked] = await Promise.all([
        publicClient.readContract({ address: v, abi: strikeVaultAbi, functionName: "asset" }),
        publicClient.readContract({ address: v, abi: strikeVaultAbi, functionName: "locked" }),
      ]);
      await ensureAllowance(asset, v, assets);
      if (locked) {
        const tx = await execute({
          address: v,
          abi: strikeVaultAbi,
          functionName: "requestDeposit",
          args: [assets, receiver],
        });
        return { ...tx, queued: true };
      }
      const tx = await execute({
        address: v,
        abi: strikeVaultAbi,
        functionName: "deposit",
        args: [assets, receiver],
      });
      return { ...tx, queued: false };
    },

    /** Queue a deposit for the end of the running epoch (vault must be locked). Approves the vault if needed. */
    async requestDeposit(
      vault: Address,
      assets: bigint,
      opts: { receiver?: Address } = {},
    ): Promise<TxResult> {
      const v = getAddress(vault);
      const asset = await publicClient.readContract({
        address: v,
        abi: strikeVaultAbi,
        functionName: "asset",
      });
      await ensureAllowance(asset, v, assets);
      return execute({
        address: v,
        abi: strikeVaultAbi,
        functionName: "requestDeposit",
        args: [assets, await accountOr(opts.receiver)],
      });
    },

    /**
     * Redeem `shares`. Instant while the vault is unlocked; queued (`requestRedeem`) while an epoch runs,
     * claimable with `claimRedeem` after settlement.
     */
    async redeem(
      vault: Address,
      shares: bigint,
      opts: { receiver?: Address } = {},
    ): Promise<QueueableTxResult> {
      const v = getAddress(vault);
      const { account } = requireAccount();
      const locked = await publicClient.readContract({
        address: v,
        abi: strikeVaultAbi,
        functionName: "locked",
      });
      if (locked) {
        const tx = await execute({
          address: v,
          abi: strikeVaultAbi,
          functionName: "requestRedeem",
          args: [shares],
        });
        return { ...tx, queued: true };
      }
      const receiver = await accountOr(opts.receiver);
      const tx = await execute({
        address: v,
        abi: strikeVaultAbi,
        functionName: "redeem",
        args: [shares, receiver, account.address],
      });
      return { ...tx, queued: false };
    },

    /** Queue shares for redemption at the end of the running epoch (vault must be locked). */
    async requestRedeem(vault: Address, shares: bigint): Promise<TxResult> {
      return execute({
        address: getAddress(vault),
        abi: strikeVaultAbi,
        functionName: "requestRedeem",
        args: [shares],
      });
    },

    /** Move the shares of a processed deposit request to `account` (default: the wallet's account). */
    async claimDeposit(vault: Address, account?: Address): Promise<TxResult> {
      return execute({
        address: getAddress(vault),
        abi: strikeVaultAbi,
        functionName: "claimDeposit",
        args: [await accountOr(account)],
      });
    },

    /** Pay out a processed redemption to `account` (default: the wallet's account). */
    async claimRedeem(vault: Address, account?: Address): Promise<TxResult> {
      return execute({
        address: getAddress(vault),
        abi: strikeVaultAbi,
        functionName: "claimRedeem",
        args: [await accountOr(account)],
      });
    },

    /** Claim the wallet's accrued USDG premium from a vault. */
    async claimPremium(vault: Address): Promise<TxResult> {
      return execute({
        address: getAddress(vault),
        abi: strikeVaultAbi,
        functionName: "claimPremium",
        args: [],
      });
    },

    /**
     * Buy `amount` options (underlying base units). Quotes first, allows `slippageBps` on top of the quote
     * (default 100 = 1%) as `maxPremium`, and approves USDG to the EpochManager if needed.
     */
    async buy(
      seriesId: bigint,
      amount: bigint,
      opts: { slippageBps?: number; to?: Address } = {},
    ): Promise<BuyResult> {
      const slippageBps = BigInt(opts.slippageBps ?? 100);
      const [quoted] = await publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "quoteBuy",
        args: [seriesId, amount],
      });
      const maxPremium = quoted + (quoted * slippageBps + BigInt(BPS) - 1n) / BigInt(BPS);
      await ensureAllowance(addresses.usdg, em, maxPremium);
      const to = await accountOr(opts.to);
      const tx = await execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "buy",
        args: [seriesId, amount, maxPremium, to],
      });
      const bought = parseEventLogs({
        abi: epochManagerAbi,
        logs: tx.receipt.logs,
        eventName: "OptionsBought",
      })[0];
      return { ...tx, seriesId, amount, premium: bought?.args.premium ?? quoted };
    },

    /** Open the vault's weekly epoch (vault agent's signer or a keeper; market open, feed safe). Locks the vault. */
    async openEpoch(vault: Address): Promise<TxResult> {
      return execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "openEpoch",
        args: [getAddress(vault)],
      });
    },

    /**
     * Propose this epoch's series with an explicit strike (vault agent's signer). A proposal outside the mandate
     * does not revert: it is rejected, the agent's bond is slashed, and the result has `accepted: false`, the
     * reason and the slashed amount. Dry-run with `previewProposal` first.
     */
    async proposeSeries(vault: Address, p: ProposalParams): Promise<ProposeResult> {
      const v = getAddress(vault);
      const tx = await execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "proposeSeries",
        args: [v, p.strike, p.expiry, p.size, p.premiumBps],
      });
      return decodeProposal(tx, v);
    },

    /**
     * Propose by target delta: the contract solves the strike at the epoch's opening snapshot (rounded to a cent toward the band's middle), so the
     * intended delta survives spot moves while the transaction is pending. Same rejection and slashing rules as
     * `proposeSeries`; dry-run with `previewProposeByDelta` first.
     */
    async proposeByDelta(vault: Address, p: DeltaProposalParams): Promise<ProposeResult> {
      assertDeltaBps(p.targetDeltaBps);
      const v = getAddress(vault);
      const tx = await execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "proposeByDelta",
        args: [v, p.targetDeltaBps, p.expiry, p.size, p.premiumBps],
      });
      return decodeProposal(tx, v);
    },

    /**
     * Settle the vault's expired series and close the epoch (anyone may call). The settlement round (first feed
     * round at or after expiry) is discovered automatically unless `roundId` is given; nothing-sold series settle
     * without a price.
     */
    async settle(vault: Address, opts: { roundId?: bigint } = {}): Promise<SettleResult> {
      const v = getAddress(vault);
      const [state, , seriesId] = await publicClient.readContract({
        address: em,
        abi: epochManagerAbi,
        functionName: "epochs",
        args: [v],
      });
      if (epochStateName(state) !== "Selling") {
        throw new StrikeError(`vault ${v} has no live series to settle (epoch is ${epochStateName(state)})`);
      }
      const series = await getSeries(seriesId);
      if (!series) throw new StrikeError(`series ${seriesId} not found`);
      const now = await blockTimestamp();
      if (now < series.expiry) {
        throw new StrikeError(
          `series expires at ${series.expiry} (in ${series.expiry - now}s); settle after expiry`,
        );
      }
      let roundId = opts.roundId ?? 0n;
      if (opts.roundId === undefined && series.sold > 0n) {
        const recorded = await publicClient.readContract({
          address: addresses.stockOracle,
          abi: stockOracleAbi,
          functionName: "settlementPrice",
          args: [series.underlying, series.expiry],
        });
        if (recorded === 0n) {
          const hints = await settlementHintsFor(series.underlying, series.expiry);
          roundId = hints[0] as bigint;
          // A phase change or a corporate action needs more than one round of proof: record the price first.
          if (hints.length > 1) {
            await execute({
              address: addresses.stockOracle,
              abi: stockOracleAbi,
              functionName: "recordSettlementPriceWithHints",
              args: [series.underlying, series.expiry, hints],
            });
          }
        }
      }
      const tx = await execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "settle",
        args: [v, roundId],
      });
      const settled = parseEventLogs({
        abi: epochManagerAbi,
        logs: tx.receipt.logs,
        eventName: "EpochSettled",
      })[0];
      if (!settled) throw new StrikeError(`transaction ${tx.hash} emitted no EpochSettled event`);
      const a = settled.args;
      return {
        ...tx,
        seriesId,
        epoch: a.epoch,
        roundId,
        settlementPrice: a.settlementPrice,
        payout: a.payout,
        premium: a.premium,
        fee: a.fee,
      };
    },

    /**
     * Burn settled (or cancelled) options and receive the payout (or the premium refund). `amount` defaults to
     * the wallet's whole balance of the series.
     */
    async redeemOptions(
      seriesId: bigint,
      opts: { amount?: bigint; to?: Address } = {},
    ): Promise<RedeemOptionsResult> {
      const { account } = requireAccount();
      const amount =
        opts.amount ??
        (await publicClient.readContract({
          address: addresses.optionToken,
          abi: optionTokenAbi,
          functionName: "balanceOf",
          args: [account.address, seriesId],
        }));
      if (amount === 0n) throw new StrikeError(`no options of series ${seriesId} to redeem`);
      const tx = await execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "redeem",
        args: [seriesId, amount, await accountOr(opts.to)],
      });
      const ev = parseEventLogs({
        abi: epochManagerAbi,
        logs: tx.receipt.logs,
        eventName: "OptionsRedeemed",
      })[0];
      return { ...tx, amount, paid: ev?.args.paid ?? 0n };
    },

    /** Close an Open epoch that has no series (anyone after `proposalTimeout`; the curator or admin at any time). */
    async abortEpoch(vault: Address): Promise<TxResult> {
      return execute({
        address: em,
        abi: epochManagerAbi,
        functionName: "abortEpoch",
        args: [getAddress(vault)],
      });
    },

    // ------------------------------------------------------------------ joining as an agent

    /**
     * Register an agent (`AgentRegistry.register`); the wallet becomes its owner. One agent per signer: a taken
     * signer reverts `SignerTaken`. With an `erc8004Id`, the wallet must own that identity (`NotIdentityOwner`).
     * The agent starts unbonded: it cannot propose until `postBond` brings its bond to `minBond`.
     */
    async registerAgent(p: RegisterAgentParams): Promise<RegisterAgentResult> {
      const { account } = requireAccount();
      const signer = getAddress(p.signer);
      const payout = getAddress(p.payout);
      const erc8004Id = p.erc8004Id ?? 0n;
      const tx =
        (await registryVersion()) === "v3"
          ? await (async () => {
              const owner = getAddress(account.address);
              const consent = await consentFor(
                signer,
                owner,
                (deadline) => registerConsentData({ signer, owner, payout, erc8004Id, deadline }),
                p,
              );
              return execute({
                address: addresses.agentRegistry,
                abi: agentRegistryV3Abi,
                functionName: "register",
                args: [signer, payout, erc8004Id, consent.deadline, consent.signature],
              });
            })()
          : await execute({
              address: addresses.agentRegistry,
              abi: agentRegistryAbi,
              functionName: "register",
              args: [signer, payout, erc8004Id],
            });
      const ev = parseEventLogs({
        abi: agentRegistryAbi,
        logs: tx.receipt.logs,
        eventName: "AgentRegistered",
      }).find((l) => getAddress(l.address) === addresses.agentRegistry);
      if (!ev) throw new StrikeError(`transaction ${tx.hash} emitted no AgentRegistered event`);
      const a = ev.args;
      return { ...tx, agentId: a.agentId, owner: a.owner, signer: a.signer, erc8004Id: a.erc8004Id };
    },

    /**
     * Rotate an agent's signer key (`AgentRegistry.setSigner`; only the agent's owner). The new key must be free (one
     * agent per signer). On a v3 registry a new signer that is not the sending wallet consents with an EIP-712
     * `SetSigner` signature: pass `consent` (from its `signSetSignerConsent`) or `signerWallet`.
     */
    async setSigner(agentId: bigint, signer: Address, opts: SetSignerOptions = {}): Promise<SetSignerResult> {
      const { account } = requireAccount();
      const newSigner = getAddress(signer);
      const tx =
        (await registryVersion()) === "v3"
          ? await (async () => {
              const consent = await consentFor(
                newSigner,
                getAddress(account.address),
                (deadline) => setSignerConsentData({ agentId, signer: newSigner, deadline }),
                opts,
              );
              return execute({
                address: addresses.agentRegistry,
                abi: agentRegistryV3Abi,
                functionName: "setSigner",
                args: [agentId, newSigner, consent.deadline, consent.signature],
              });
            })()
          : await execute({
              address: addresses.agentRegistry,
              abi: agentRegistryAbi,
              functionName: "setSigner",
              args: [agentId, newSigner],
            });
      const ev = parseEventLogs({
        abi: agentRegistryAbi,
        logs: tx.receipt.logs,
        eventName: "SignerSet",
      }).find((l) => getAddress(l.address) === addresses.agentRegistry);
      if (!ev) throw new StrikeError(`transaction ${tx.hash} emitted no SignerSet event`);
      return { ...tx, agentId: ev.args.agentId, signer: ev.args.signer };
    },

    /**
     * Add `amount` USDG (base units) to an agent's bond (`AgentRegistry.postBond`; anyone may top up any agent).
     * Approves USDG to the registry if needed. The bond is slashable: `slashAmount` per rejected proposal.
     */
    async postBond(agentId: bigint, amount: bigint): Promise<TxResult> {
      if (amount <= 0n) throw new StrikeError("bond amount must be positive");
      await ensureAllowance(addresses.usdg, addresses.agentRegistry, amount);
      return execute({
        address: addresses.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "postBond",
        args: [agentId, amount],
      });
    },

    /**
     * Create a vault (`VaultFactory.createVault`); the wallet becomes its curator and `agentId`'s signer runs its
     * epochs. The mandate is checked against the protocol's floors first (`mandateProblems`: premium at least 90%
     * of fair value, tenor at most 35 days, ...), and the agent must exist, so a bad vault is never deployed.
     */
    async createVault(p: CreateVaultParams): Promise<CreateVaultResult> {
      const problems = mandateProblems(p.mandate);
      if (problems.length > 0) throw new StrikeError(`invalid mandate: ${problems.join("; ")}`);
      if ((await getAgent(p.agentId)).status === "None") {
        throw new StrikeError(`agent #${p.agentId} is not registered`);
      }
      const tx = await execute({
        address: addresses.vaultFactory,
        abi: vaultFactoryAbi,
        functionName: "createVault",
        args: [
          {
            underlying: getAddress(p.underlying),
            isCall: p.isCall,
            agentId: p.agentId,
            depositCap: p.depositCap,
            name: p.name,
            symbol: p.symbol,
            mandate: p.mandate,
          },
        ],
      });
      const ev = parseEventLogs({
        abi: vaultFactoryAbi,
        logs: tx.receipt.logs,
        eventName: "VaultCreated",
      }).find((l) => getAddress(l.address) === addresses.vaultFactory);
      if (!ev) throw new StrikeError(`transaction ${tx.hash} emitted no VaultCreated event`);
      return { ...tx, vault: ev.args.vault, curator: ev.args.curator, agentId: ev.args.agentId };
    },
  };
}

/** A Strike client (see {@link createStrikeClient}). */
export type StrikeClient = ReturnType<typeof createStrikeClient>;
