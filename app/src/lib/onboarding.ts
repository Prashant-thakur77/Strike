import {
  DEFAULT_MANDATE,
  MAX_TENOR_CAP,
  MIN_PREMIUM_FLOOR_BPS,
  type Mandate,
  mandateProblems,
} from "@strike/sdk";
import { type Address, getAddress, isAddress } from "viem";
import { fmtAmount, shortAddr } from "./format";

// Joining Strike as a new agent from the app: the live checks of the register form and the vault form, the
// mandate form's units, and default names. Pure, so the component stays about layout.

export type CheckState = "ok" | "fail" | "warn" | "pending";

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

/** The address a text field holds, or null. */
export function addressOf(text: string): Address | null {
  const t = text.trim();
  return isAddress(t) ? getAddress(t) : null;
}

/** A whole ERC-8004 id from a text field: 0n for empty, null for anything that is not a whole number. */
export function identityOf(text: string): bigint | null {
  const t = text.trim();
  if (t === "") return 0n;
  return /^\d{1,30}$/.test(t) ? BigInt(t) : null;
}

export interface RegistrationInput {
  wallet: Address | undefined;
  signerText: string;
  /** agentOfSigner(signer); undefined while loading. */
  signerAgent: bigint | undefined;
  payoutText: string;
  identityText: string;
  /** The ERC-8004 identity registry the AgentRegistry checks (null when disabled). */
  identityRegistry: Address | null;
  /** ownerOf(identity); null when it does not exist, undefined while loading. */
  identityOwner: Address | null | undefined;
  /** Bond to post (null when the field is not a number). */
  bond: bigint | null;
  minBond: bigint;
  /** The wallet's USDG; undefined while loading. */
  balance: bigint | undefined;
  usdgDecimals: number;
}

/** The register form's live checks. A "fail" blocks sending; a "warn" does not. */
export function registrationChecks(i: RegistrationInput): Check[] {
  const usdg = (x: bigint) => `${fmtAmount(x, i.usdgDecimals)} USDG`;
  const signer = addressOf(i.signerText);
  const checks: Check[] = [];

  checks.push(
    !signer
      ? { id: "signer", label: "Signer", state: "fail", detail: "Enter the signer's 0x address." }
      : i.signerAgent === undefined
        ? { id: "signer", label: "Signer", state: "pending", detail: "Checking the registry…" }
        : i.signerAgent > 0n
          ? {
              id: "signer",
              label: "Signer",
              state: "fail",
              detail: `${shortAddr(signer)} already signs for agent ${i.signerAgent}. One agent per signer: use a fresh key.`,
            }
          : {
              id: "signer",
              label: "Signer",
              state: "ok",
              detail: `${shortAddr(signer)} is free. Only this key may propose for your agent.`,
            },
  );

  if (!addressOf(i.payoutText)) {
    checks.push({ id: "payout", label: "Payout", state: "fail", detail: "Enter the payout 0x address." });
  }

  const id = identityOf(i.identityText);
  let identity: Check;
  if (id === null)
    identity = { id: "identity", label: "ERC-8004", state: "fail", detail: "Not a whole number." };
  else if (id === 0n)
    identity = { id: "identity", label: "ERC-8004", state: "ok", detail: "None linked (optional)." };
  else if (!i.identityRegistry)
    identity = {
      id: "identity",
      label: "ERC-8004",
      state: "ok",
      detail: `No identity registry on this network: #${id} is stored unchecked.`,
    };
  else if (i.identityOwner === undefined)
    identity = { id: "identity", label: "ERC-8004", state: "pending", detail: "Checking the identity…" };
  else if (i.identityOwner === null)
    identity = {
      id: "identity",
      label: "ERC-8004",
      state: "fail",
      detail: `Identity #${id} does not exist.`,
    };
  else if (i.wallet && i.identityOwner.toLowerCase() === i.wallet.toLowerCase())
    identity = {
      id: "identity",
      label: "ERC-8004",
      state: "ok",
      detail: `Your wallet owns identity #${id}.`,
    };
  else
    identity = {
      id: "identity",
      label: "ERC-8004",
      state: "fail",
      detail: `Identity #${id} belongs to ${shortAddr(i.identityOwner)}, not your wallet.`,
    };
  checks.push(identity);

  if (i.bond === null) {
    checks.push({
      id: "balance",
      label: "USDG",
      state: "fail",
      detail: "Enter the bond in USDG (0 to bond later).",
    });
  } else if (i.bond === 0n) {
    checks.push({ id: "balance", label: "USDG", state: "ok", detail: "No bond now." });
  } else if (i.balance === undefined) {
    checks.push({ id: "balance", label: "USDG", state: "pending", detail: "Reading your balance…" });
  } else {
    checks.push(
      i.balance >= i.bond
        ? {
            id: "balance",
            label: "USDG",
            state: "ok",
            detail: `You hold ${usdg(i.balance)}, enough for the bond.`,
          }
        : {
            id: "balance",
            label: "USDG",
            state: "fail",
            detail: `You hold ${usdg(i.balance)}; the bond is ${usdg(i.bond)}.`,
          },
    );
  }

  const bond = i.bond ?? 0n;
  checks.push(
    bond >= i.minBond
      ? { id: "bond", label: "Bond", state: "ok", detail: `Meets the ${usdg(i.minBond)} minimum.` }
      : {
          id: "bond",
          label: "Bond",
          state: "warn",
          detail: `An agent with bond < minBond (${usdg(i.minBond)}) cannot propose. You can top it up later.`,
        },
  );
  return checks;
}

/** Whether any check blocks sending (a failure, or one still loading). */
export const blocked = (checks: Check[]) => checks.some((c) => c.state === "fail" || c.state === "pending");

// ------------------------------------------------------------------ the vault form

/** The mandate form, in the units people think in. */
export interface MandateForm {
  minDelta: string;
  maxDelta: string;
  minPremiumPct: string;
  minYieldBps: string;
  maxSharePct: string;
  minTenorDays: string;
  maxTenorDays: string;
}

const trim = (n: number) => String(Number(n.toFixed(4)));

export const DEFAULT_MANDATE_FORM: MandateForm = {
  minDelta: (DEFAULT_MANDATE.minDeltaBps / 10_000).toFixed(2),
  maxDelta: (DEFAULT_MANDATE.maxDeltaBps / 10_000).toFixed(2),
  minPremiumPct: trim(DEFAULT_MANDATE.minPremiumBps / 100),
  minYieldBps: String(DEFAULT_MANDATE.minYieldBps),
  maxSharePct: trim(DEFAULT_MANDATE.maxShareSoldBps / 100),
  minTenorDays: trim(DEFAULT_MANDATE.minTenor / 86_400),
  maxTenorDays: trim(DEFAULT_MANDATE.maxTenor / 86_400),
};

/** The on-chain mandate for a form, or the fields that are not numbers. */
export function mandateOf(f: MandateForm): { mandate: Mandate | null; problems: string[] } {
  const num = (s: string) => (/^\s*\d+(\.\d+)?\s*$/.test(s) ? Number(s) : null);
  const fields: [keyof MandateForm, string, number][] = [
    ["minDelta", "Min |delta|", 10_000],
    ["maxDelta", "Max |delta|", 10_000],
    ["minPremiumPct", "Premium floor", 100],
    ["minYieldBps", "Min yield", 1],
    ["maxSharePct", "Max share sold", 100],
    ["minTenorDays", "Min tenor", 86_400],
    ["maxTenorDays", "Max tenor", 86_400],
  ];
  const bad = fields.filter(([k]) => num(f[k]) === null).map(([, label]) => `${label} must be a number`);
  if (bad.length > 0) return { mandate: null, problems: bad };
  const v = (k: keyof MandateForm, scale: number) => Math.round((num(f[k]) as number) * scale);
  const mandate: Mandate = {
    minDeltaBps: v("minDelta", 10_000),
    maxDeltaBps: v("maxDelta", 10_000),
    minPremiumBps: v("minPremiumPct", 100),
    minYieldBps: v("minYieldBps", 1),
    maxShareSoldBps: v("maxSharePct", 100),
    minTenor: v("minTenorDays", 86_400),
    maxTenor: v("maxTenorDays", 86_400),
  };
  return { mandate, problems: mandateProblems(mandate) };
}

/** The protocol floors every mandate must pass, in words. */
export const FLOORS = `premium at least ${MIN_PREMIUM_FLOOR_BPS / 100}% of fair value, tenor at most ${MAX_TENOR_CAP / 86_400} days`;

/** Default share name and symbol for an agent's vault, avoiding symbols already taken on the network. */
export function vaultNames(
  stock: string,
  isCall: boolean,
  agentId: bigint,
  taken: readonly string[],
): { name: string; symbol: string } {
  const lower = new Set(taken.map((s) => s.toLowerCase()));
  const base = `s${stock}-${isCall ? "CC" : "CSP"}-A${agentId}`;
  let symbol = base;
  for (let n = 2; lower.has(symbol.toLowerCase()); n++) symbol = `${base}-${n}`;
  return {
    name: `Strike ${stock} ${isCall ? "Covered Call" : "Cash-Secured Put"} (agent ${agentId})`,
    symbol,
  };
}

export interface VaultCheckInput {
  allowed: boolean | undefined;
  mandateProblems: string[];
  depositCap: bigint | null;
  maxDepositCap: bigint;
  capUnit: string;
  capDecimals: number;
  agentActive: boolean;
  minBond: bigint;
  usdgDecimals: number;
}

/** The vault form's live checks. */
export function vaultChecks(i: VaultCheckInput): Check[] {
  const cap = (x: bigint) => `${fmtAmount(x, i.capDecimals)} ${i.capUnit}`;
  return [
    i.allowed === undefined
      ? { id: "stock", label: "Stock", state: "pending", detail: "Checking the allow-list…" }
      : i.allowed
        ? { id: "stock", label: "Stock", state: "ok", detail: "Allow-listed for vaults." }
        : { id: "stock", label: "Stock", state: "fail", detail: "Not allow-listed on this network." },
    i.mandateProblems.length === 0
      ? { id: "mandate", label: "Mandate", state: "ok", detail: `Passes the protocol floors: ${FLOORS}.` }
      : { id: "mandate", label: "Mandate", state: "fail", detail: `${i.mandateProblems.join("; ")}.` },
    i.depositCap === null || i.depositCap === 0n
      ? { id: "cap", label: "Deposit cap", state: "fail", detail: "Enter a positive deposit cap." }
      : i.depositCap > i.maxDepositCap
        ? {
            id: "cap",
            label: "Deposit cap",
            state: "fail",
            detail: `Above the factory's ceiling of ${cap(i.maxDepositCap)}.`,
          }
        : { id: "cap", label: "Deposit cap", state: "ok", detail: `Within the factory's ceiling.` },
    i.agentActive
      ? {
          id: "agent",
          label: "Agent",
          state: "ok",
          detail: "Bonded: it can propose once the vault has deposits.",
        }
      : {
          id: "agent",
          label: "Agent",
          state: "warn",
          detail: `Not bonded to ${fmtAmount(i.minBond, i.usdgDecimals)} USDG yet: it cannot propose until it is.`,
        },
  ];
}
