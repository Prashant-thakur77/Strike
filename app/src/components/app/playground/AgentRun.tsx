"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import {
  RUN_PROFILES,
  buildRun,
  profilePremium,
  runTargets,
  type RunInputs,
  type RunProfile,
  type RunRung,
} from "@/lib/agentRun";
import type { Pipeline } from "@/lib/pipeline";
import {
  PLAYGROUND_CHAIN_ID,
  PLAYGROUND_VAULTS,
  capacityAt,
  decodeRevert,
  playgroundClient,
  type PlaygroundSnapshot,
  type VaultKey,
} from "@/lib/playground";
import { PipelineStrip } from "../decision/PipelineStrip";
import appStyles from "../app.module.css";
import styles from "./playground.module.css";

const num = (x: bigint, d = 18) => Number(formatUnits(x, d));

/** Run the example agent's rule stages against a live vault, in this browser, sending nothing. */
export function AgentRun({ snap }: { snap: PlaygroundSnapshot | undefined }) {
  const [vaultKey, setVaultKey] = useState<VaultKey>("call");
  const [profileId, setProfileId] = useState<RunProfile["id"]>("default");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!snap) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await runAgent(
          snap,
          vaultKey,
          RUN_PROFILES.find((p) => p.id === profileId)!,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : "The run failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${appStyles.panel} ${styles.runPanel}`} data-testid="agent-run">
      <p className="body">
        The example agent&apos;s rule stages, run here against the live vault on Robinhood Chain testnet: the
        market checks, a ladder of strikes each solved by the pricer and judged by the contract&apos;s own{" "}
        <code className="mono">previewProposal</code>, the profile&apos;s pick, and the critic&apos;s rules.
        Nothing is sent. Claude is not called from this page, since it needs a key.
      </p>
      <div className={styles.runControls}>
        <label>
          <span className="micro micro-muted">Vault</span>
          <select
            value={vaultKey}
            onChange={(e) => setVaultKey(e.target.value as VaultKey)}
            data-testid="agent-run-vault"
          >
            {PLAYGROUND_VAULTS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="micro micro-muted">Rule profile</span>
          <select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value as RunProfile["id"])}
            data-testid="agent-run-profile"
          >
            {RUN_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="pill pill-small"
          onClick={run}
          disabled={!snap || busy}
          data-testid="agent-run-button"
        >
          {busy ? "Running the stages…" : "Run the agent"}
        </button>
      </div>
      {error ? (
        <p className={appStyles.hint} role="alert" data-testid="agent-run-error">
          {error}
        </p>
      ) : null}
      {result ? <PipelineStrip pipeline={result} chainId={PLAYGROUND_CHAIN_ID} /> : null}
    </div>
  );
}

async function runAgent(snap: PlaygroundSnapshot, key: VaultKey, profile: RunProfile): Promise<Pipeline> {
  const s = playgroundClient();
  const ctx = snap.vaults[key];
  const v = ctx.vault;
  const t0 = performance.now();
  const expiry = ctx.expiries.next;
  const inp: RunInputs = {
    vault: PLAYGROUND_VAULTS.find((x) => x.key === key)!.address,
    symbol: PLAYGROUND_VAULTS.find((x) => x.key === key)!.short,
    isCall: v.isCall,
    marketOpen: snap.marketOpen,
    epochState: ctx.epoch.state,
    feedOk: ctx.liveSpotError === null && (ctx.oracle?.ok ?? true),
    feedNote: ctx.liveSpotError
      ? `the oracle reverts: ${ctx.liveSpotError.signature}`
      : ctx.oracle
        ? `StockOracle.status: ${ctx.oracle.status}`
        : "status not read",
    spot: ctx.refSpot === null ? null : num(ctx.refSpot),
    sigma: num(ctx.refSigma),
    mandate: v.mandate,
    tenorSeconds: Number(expiry - snap.blockTimestamp),
    expiryIso: new Date(Number(expiry) * 1000).toISOString(),
    stockOracle: s.addresses.stockOracle,
    epochManager: s.addresses.epochManager,
  };
  const market = performance.now() - t0;
  const premiumBps = profilePremium(profile, v.mandate);
  const t1 = performance.now();
  const rungs: RunRung[] = [];
  if (inp.feedOk && inp.spot !== null) {
    for (const targetDeltaBps of runTargets(v.mandate)) {
      try {
        const strike = await s.solveStrike(inp.vault as `0x${string}`, { targetDeltaBps, expiry });
        const cap = capacityAt(ctx, strike, snap.usdgDecimals);
        const size =
          (cap * BigInt(v.mandate.maxShareSoldBps) * BigInt(Math.round(profile.sizeShare * 10_000))) /
          100_000_000n;
        const p = await s.previewProposal(inp.vault as `0x${string}`, { strike, expiry, size, premiumBps });
        const strikeN = num(strike);
        const fair = num(p.fairValue);
        const premium = (fair * premiumBps) / 10_000;
        rungs.push({
          targetDeltaBps,
          strike: strikeN,
          size: num(size, v.underlyingDecimals),
          ok: p.accepted,
          reason: p.reason,
          fairValue: fair,
          delta: Math.abs(num(p.delta)),
          // Premium over the collateral one option locks: the strike for a put, the spot for a call.
          yieldBps: (premium / (v.isCall ? inp.spot : strikeN)) * 10_000,
          error: null,
        });
      } catch (e) {
        const r = decodeRevert(e);
        if (!r) throw e;
        rungs.push({
          targetDeltaBps,
          strike: null,
          size: null,
          ok: false,
          reason: r.name,
          fairValue: null,
          delta: null,
          yieldBps: null,
          error: r.signature,
        });
      }
    }
  }
  return buildRun(inp, profile, rungs, {
    market: Math.round(market),
    risk: Math.round(performance.now() - t1),
  });
}
