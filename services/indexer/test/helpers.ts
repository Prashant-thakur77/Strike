import { randomBytes } from "node:crypto";
import {
  agentRegistryV3Abi,
  decisionLogAbi,
  epochManagerAbi,
  mirrorFeedAbi,
  strikeVaultAbi,
  vaultFactoryAbi,
} from "@strike/sdk";
import pg from "pg";
import {
  type Abi,
  type AbiEvent,
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { inject } from "vitest";
import type { RawLog } from "../src/abi.js";
import type { ChainSpec, DeploymentSpec } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { ChainIndexer } from "../src/ingest.js";
import { createLogger } from "../src/log.js";
import { TEAM_WALLETS } from "../src/meta.js";
import type { ChainBlock, ChainReader } from "../src/reader.js";
import { Writer } from "../src/writer.js";

export const silent = createLogger("silent");

/* ------------------------------------------------------------------ a database per test file */

export async function freshDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = inject("pgAdminUrl");
  const name = `strike_test_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const d = new pg.Client({ connectionString: admin });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await d.end();
    },
  };
}

/* ------------------------------------------------------------------ a chain in memory */

const BASE_TIME = 1_790_000_000n;

export interface FakeLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

/**
 * A chain the tests control: deterministic block hashes that change when a reorg replaces a block, logs added by
 * the test, an optional getLogs range limit (refused with the public RPCs' wording) and call counters.
 */
export class FakeChain implements ChainReader {
  readonly description = "fake chain";
  finalized: bigint | null = null;
  /** getLogs ranges wider than this are refused like a strict RPC would. */
  maxRange: bigint | null = null;
  /** Fail the next N getLogs calls with a non-range error (a flaky RPC). */
  failNext = 0;
  readonly calls = { getLogs: 0, getBlock: 0, refused: 0 };
  private readonly reorgPoints: bigint[] = [];
  private logs: FakeLog[] = [];

  constructor(
    readonly chainId: number,
    public head: bigint,
  ) {}

  private generation(n: bigint): number {
    return this.reorgPoints.filter((r) => n >= r).length;
  }

  hashOf(n: bigint): Hex {
    return keccak256(toHex(`${this.chainId}/block/${n}/${this.generation(n)}`));
  }

  /** Append a log; its log index is its position in the block, its tx hash unique to the block and fork. */
  add(address: string, enc: { topics: Hex[]; data: Hex }, blockNumber: bigint, txHash?: Hex): FakeLog {
    const inBlock = this.logs.filter((l) => l.blockNumber === blockNumber).length;
    const log: FakeLog = {
      address: address.toLowerCase(),
      topics: enc.topics,
      data: enc.data,
      blockNumber,
      transactionHash:
        txHash ??
        keccak256(toHex(`${this.chainId}/tx/${blockNumber}/${inBlock}/${this.generation(blockNumber)}`)),
      transactionIndex: inBlock,
      logIndex: inBlock,
    };
    this.logs.push(log);
    return log;
  }

  /** Replace every block from `from` on (new hashes) and drop their logs; the test adds the new fork's logs. */
  reorg(from: bigint): FakeLog[] {
    const dropped = this.logs.filter((l) => l.blockNumber >= from);
    this.logs = this.logs.filter((l) => l.blockNumber < from);
    this.reorgPoints.push(from);
    return dropped;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getFinalizedBlockNumber(): Promise<bigint | null> {
    return this.finalized;
  }

  async getBlock(n: bigint): Promise<ChainBlock> {
    this.calls.getBlock += 1;
    if (n > this.head) throw new Error(`block ${n} is beyond the head ${this.head}`);
    return {
      number: n,
      hash: this.hashOf(n),
      parentHash: this.hashOf(n - 1n),
      timestamp: BASE_TIME + n * 2n,
    };
  }

  async getLogs(addresses: readonly Hex[], from: bigint, to: bigint): Promise<RawLog[]> {
    this.calls.getLogs += 1;
    if (this.maxRange !== null && to - from + 1n > this.maxRange) {
      this.calls.refused += 1;
      throw new Error(`eth_getLogs block range is too large, max ${this.maxRange}`);
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("fetch failed: socket hang up");
    }
    const want = new Set(addresses.map((a) => a.toLowerCase()));
    return this.logs
      .filter((l) => want.has(l.address) && l.blockNumber >= from && l.blockNumber <= to)
      .sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      )
      .map((l) => ({
        address: l.address as Hex,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        blockHash: this.hashOf(l.blockNumber),
        transactionHash: l.transactionHash,
        transactionIndex: l.transactionIndex,
        logIndex: l.logIndex,
      }));
  }

  /** Every log, for building the app's input in the parity test. */
  allLogs(): FakeLog[] {
    return [...this.logs];
  }
}

/* ------------------------------------------------------------------ encoding events with the SDK's ABIs */

export const ABI = {
  epochManager: epochManagerAbi as Abi,
  vaultFactory: vaultFactoryAbi as Abi,
  agentRegistry: agentRegistryV3Abi as Abi,
  decisionLog: decisionLogAbi as Abi,
  vault: strikeVaultAbi as Abi,
  mirrorFeed: mirrorFeedAbi as Abi,
};

export function encodeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
): { topics: Hex[]; data: Hex } {
  const item = getAbiItem({ abi, name: eventName }) as AbiEvent | undefined;
  if (!item || item.type !== "event") throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(
    item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]),
  );
  const topics = encodeEventTopics({ abi: [item], eventName, args: indexed } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    plain,
    plain.map((i) => args[i.name!]),
  );
  return { topics, data };
}

/** A deterministic address for a label. */
export const addr = (label: string): Hex => getAddress(keccak256(toHex(label)).slice(0, 42)) as Hex;

export const TEAM = TEAM_WALLETS.map((w) => getAddress(w) as Hex);
export const ALICE = addr("alice");
export const BOB = addr("bob");
export const CAROL = addr("carol");

export interface Addrs {
  epochManager: Hex;
  vaultFactory: Hex;
  agentRegistry: Hex;
  decisionLog: Hex;
  feed: Hex;
  usdg: Hex;
  stockOracle: Hex;
  callVault: Hex;
  putVault: Hex;
  stock: Hex;
}

export function addrs(tag: string): Addrs {
  return {
    epochManager: addr(`${tag}/em`),
    vaultFactory: addr(`${tag}/factory`),
    agentRegistry: addr(`${tag}/registry`),
    decisionLog: addr(`${tag}/decisionLog`),
    feed: addr(`${tag}/feed`),
    usdg: addr(`${tag}/usdg`),
    stockOracle: addr(`${tag}/oracle`),
    callVault: addr(`${tag}/callVault`),
    putVault: addr(`${tag}/putVault`),
    stock: addr(`${tag}/TSLA`),
  };
}

export function deploymentSpec(
  chainId: number,
  version: string,
  a: Addrs,
  deployBlock: bigint,
): DeploymentSpec {
  const l = (x: string) => x.toLowerCase();
  return {
    id: `${chainId}-${version}`,
    chainId,
    version,
    file: `test/${chainId}-${version}.json`,
    deployBlock,
    usdg: l(a.usdg),
    stockOracle: l(a.stockOracle),
    epochManager: l(a.epochManager),
    vaultFactory: l(a.vaultFactory),
    agentRegistry: l(a.agentRegistry),
    decisionLog: l(a.decisionLog),
    contracts: [
      { address: l(a.epochManager), kind: "epochManager" },
      { address: l(a.vaultFactory), kind: "vaultFactory" },
      { address: l(a.agentRegistry), kind: "agentRegistry" },
      { address: l(a.decisionLog), kind: "decisionLog" },
      { address: l(a.feed), kind: "mirrorFeed", label: "TSLA" },
    ],
  };
}

export function chainSpec(chainId: number, deployments: DeploymentSpec[]): ChainSpec {
  return {
    chainId,
    name: `Chain ${chainId}`,
    short: `C${chainId}`,
    explorer: "https://explorer.example",
    deployments,
  };
}

export const SERIES_ID = 48103703716925406245656156603615117052914973735876202170787552644395932337728n;

/**
 * One deployment's life, from `d` (its deploy block): two vaults, an agent registered (and linked to an identity,
 * which emits AgentRegistered again), a bond, deposits from outside wallets, an epoch with an accepted proposal, a
 * rejected proposal with its slash, a buy, a decision record, mirror rounds, a withdrawal, a settlement and an
 * aborted epoch, plus a log that matches no ABI. Returns the last block used.
 */
export function populate(chain: FakeChain, a: Addrs, d: bigint, opts: { buyer?: Hex } = {}): bigint {
  const [team0, team1] = [TEAM[0]!, TEAM[1]!];
  const buyer = opts.buyer ?? CAROL;
  const em = (name: string, args: Record<string, unknown>) => encodeLog(ABI.epochManager, name, args);
  chain.add(
    a.vaultFactory,
    encodeLog(ABI.vaultFactory, "VaultCreated", {
      vault: a.callVault,
      curator: team0,
      underlying: a.stock,
      isCall: true,
      agentId: 1n,
    }),
    d + 1n,
  );
  chain.add(
    a.epochManager,
    em("VaultRegistered", {
      vault: a.callVault,
      curator: team0,
      agentId: 1n,
      underlying: a.stock,
      isCall: true,
    }),
    d + 1n,
  );
  chain.add(
    a.vaultFactory,
    encodeLog(ABI.vaultFactory, "VaultCreated", {
      vault: a.putVault,
      curator: BOB,
      underlying: a.stock,
      isCall: false,
      agentId: 1n,
    }),
    d + 2n,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "AgentRegistered", {
      agentId: 1n,
      owner: team0,
      signer: team1,
      erc8004Id: 0n,
    }),
    d + 3n,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "BondPosted", { agentId: 1n, from: team1, amount: 60_000_000n }),
    d + 3n,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "AgentRegistered", {
      agentId: 1n,
      owner: team0,
      signer: team1,
      erc8004Id: 114n,
    }),
    d + 4n,
  );
  // A deposit routed through the put vault: its `owner` is a contract, never a wallet.
  chain.add(
    a.callVault,
    encodeLog(ABI.vault, "Deposit", {
      sender: ALICE,
      owner: ALICE,
      assets: 5n * 10n ** 18n,
      shares: 5n * 10n ** 18n,
    }),
    d + 5n,
  );
  chain.add(
    a.putVault,
    encodeLog(ABI.vault, "Deposit", {
      sender: ALICE,
      owner: a.putVault,
      assets: 1_000_000_000n,
      shares: 1_000_000_000n,
    }),
    d + 5n,
  );
  chain.add(
    a.putVault,
    encodeLog(ABI.vault, "DepositRequested", { account: BOB, epoch: 1n, assets: 250_000_000n }),
    d + 5n,
  );
  chain.add(
    a.epochManager,
    em("EpochOpened", { vault: a.callVault, epoch: 1n, spot: 369_360_000_000_000_000_000n }),
    d + 6n,
  );
  chain.add(
    a.epochManager,
    em("SeriesProposed", {
      vault: a.callVault,
      epoch: 1n,
      seriesId: SERIES_ID,
      strike: 400n * 10n ** 18n,
      expiry: 1_790_971_200n,
      size: 4n * 10n ** 18n,
      premiumBps: 120,
      fairValue: 1_845_000n,
      delta: 200_000_000_000_000_000n,
    }),
    d + 6n,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "ProposalRecorded", { agentId: 1n, accepted: true }),
    d + 6n,
  );
  chain.add(
    a.epochManager,
    em("EpochOpened", { vault: a.putVault, epoch: 1n, spot: 369_360_000_000_000_000_000n }),
    d + 7n,
  );
  // The rejection, its slash and the registry's record happen in one transaction.
  const rejectTx = keccak256(toHex(`${chain.chainId}/${a.epochManager}/reject`));
  chain.add(
    a.epochManager,
    em("ProposalRejected", {
      vault: a.putVault,
      epoch: 1n,
      agentId: 1n,
      reason: 3,
      slashed: 10_000_000n,
      strike: 300n * 10n ** 18n,
      expiry: 1_790_971_200n,
      size: 10n * 10n ** 18n,
      premiumBps: 5,
    }),
    d + 7n,
    rejectTx,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "Slashed", {
      agentId: 1n,
      recipient: a.putVault,
      amount: 10_000_000n,
      strikes: 1,
    }),
    d + 7n,
    rejectTx,
  );
  chain.add(
    a.agentRegistry,
    encodeLog(ABI.agentRegistry, "ProposalRecorded", { agentId: 1n, accepted: false }),
    d + 7n,
    rejectTx,
  );
  chain.add(
    a.epochManager,
    em("OptionsBought", {
      seriesId: SERIES_ID,
      buyer,
      recipient: buyer,
      amount: 4n * 10n ** 18n,
      premium: 7_383_870n,
    }),
    d + 8n,
  );
  chain.add(
    a.decisionLog,
    encodeLog(ABI.decisionLog, "DecisionRecorded", {
      agentId: 1n,
      vault: a.callVault,
      epoch: 1n,
      recordHash: keccak256(toHex("record")),
      uri: "ipfs://record",
      timestamp: 1_790_900_000n,
    }),
    d + 9n,
  );
  chain.add(
    a.feed,
    encodeLog(ABI.mirrorFeed, "AnswerUpdated", {
      current: 36_936_000_000n,
      roundId: 1n,
      updatedAt: 1_790_900_100n,
    }),
    d + 10n,
  );
  chain.add(
    a.feed,
    encodeLog(ABI.mirrorFeed, "AnswerUpdated", {
      current: 37_010_000_000n,
      roundId: 2n,
      updatedAt: 1_790_900_400n,
    }),
    d + 10n,
  );
  chain.add(
    a.callVault,
    encodeLog(ABI.vault, "RedeemRequested", { account: ALICE, epoch: 1n, shares: 10n ** 18n }),
    d + 11n,
  );
  chain.add(
    a.putVault,
    encodeLog(ABI.vault, "Withdraw", {
      sender: BOB,
      receiver: BOB,
      owner: BOB,
      assets: 5_000_000n,
      shares: 5_000_000n,
    }),
    d + 11n,
  );
  // A log no ABI decodes: kept raw, never counted.
  chain.add(
    a.epochManager,
    { topics: [keccak256(toHex("Unknown(uint256)"))], data: toHex(7n, { size: 32 }) },
    d + 11n,
  );
  chain.add(
    a.epochManager,
    em("EpochSettled", {
      vault: a.callVault,
      epoch: 1n,
      seriesId: SERIES_ID,
      settlementPrice: 380n * 10n ** 18n,
      payout: 0n,
      premium: 7_383_870n,
      fee: 0n,
    }),
    d + 12n,
  );
  chain.add(a.epochManager, em("EpochAborted", { vault: a.putVault, epoch: 1n }), d + 12n);
  return d + 12n;
}

/** Events stored by `populate` on one deployment (all decodable ones plus the raw one). */
export const POPULATED_EVENTS = 25;

/* ------------------------------------------------------------------ an indexer on a fresh database */

export interface Harness {
  url: string;
  pool: pg.Pool;
  writer: Writer;
  fake: FakeChain;
  spec: ChainSpec;
  ix: ChainIndexer;
  a: Addrs;
  deployBlock: bigint;
  close: () => Promise<void>;
}

export async function harness(
  opts: {
    chainId?: number;
    head?: bigint;
    maxRange?: bigint;
    confirmations?: bigint;
    populate?: boolean;
  } = {},
): Promise<Harness> {
  const chainId = opts.chainId ?? 46630;
  const deployBlock = 1000n;
  const db = await freshDb();
  const pool = createPool(db.url, 4);
  await migrate(pool);
  const writer = new Writer(db.url, silent);
  if (!(await writer.acquire())) throw new Error("could not take the writer lock");
  const fake = new FakeChain(chainId, opts.head ?? 1100n);
  const a = addrs(`chain-${chainId}`);
  if (opts.populate ?? true) populate(fake, a, deployBlock);
  const spec = chainSpec(chainId, [deploymentSpec(chainId, "v3", a, deployBlock)]);
  const ix = new ChainIndexer({
    chain: spec,
    reader: fake,
    writer,
    pool,
    log: silent,
    confirmations: opts.confirmations ?? 5n,
    maxRange: opts.maxRange ?? 1000n,
    decimals: { usdgDecimals: async () => 6 },
    baseDelayMs: 1,
  });
  await ix.sync();
  return {
    url: db.url,
    pool,
    writer,
    fake,
    spec,
    ix,
    a,
    deployBlock,
    close: async () => {
      await writer.release();
      await pool.end();
      await db.drop();
    },
  };
}

/** Row counts of the tables ingestion writes. */
export async function counts(pool: pg.Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM events)::int AS events,
    (SELECT count(*) FROM events WHERE event_name IS NULL)::int AS raw,
    (SELECT count(*) FROM blocks)::int AS blocks,
    (SELECT count(*) FROM contracts)::int AS contracts,
    (SELECT count(*) FROM contracts WHERE discovered)::int AS discovered`);
  return rows[0];
}

/** A digest of every stored event (identity and decoded content), to compare two databases or two runs. */
export async function eventDigest(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query(
    `SELECT md5(string_agg(concat_ws('|', chain_id, deployment_id, block_number, block_hash, tx_hash, log_index,
       address, source, event_name, args::text), ',' ORDER BY chain_id, block_number, log_index)) AS d FROM events`,
  );
  return rows[0].d ?? "";
}
