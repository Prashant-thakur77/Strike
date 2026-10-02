"use client";

import { maxProposalSize } from "@strike/sdk";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { errorMessage } from "@/hooks/useTx";
import { useDebounced } from "@/hooks/useDebounced";
import { fmtWadUsd } from "@/lib/format";
import { marketStatus, type MarketStatus } from "@/lib/reads";
import {
  PLAYGROUND_CHAIN_ID,
  PRESETS,
  capacityAt,
  expiryFor,
  formToInput,
  mandateRules,
  nyTime,
  playgroundClient,
  readPlayground,
  runPreview,
  sizeText,
  type ExpiryChoice,
  type PlaygroundSnapshot,
  type Preset,
  type PresetId,
  type ProposalForm,
  type ProposalInput,
  type VaultKey,
} from "@/lib/playground";
import { AmountField } from "../AmountField";
import { MarketSub } from "../market/MarketHours";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Fold } from "../Fold";
import { PageIndex } from "../PageIndex";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import appStyles from "../app.module.css";
import { MandateRules } from "./MandateRules";
import { Presets } from "./Presets";
import { EpochNote, VaultPicker } from "./VaultPicker";
import { VerdictPanel, measuresOf } from "./VerdictPanel";
import { WhatThisProves } from "./WhatThisProves";
import { Term } from "@/components/ui/Term";
import styles from "./playground.module.css";

const SECTIONS = [
  { id: "pg-presets", label: "Presets" },
  { id: "pg-verdict", label: "Verdict" },
  { id: "pg-rules", label: "Rules" },
  { id: "pg-proves", label: "What it proves" },
];

const REFRESH_MS = 30_000;
const DEBOUNCE_MS = 350;

const EMPTY_FORM: ProposalForm = {
  vault: "call",
  mode: "delta",
  delta: "0.20",
  strike: "",
  size: "",
  premium: "100",
  expiry: "next",
};

/** Stable query key for an input (bigints don't survive JSON hashing). */
function inputKey(i: ProposalInput): string {
  return [i.vault, i.mode, i.targetDeltaBps, i.strike, i.expiry, i.size, i.premiumBps].join(":");
}

export function PlaygroundPage() {
  const snapQ = useQuery({
    queryKey: ["playground", PLAYGROUND_CHAIN_ID],
    queryFn: () => readPlayground(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS / 2,
    retry: 1,
  });
  const snap = snapQ.data;
  // NYSE hours from the same deployment's MarketCalendar (the playground always reads Robinhood Chain testnet).
  const marketQ = useQuery({
    queryKey: ["playground-market", PLAYGROUND_CHAIN_ID],
    queryFn: () => {
      const s = playgroundClient();
      return marketStatus(s.viem.publicClient, s.addresses);
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const market = marketQ.data;

  const [form, setForm] = useState<ProposalForm>(EMPTY_FORM);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [seeded, setSeeded] = useState(false);

  // First load: start on the honest proposal, so the page opens on a live "Accepted".
  useEffect(() => {
    if (snap && !seeded) {
      setSeeded(true);
      setForm(PRESETS[0]!.build(snap));
      setPreset(PRESETS[0]!.id);
    }
  }, [snap, seeded]);

  const debounced = useDebounced(form, DEBOUNCE_MS);
  const typing = debounced !== form;
  const ctx = snap?.vaults[debounced.vault];
  const check = useMemo(() => (snap && ctx ? formToInput(debounced, ctx) : null), [snap, ctx, debounced]);
  const input = check?.ok ? check.input : null;

  const previewQ = useQuery({
    queryKey: ["playground-preview", input ? inputKey(input) : "none", snap?.blockTimestamp.toString()],
    queryFn: () => runPreview(input!),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: REFRESH_MS,
  });
  // Only show an outcome for the vault being edited (placeholder data may still belong to the other one).
  const outcome =
    previewQ.data && input && previewQ.data.input.vault === input.vault ? previewQ.data : undefined;
  const busy = typing || previewQ.isFetching || (input !== null && previewQ.isPlaceholderData);
  // Only call an input invalid once the user has stopped typing (and never for a stale, pre-seed form).
  const invalid = !typing && check && !check.ok ? check.message : null;

  function edit(patch: Partial<ProposalForm>) {
    setPreset(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  function pickPreset(p: Preset) {
    if (!snap) return;
    setPreset(p.id);
    setForm(p.build(snap));
  }

  function pickVault(key: VaultKey) {
    if (!snap || key === form.vault) return;
    const next = snap.vaults[key];
    const ref = next.refSpot ?? 0n;
    // Sizes don't carry across vaults (5 TSLA of calls vs a few cents of TSLA puts): start at half of capacity.
    const size = sizeText(capacityAt(next, ref, snap.usdgDecimals) / 2n, next.vault.underlyingDecimals);
    edit({ vault: key, size });
  }

  function pickMode(mode: ProposalForm["mode"]) {
    if (mode === form.mode) return;
    // Switching to an explicit strike keeps the strike the contract just solved.
    const solved = outcome && outcome.input.mode === "delta" ? outcome.input.strike : null;
    let strike = form.strike;
    if (mode === "strike" && !strike && solved) {
      strike = formatUnits(solved - (solved % 10n ** 16n), 18);
      if (strike.includes(".")) strike = strike.replace(/\.?0+$/, "");
    }
    edit({ mode, strike });
  }

  const liveCtx = snap?.vaults[form.vault];
  const measures = outcome && ctx && snap ? measuresOf(outcome, ctx, snap.blockTimestamp) : null;
  const reasonCode = outcome?.kind === "verdict" ? outcome.preview.reasonCode : null;
  const rules = liveCtx ? mandateRules(liveCtx.vault.mandate, measures, reasonCode) : null;
  const capacity =
    outcome?.kind === "verdict"
      ? outcome.preview.capacity
      : liveCtx && snap && liveCtx.refSpot
        ? capacityAt(liveCtx, liveCtx.refSpot, snap.usdgDecimals)
        : undefined;
  const maxSize =
    capacity !== undefined && liveCtx ? maxProposalSize(capacity, liveCtx.vault.mandate) : undefined;
  const sym = liveCtx?.vault.underlyingSymbol ?? "TSLA";
  const dec = liveCtx?.vault.underlyingDecimals ?? 18;

  return (
    <>
      <PageHero
        index="02"
        label="Playground"
        right="Robinhood Chain testnet · 46630"
        title={<span className={styles.title}>Playground</span>}
        lead={
          <>
            <p className="lead">
              Write a proposal the way an agent would and ask the deployed contract what it would do. It
              checks the vault&apos;s immutable <Term id="mandate">mandate</Term> and answers: list the
              series, or reject it and <Term id="slash">slash</Term> the agent.
            </p>
            <p className={styles.leadNote}>
              No wallet needed. Every verdict is a read-only call to{" "}
              <code className="mono">previewProposal</code> on testnet, whatever network the app is set to.
            </p>
          </>
        }
      />

      <Strip snap={snap} failed={snapQ.isError} market={market} />

      <PageIndex items={SECTIONS} />

      <div className={`${styles.body} ${appStyles.indexed}`}>
        <section className="gutter" aria-labelledby="pg-presets">
          <div className={styles.sectionTop}>
            <h2 id="pg-presets" className="micro">
              <span className="index">01</span> Try a preset
            </h2>
            <p className={styles.sectionNote}>
              One honest agent and three that break a rule. Pick one and watch the verdict.
            </p>
          </div>
          <Presets active={preset} disabled={!snap} onPick={pickPreset} />
          {snapQ.isError && !snap ? (
            <div className={`${appStyles.empty} ${styles.error}`} role="alert">
              <span className="micro micro-muted">Robinhood Chain testnet</span>
              <h3 className="h3">Couldn&apos;t read the vaults.</h3>
              <p className="body">{errorMessage(snapQ.error)}</p>
              <div className={appStyles.emptyActions}>
                <button type="button" className="pill pill-small" onClick={() => snapQ.refetch()}>
                  Try again <RotateCw aria-hidden />
                </button>
              </div>
            </div>
          ) : null}

          <div className={styles.bench}>
            <form className={styles.form} onSubmit={(e) => e.preventDefault()} aria-label="Proposal">
              <VaultPicker value={form.vault} snap={snap} onChange={pickVault} />
              {liveCtx && snap ? <EpochNote ctx={liveCtx} snap={snap} market={market} /> : null}

              <div className={styles.fieldset} role="group" aria-labelledby="pg-mode">
                <span id="pg-mode" className="micro micro-muted">
                  Propose by
                </span>
                <div className={styles.chips}>
                  {(
                    [
                      ["delta", "Target delta · proposeByDelta"],
                      ["strike", "Explicit strike · proposeSeries"],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      className="chip"
                      aria-pressed={form.mode === m}
                      onClick={() => pickMode(m)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.fields}>
                {form.mode === "delta" ? (
                  <div className="field">
                    <AmountField
                      label="Target |delta|"
                      value={form.delta}
                      onChange={(v) => edit({ delta: v })}
                      unit="Δ"
                      decimals={4}
                    />
                    <span className={styles.fieldHint}>
                      {outcome?.input.mode === "delta" && !busy ? (
                        <>
                          The pricer solves strike <strong>{fmtWadUsd(outcome.input.strike)}</strong>, rounded
                          to a cent toward the middle of the band.
                        </>
                      ) : (
                        "The contract's pricer solves the strike for this |delta|."
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="field">
                    <AmountField
                      label="Strike"
                      value={form.strike}
                      onChange={(v) => edit({ strike: v })}
                      unit="USD"
                      decimals={2}
                    />
                    <span className={styles.fieldHint}>
                      {liveCtx?.refSpot
                        ? `Spot the contract judges against: ${fmtWadUsd(liveCtx.refSpot)}.`
                        : "Dollars per token."}
                    </span>
                  </div>
                )}
                <div className="field">
                  <AmountField
                    label="Premium factor"
                    value={form.premium}
                    onChange={(v) => edit({ premium: v })}
                    unit="% of fair"
                    decimals={2}
                  />
                  <span className={styles.fieldHint}>
                    100 = Black-Scholes fair value. Mandate floor{" "}
                    {liveCtx ? `${liveCtx.vault.mandate.minPremiumBps / 100}%` : "…"}, cap 300%.
                  </span>
                </div>
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <AmountField
                    label={`Size · options (1 = one ${sym})`}
                    value={form.size}
                    onChange={(v) => edit({ size: v })}
                    unit={sym}
                    decimals={dec}
                    max={maxSize}
                    maxLabel="Mandate max"
                  />
                </div>
              </div>

              <ExpiryPicker
                value={form.expiry}
                snap={snap}
                vault={form.vault}
                onChange={(expiry) => edit({ expiry })}
              />

              {invalid ? <p className={styles.invalid}>{invalid}</p> : null}
            </form>

            <VerdictPanel
              snap={snap}
              ctx={ctx}
              outcome={invalid ? undefined : outcome}
              busy={invalid ? false : busy}
              invalid={invalid}
              error={previewQ.isError ? errorMessage(previewQ.error) : null}
            />
          </div>
        </section>

        <Rail
          index="03"
          id="pg-rules"
          label="The mandate, rule by rule"
          note={
            <>
              Fixed when the vault was created: nobody can change it.{" "}
              <code className="mono">MandateGuard.check</code> runs the rules in this order and stops at the
              first one broken; that rule is the verdict.
            </>
          }
        >
          {rules ? (
            <Fold
              summary={`Show all ${rules.length} rules · ${
                rules.some((r) => r.mark === "fail")
                  ? `1 broken: ${rules.find((r) => r.mark === "fail")!.title}`
                  : rules.every((r) => r.mark === "pass")
                    ? "all pass"
                    : "in check order"
              }`}
              openSummary="Hide the rules"
            >
              <MandateRules rules={rules} />
            </Fold>
          ) : (
            <RulesSkeleton />
          )}
        </Rail>
      </div>

      <WhatThisProves />
    </>
  );
}

function ExpiryPicker({
  value,
  snap,
  vault,
  onChange,
}: {
  value: ExpiryChoice;
  snap: PlaygroundSnapshot | undefined;
  vault: VaultKey;
  onChange: (c: ExpiryChoice) => void;
}) {
  const ctx = snap?.vaults[vault];
  const options: [ExpiryChoice, string][] = [
    ["next", "Next weekly close"],
    ["following", "The week after"],
    ["early", "An hour before the close"],
  ];
  return (
    <div className={styles.fieldset} role="group" aria-labelledby="pg-expiry">
      <span id="pg-expiry" className="micro micro-muted">
        Expiry · MarketCalendar.weeklyExpiry
      </span>
      <div className={styles.chips}>
        {options.map(([c, label]) => (
          <button
            key={c}
            type="button"
            className={`chip ${styles.expiryChip}`}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
          >
            {label}
            <small>{ctx ? nyTime(expiryFor(c, ctx)) : "…"}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function Strip({
  snap,
  failed,
  market,
}: {
  snap: PlaygroundSnapshot | undefined;
  failed: boolean;
  market: MarketStatus | undefined;
}) {
  if (!snap) {
    if (failed) return null;
    return (
      <MetaStrip
        cells={["NYSE", "TSLA spot", "Slash per rejection", "Agent #1"].map((label) => ({
          label,
          value: <Skeleton width="3.5em" />,
        }))}
      />
    );
  }
  const call = snap.vaults.call;
  const agentId = call.vault.agentId.toString();
  const agent = snap.agents[agentId];
  const usdg = (v: bigint) => Number(formatUnits(v, snap.usdgDecimals)).toLocaleString("en-US");
  return (
    <MetaStrip
      cells={[
        {
          label: "NYSE",
          value: snap.marketOpen ? "Open" : "Closed",
          sub: market ? <MarketSub market={market} /> : `block time ${nyTime(snap.blockTimestamp)}`,
        },
        {
          label: `${call.vault.underlyingSymbol} spot`,
          value: call.liveSpot !== null ? fmtWadUsd(call.liveSpot) : "Unsafe",
          sub:
            call.liveSpot !== null
              ? `SafeStockFeed · printed ${call.oracle ? nyTime(call.oracle.updatedAt) : "—"}`
              : `the feed reverts: ${call.liveSpotError?.name ?? "unknown"}`,
        },
        {
          label: "Slash per rejection",
          term: "slash",
          value: `${usdg(snap.registry.slashAmount)} USDG`,
          sub: `from the agent's bond to the vault · ${snap.registry.maxStrikes} strikes suspend`,
        },
        {
          label: `Agent #${agentId}`,
          value: agent ? `${agent.strikes}/${snap.registry.maxStrikes} strikes` : "—",
          sub: agent
            ? `${agent.status} · bond ${usdg(agent.bond)} USDG · ${agent.accepted} accepted, ${agent.rejected} rejected`
            : undefined,
        },
      ]}
    />
  );
}

function RulesSkeleton() {
  return (
    <div className={styles.placeholder} aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} width={`${60 + ((i * 7) % 30)}%`} />
      ))}
    </div>
  );
}
