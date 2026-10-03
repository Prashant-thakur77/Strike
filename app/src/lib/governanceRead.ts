import "server-only";
import { createPublicClient, parseAbi, type Address, type PublicClient } from "viem";
import { scanLogs } from "./activity";
import { getAppChain } from "./chains";
import {
  ACTION_LIMIT,
  ADMIN_EVENTS,
  GOV_CHAIN_NAMES,
  GOV_EXPLORERS,
  KIND_ROLES,
  ROLE_HASH,
  type AdminLog,
  type GovActionJson,
  type GovChainId,
  type GovContract,
  type GovContractJson,
  type GovDeploymentJson,
  type GovDeploymentRecord,
  type GovernanceJson,
  type GovRoleJson,
  type RoleEvent,
  deploymentContracts,
  deploymentKeyOf,
  describeAction,
  everGranted,
  govDeploymentsOn,
  groupActions,
  holdersFromEvents,
  labelBook,
  labelOf,
  nameFrom,
  roleFreeContracts,
  roleInfo,
  roleName,
  sharedWith,
} from "./governance";
import { serverReadTransport } from "./rpc/server";
import { USAGE_MAX_RANGE } from "./usage/scan";

// Server side of /app/governance: per chain, every Strike contract's RoleGranted/RoleRevoked logs and admin setter
// events since the deployment block (chunked by scanLogs, Alchemy first when the server has a key), each holder the
// logs leave confirmed with `hasRole` at the same head, the UsdgDrip's `owner()`, and the last admin actions with
// their block time and sender. /api/governance serves `readGovernance()` through a cache.

const EVENTS = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event UnderlyingSet(address indexed token, bool allowed)",
  "event OracleSet(address oracle)",
  "event SigmaSet(address indexed token, uint64 sigma, uint64 minSigma, uint64 maxSigma)",
  "event SpotBufferSet(address indexed token, uint16 bps)",
  "event PricerSet(address pricer)",
  "event FeeManagerSet(address feeManager)",
  "event TimingsSet(uint32 proposalTimeout, uint32 saleCutoff, uint32 settlementGrace)",
  "event FeedSet(address indexed token, address feed, uint32 maxPriceAge, uint32 corporateActionGrace)",
  "event CalendarSet(address calendar)",
  "event SequencerFeedSet(address feed, uint32 grace)",
  "event StatusSet(uint256 indexed agentId, uint8 status)",
  "event ParamsSet(uint256 minBond, uint256 slashAmount, uint32 maxStrikes, uint32 unbondDelay)",
  "event IdentityRegistrySet(address registry)",
  "event ReputationRegistrySet(address registry)",
  "event FeesSet(uint16 perfFeeBps, uint16 agentShareBps)",
  "event TreasurySet(address indexed treasury)",
  "event HolidaySet(uint256 indexed day, bool closed)",
  "event EarlyCloseSet(uint256 indexed day, bool early)",
  "event ManagerSet(address indexed manager)",
  "event MaxDepositCapSet(uint256 maxDepositCap)",
  "event Refilled(address indexed from, uint256 amount)",
  "event Swept(address indexed to, uint256 amount)",
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
]);

const READS = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function owner() view returns (address)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);

/** IAccessControl's ERC-165 id. */
const IACCESS_CONTROL = "0x7965db0b";
const MULTICALL_BATCH = 16_384;

const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

type DecodedLog = {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
};

/** Every admin and role log of `addresses` from `from` to `to`. */
async function adminLogs(client: PublicClient, addresses: Address[], from: bigint, to: bigint) {
  const raw = await scanLogs<DecodedLog>({
    from,
    to,
    maxRange: USAGE_MAX_RANGE,
    fetchLogs: async (fromBlock, toBlock) =>
      (await client.getLogs({
        address: addresses,
        events: EVENTS,
        fromBlock,
        toBlock,
        strict: true,
      })) as unknown as DecodedLog[],
  });
  return raw.map((l): AdminLog => ({
    contract: l.address,
    eventName: l.eventName,
    args: l.args,
    tx: l.transactionHash,
    block: Number(l.blockNumber),
    logIndex: l.logIndex,
  }));
}

/** The contracts of a deployment that exist as listed: probed stock tokens kept only when they are AccessControl. */
async function liveContracts(client: PublicClient, d: GovDeploymentRecord): Promise<GovContract[]> {
  const all = deploymentContracts(d);
  const probes = all.filter((c) => c.probe);
  const answers = probes.length
    ? await client.multicall({
        contracts: probes.map((c) => ({
          address: c.address as Address,
          abi: READS,
          functionName: "supportsInterface" as const,
          args: [IACCESS_CONTROL] as const,
        })),
        allowFailure: true,
      })
    : [];
  const ok = new Set(
    probes
      .filter((_, i) => answers[i]?.status === "success" && answers[i]?.result === true)
      .map((c) => c.address),
  );
  return all.filter((c) => !c.probe || ok.has(c.address));
}

async function readDeployment(
  client: PublicClient,
  chainId: GovChainId,
  d: GovDeploymentRecord,
  logs: AdminLog[],
  head: bigint,
): Promise<GovDeploymentJson> {
  const book = labelBook(chainId);
  const name = nameFrom(book);
  const contracts = await liveContracts(client, d);
  const mine = new Set(contracts.map((c) => c.address.toLowerCase()));
  const myLogs = logs.filter((l) => mine.has(l.contract.toLowerCase()));

  const roleEvents: RoleEvent[] = myLogs
    .filter((l) => l.eventName === "RoleGranted" || l.eventName === "RoleRevoked")
    .map((l) => ({
      contract: l.contract,
      role: String(l.args.role),
      account: String(l.args.account),
      sender: String(l.args.sender),
      granted: l.eventName === "RoleGranted",
      tx: l.tx,
      block: l.block,
      logIndex: l.logIndex,
    }));
  const fromLogs = holdersFromEvents(roleEvents);

  // Candidates per (contract, role): everyone the logs ever granted it, plus the team's keys and this deployment's
  // contracts, so a holder whose grant log was missed still shows. Each one is asked `hasRole` at the same head.
  const teamKeys = [...book.entries()].filter(([, l]) => l.kind !== "contract").map(([a]) => a);
  const ownContracts = contracts.map((c) => c.address.toLowerCase());
  type Probe = { contract: GovContract; role: string; hash: string; account: string };
  const probes: Probe[] = [];
  const roleSlots: { contract: GovContract; role: string; hash: string | null }[] = [];
  for (const c of contracts) {
    const granted = everGranted(roleEvents, c.address);
    const known = KIND_ROLES[c.kind]
      .filter((r) => r !== "owner")
      .map((r) => ROLE_HASH[r as keyof typeof ROLE_HASH]);
    const hashes = [...new Set<string>([...known, ...granted.keys()])];
    for (const hash of hashes) {
      roleSlots.push({ contract: c, role: roleName(hash), hash });
      const cands = new Set<string>([...(granted.get(hash) ?? []), ...teamKeys, ...ownContracts]);
      for (const account of cands) probes.push({ contract: c, role: roleName(hash), hash, account });
    }
    if (KIND_ROLES[c.kind].includes("owner")) roleSlots.push({ contract: c, role: "owner", hash: null });
  }
  const answers = await client.multicall({
    contracts: probes.map((p) => ({
      address: p.contract.address as Address,
      abi: READS,
      functionName: "hasRole" as const,
      args: [p.hash as `0x${string}`, p.account as Address] as const,
    })),
    allowFailure: true,
    batchSize: MULTICALL_BATCH,
    blockNumber: head,
  });
  const failed = answers.filter((a) => a.status !== "success").length;
  if (failed === answers.length && answers.length) throw new Error("every hasRole call failed");

  const confirmed = new Map<string, Set<string>>();
  probes.forEach((p, i) => {
    const a = answers[i];
    if (a?.status === "success" && a.result === true) {
      const k = `${p.contract.address.toLowerCase()}:${p.hash}`;
      const s = confirmed.get(k) ?? new Set<string>();
      s.add(p.account.toLowerCase());
      confirmed.set(k, s);
    }
  });

  // Ownable owners.
  const owned = contracts.filter((c) => KIND_ROLES[c.kind].includes("owner"));
  const owners = await Promise.all(
    owned.map((c) =>
      client
        .readContract({ address: c.address as Address, abi: READS, functionName: "owner", blockNumber: head })
        .then((o) => o.toLowerCase())
        .catch(() => null),
    ),
  );

  const warnings: string[] = [];
  const unknown: GovDeploymentJson["unknown"] = [];
  const byContract = new Map<string, GovRoleJson[]>();
  for (const slot of roleSlots) {
    const c = slot.contract;
    const info = roleInfo(c.kind, slot.role);
    let holders: string[];
    let grants = new Map<string, { tx: string; block: number }>();
    if (slot.hash === null) {
      const owner = owners[owned.indexOf(c)];
      holders = owner ? [owner] : [];
      const last = myLogs
        .filter(
          (l) =>
            l.contract.toLowerCase() === c.address.toLowerCase() &&
            l.eventName === "OwnershipTransferred" &&
            String(l.args.newOwner).toLowerCase() === owner,
        )
        .at(-1);
      if (owner && last) grants = new Map([[owner, { tx: last.tx, block: last.block }]]);
      if (!owner) warnings.push(`${c.name}: owner() could not be read`);
    } else {
      const set = confirmed.get(`${c.address.toLowerCase()}:${slot.hash}`) ?? new Set<string>();
      holders = [...set];
      grants = fromLogs.get(c.address.toLowerCase())?.get(slot.hash) ?? new Map();
      for (const a of grants.keys()) {
        if (!set.has(a))
          warnings.push(`${c.name} ${slot.role}: the logs leave ${a} as a holder, hasRole says no`);
      }
    }
    const roleJson: GovRoleJson = {
      role: slot.role,
      hash: slot.hash,
      can: info.can,
      cannot: info.cannot,
      source: info.source,
      holders: holders
        .map((address) => {
          const l = labelOf(book, address);
          const g = grants.get(address);
          if (l.kind === "unknown")
            unknown.push({ contractName: c.name, address: c.address, role: slot.role, holder: address });
          return {
            address,
            label: l.label,
            kind: l.kind,
            grantTx: g?.tx ?? null,
            grantBlock: g?.block ?? null,
          };
        })
        .sort((a, b) => (a.grantBlock ?? 0) - (b.grantBlock ?? 0)),
    };
    const list = byContract.get(c.address) ?? [];
    list.push(roleJson);
    byContract.set(c.address, list);
  }

  const contractsJson: GovContractJson[] = contracts.map((c) => ({
    name: c.name,
    kind: c.kind,
    address: c.address,
    sharedWith: sharedWith(d, c.address),
    roles: byContract.get(c.address) ?? [],
  }));

  // The last admin actions, with their block time and sender.
  const kindOf = new Map(contracts.map((c) => [c.address.toLowerCase(), c]));
  const listed = myLogs.filter((l) => {
    const c = kindOf.get(l.contract.toLowerCase());
    return c ? ADMIN_EVENTS[c.kind].includes(l.eventName) : false;
  });
  const groups = groupActions(listed);
  const top = groups.slice(0, ACTION_LIMIT);
  const blocks = [...new Set(top.map((g) => g.block))];
  const txs = [...new Set(top.map((g) => g.tx))];
  const [times, senders] = await Promise.all([
    Promise.all(
      blocks.map((b) =>
        client
          .getBlock({ blockNumber: BigInt(b) })
          .then((x) => Number(x.timestamp))
          .catch(() => null),
      ),
    ),
    Promise.all(
      txs.map((h) =>
        client
          .getTransaction({ hash: h as `0x${string}` })
          .then((x) => x.from.toLowerCase())
          .catch(() => null),
      ),
    ),
  ]);
  const actions: GovActionJson[] = top.map((g) => {
    const c = kindOf.get(g.contract.toLowerCase())!;
    const first = describeAction(g.eventName, g.logs[0]!.args, name);
    const from = senders[txs.indexOf(g.tx)] ?? null;
    return {
      contract: c.address,
      contractName: c.name,
      event: g.eventName,
      summary:
        g.logs.length > 1
          ? `${first} and ${g.logs.length - 1} more ${g.eventName} in the same transaction`
          : first,
      count: g.logs.length,
      tx: g.tx,
      block: g.block,
      timestamp: times[blocks.indexOf(g.block)] ?? null,
      from,
      fromLabel: from ? labelOf(book, from).label : null,
    };
  });

  return {
    key: deploymentKeyOf(d),
    version: d.version ?? "v?",
    deployBlock: d.block ?? 0,
    head: Number(head),
    deployer: d.deployer ?? null,
    contracts: contractsJson,
    roleFree: roleFreeContracts(d),
    actions,
    actionCount: groups.length,
    unknown,
    warnings,
  };
}

/** Read every deployment on a chain. A deployment whose read fails is listed in `errors`. */
export async function readGovernance(chainId: GovChainId): Promise<GovernanceJson> {
  const deps = govDeploymentsOn(chainId);
  const client = createPublicClient({
    chain: getAppChain(chainId),
    transport: serverReadTransport(chainId, { retryCount: 2 }),
  }) as PublicClient;
  const head = await client.getBlockNumber();
  // One scan for the chain: every listed contract from the oldest deployment block (46630 v3 shares v2's calendar
  // and feeds, whose grants predate v3's block).
  const addresses = [
    ...new Map(
      deps.flatMap((d) => deploymentContracts(d)).map((c) => [c.address.toLowerCase(), c.address as Address]),
    ).values(),
  ];
  const from = BigInt(Math.min(...deps.map((d) => d.block ?? 0)));
  const logs = await adminLogs(client, addresses, from, head);

  const settled = await Promise.allSettled(deps.map((d) => readDeployment(client, chainId, d, logs, head)));
  const deployments: GovDeploymentJson[] = [];
  const errors: GovernanceJson["errors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") deployments.push(r.value);
    else errors.push({ key: deploymentKeyOf(deps[i]!), message: short(r.reason) });
  });
  if (!deployments.length) throw new Error(errors[0]?.message ?? "No deployment to read");
  return {
    chainId,
    chainName: GOV_CHAIN_NAMES[chainId],
    explorer: GOV_EXPLORERS[chainId],
    generatedAt: new Date().toISOString(),
    deployments,
    errors,
  };
}
