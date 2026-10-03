import "server-only";
import { seriesRiskView, vaultView } from "@strike/mcp";
import { readOnlyClient } from "@strike/mcp/http";
import { auditMirror } from "@strike/sdk";
import { createPublicClient, type Address, type PublicClient } from "viem";
import { APP_URL } from "../config";
import { getAppChain, RPC_OVERRIDES, type AppChainId } from "../chains";
import { deploymentVersion } from "../deployment";
import { readSettlementAudit, readTrace } from "../epochTraceRead";
import { isMirrorChain, type MirrorChainId } from "../mirrorAudit";
import { vaultDeployment } from "../reads";
import { serverReadTransport, serverRpcEndpoints } from "../rpc/server";

// The paid risk report (GET /api/agent/risk-report, docs/ENDPOINTS.md): one vault's state, the Stylus risk engine's
// greeks and stress test for its live series, the settlement audit of its last expiry and the price mirror audit of
// its underlying against Robinhood Chain mainnet Chainlink, and its anchored decision records with links. Every part
// is read live (or from the free routes' per-instance caches) and fails on its own: a part that could not be read is
// `{ error }` and the rest still answer. Only a vault that cannot be read at all fails the report, and then the
// caller is not charged (paywall.ts settles only after a 200).

/** Mirror rounds of the underlying checked per report. */
const MIRROR_ROUNDS = 24;

type Part<T> = T | { error: string };

const errorOf = (err: unknown): { error: string } => ({
  error: err instanceof Error ? err.message.split("\n")[0]! : String(err),
});

async function part<T>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return await fn();
  } catch (err) {
    return errorOf(err);
  }
}

/** bigint to string, recursively, so the report is plain JSON. */
export function jsonSafe(x: unknown): unknown {
  if (typeof x === "bigint") return x.toString();
  if (Array.isArray(x)) return x.map(jsonSafe);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return x;
}

export class ReportInputError extends Error {}

/** Build the report. Throws ReportInputError when `vault` is not a Strike vault on the chain. */
export async function buildRiskReport(chainId: AppChainId, vault: Address): Promise<Record<string, unknown>> {
  const publicClient = createPublicClient({
    chain: getAppChain(chainId),
    transport: serverReadTransport(chainId, { retryCount: 2 }),
  }) as PublicClient;
  const dep = await vaultDeployment(publicClient, chainId, vault);
  if (!dep) throw new ReportInputError(`${vault} is not a Strike vault on chain ${chainId}`);
  const version = deploymentVersion(dep) || null;
  const client = readOnlyClient(chainId, serverRpcEndpoints(chainId), 10_000, dep);
  const v = await client.getVault(vault);
  const live = v.series && v.epoch.state === "Selling" ? v.series : null;

  const [risk, trace, settlement, mirror] = await Promise.all([
    live
      ? part(async () => seriesRiskView(await client.seriesRisk(live.id), v, chainId))
      : Promise.resolve({ error: `no live series (epoch is ${v.epoch.state})` }),
    part(() => readTrace(chainId, vault)),
    isMirrorChain(chainId)
      ? part(() => readSettlementAudit(chainId, vault))
      : Promise.resolve({ error: "the settlement audit runs on 46630 and 421614 only" }),
    isMirrorChain(chainId)
      ? part(async () => {
          const a = await auditMirror({
            chainId: chainId as MirrorChainId,
            symbol: v.underlyingSymbol,
            lastRounds: MIRROR_ROUNDS,
            pushTxs: false,
            env: { ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY, STRIKE_RPC_URL: RPC_OVERRIDES[chainId] },
          });
          return {
            ok: a.ok,
            symbol: v.underlyingSymbol,
            roundsChecked: a.summary.rounds,
            matched: a.summary.matched,
            mismatched: a.summary.mismatched,
            largestGap: a.summary.largestGap,
            fullAudit: `${APP_URL}/api/mirror-audit?chain=${chainId}`,
          };
        })
      : Promise.resolve({ error: "the price mirror runs on 46630 and 421614 only" }),
  ]);

  const records =
    "error" in trace
      ? trace
      : trace.epochs.flatMap((e) =>
          e.steps
            .filter((s) => s.record)
            .map((s) => ({
              epoch: e.epoch,
              outcome: s.kind,
              title: s.title,
              uri: s.record!.uri,
              recordHash: s.record!.hash,
              agentId: s.record!.agentId,
              anchorTx: s.tx,
              anchorTxUrl: s.tx ? `${trace.explorer}/tx/${s.tx}` : null,
            })),
        );

  return jsonSafe({
    report: "strike.risk-report",
    version: 1,
    generatedAt: new Date().toISOString(),
    chainId,
    deployment: version,
    vault: vaultView(v, { chainId, version }),
    seriesRisk: risk,
    settlementAudit: settlement,
    mirrorAudit: mirror,
    decisionRecords: records,
    epochTrace: "error" in trace ? trace : trace.epochs.map((e) => ({ epoch: e.epoch, status: e.status })),
    links: {
      vaultPage: `${APP_URL}/app/vault/${vault}?chain=${chainId}`,
      epochTrace: `${APP_URL}/api/epoch-trace?chain=${chainId}&vault=${vault}`,
    },
  }) as Record<string, unknown>;
}
