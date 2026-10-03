import type pg from "pg";

// Read queries behind /events, /agents and /epochs. All read from the pool (never the writer), so a standby
// instance without the writer lock serves them too.

export interface EventQuery {
  chain?: number;
  /** Event names, e.g. ["OptionsBought", "SeriesProposed"]. */
  types?: string[];
  /** Events emitted by this vault or naming it in their arguments. */
  vault?: string;
  /** Events naming this address in any argument (a depositor, buyer, owner, recipient...). */
  account?: string;
  deployment?: string;
  limit: number;
  cursor?: string;
}

export interface EventRow {
  chainId: number;
  deployment: string;
  blockNumber: number;
  blockHash: string;
  blockTime: string;
  txHash: string;
  logIndex: number;
  address: string;
  source: string;
  event: string | null;
  args: Record<string, unknown> | null;
}

/** Keyset cursor: the sort key of the last row returned (newest first), base64url JSON. */
interface Cursor {
  t: string;
  c: number;
  b: number;
  l: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.t, c.c, c.b, c.l])).toString("base64url");
}

export function decodeCursor(s: string): Cursor {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("invalid cursor");
  }
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    typeof v[0] !== "string" ||
    Number.isNaN(Date.parse(v[0])) ||
    !v.slice(1).every((x) => Number.isSafeInteger(x))
  ) {
    throw new BadRequest("invalid cursor");
  }
  return { t: v[0], c: v[1], b: v[2], l: v[3] };
}

export class BadRequest extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/** A page of events, newest first, and the cursor of the next page (null on the last). */
export async function queryEvents(
  pool: pg.Pool,
  q: EventQuery,
): Promise<{ events: EventRow[]; nextCursor: string | null }> {
  const where: string[] = ["true"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.chain !== undefined) where.push(`chain_id = ${p(q.chain)}`);
  if (q.deployment) where.push(`deployment_id = ${p(q.deployment)}`);
  if (q.types?.length) where.push(`event_name = ANY(${p(q.types)}::text[])`);
  if (q.vault) {
    const v = p(q.vault.toLowerCase());
    where.push(`(address = ${v} OR args ->> 'vault' = ${v})`);
  }
  if (q.account) {
    const v = p(q.account.toLowerCase());
    where.push(`EXISTS (SELECT 1 FROM jsonb_each_text(args) kv WHERE kv.value = ${v})`);
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push(
      `(block_time, chain_id, block_number, log_index) < (${p(c.t)}::timestamptz, ${p(c.c)}, ${p(c.b)}, ${p(c.l)})`,
    );
  }
  const limit = p(q.limit + 1);
  const { rows } = await pool.query(
    `SELECT chain_id, deployment_id, block_number, block_hash, block_time, tx_hash, log_index, address, source,
       event_name, args
     FROM events WHERE ${where.join(" AND ")}
     ORDER BY block_time DESC, chain_id DESC, block_number DESC, log_index DESC
     LIMIT ${limit}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    events: page.map((r) => ({
      chainId: r.chain_id,
      deployment: r.deployment_id,
      blockNumber: Number(r.block_number),
      blockHash: r.block_hash,
      blockTime: new Date(r.block_time).toISOString(),
      txHash: r.tx_hash,
      logIndex: r.log_index,
      address: r.address,
      source: r.source,
      event: r.event_name,
      args: r.args,
    })),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({
            t: new Date(last.block_time).toISOString(),
            c: last.chain_id,
            b: Number(last.block_number),
            l: last.log_index,
          })
        : null,
  };
}

/** Agents of every deployment (or one chain), from v_agents. Amounts in base units, as strings. */
export async function queryAgents(pool: pg.Pool, chain?: number) {
  const { rows } = await pool.query(
    `SELECT * FROM v_agents WHERE ($1::int IS NULL OR chain_id = $1) ORDER BY chain_id, deployment_id, agent_id::numeric`,
    [chain ?? null],
  );
  return rows.map((r) => ({
    chainId: r.chain_id,
    deployment: r.deployment_id,
    agentId: r.agent_id,
    owner: r.owner,
    signer: r.signer,
    erc8004Id: r.erc8004_id,
    status: r.status,
    registeredBlock: Number(r.registered_block),
    registeredAt: new Date(r.registered_at).toISOString(),
    registeredTx: r.registered_tx,
    bonded: r.bonded,
    slashed: r.slashed,
    unbonded: r.unbonded,
    proposalsAccepted: Number(r.proposals_accepted),
    proposalsRejected: Number(r.proposals_rejected),
    cumulativePnl: r.cumulative_pnl,
    decisionRecords: Number(r.decision_records),
  }));
}

/** Epochs, newest first, from v_epochs. */
export async function queryEpochs(
  pool: pg.Pool,
  q: { chain?: number; vault?: string; state?: string; limit: number },
) {
  const { rows } = await pool.query(
    `SELECT * FROM v_epochs
     WHERE ($1::int IS NULL OR chain_id = $1) AND ($2::text IS NULL OR vault = $2) AND ($3::text IS NULL OR state = $3)
     ORDER BY opened_at DESC, chain_id, vault, epoch DESC LIMIT $4`,
    [q.chain ?? null, q.vault?.toLowerCase() ?? null, q.state ?? null, q.limit],
  );
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
  return rows.map((r) => ({
    chainId: r.chain_id,
    deployment: r.deployment_id,
    vault: r.vault,
    epoch: Number(r.epoch),
    state: r.state,
    spotAtOpen: r.spot_at_open,
    openedBlock: Number(r.opened_block),
    openedAt: iso(r.opened_at),
    openedTx: r.opened_tx,
    seriesId: r.series_id,
    strike: r.strike,
    expiry: iso(r.expiry),
    size: r.size,
    settlementPrice: r.settlement_price,
    payout: r.payout,
    premium: r.premium,
    fee: r.fee,
    settledAt: iso(r.settled_at),
    settledTx: r.settled_tx,
    abortedAt: iso(r.aborted_at),
    abortedTx: r.aborted_tx,
  }));
}
