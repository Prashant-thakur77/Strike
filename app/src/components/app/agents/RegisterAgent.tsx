"use client";

import Link from "next/link";
import {
  type SignerConsent,
  agentRegistryAbi,
  agentRegistryV3Abi,
  consentSignerOf,
  createStrikeClient,
  vaultFactoryAbi,
} from "@strike/sdk";
import { AlertTriangle, ArrowUpRight, Check as CheckIcon, LoaderCircle, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { type Address, type Hex, erc20Abi, formatUnits } from "viem";
import { useConnection, useSignTypedData } from "wagmi";
import { ConnectButton } from "@/components/site/ConnectButton";
import { useVaults } from "@/hooks/queries";
import {
  findCreatedVault,
  useIdentityOwner,
  useOnboarding,
  useSignerAgent,
  type OnboardingState,
} from "@/hooks/useAgentOnboarding";
import { useDebounced } from "@/hooks/useDebounced";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { CHAIN_META } from "@/lib/chains";
import { fmtAmount, fmtDuration, parseAmount, shortAddr } from "@/lib/format";
import { LINKS } from "@/lib/links";
import {
  type Check,
  DEFAULT_MANDATE_FORM,
  FLOORS,
  type MandateForm,
  addressOf,
  blocked,
  identityOf,
  mandateOf,
  registrationChecks,
  vaultChecks,
  vaultNames,
} from "@/lib/onboarding";
import type { AgentRow, Registry } from "@/lib/reads";
import { AmountField } from "../AmountField";
import { Fold } from "../Fold";
import { TxNote } from "../TxNote";
import s from "./register.module.css";

const days = (seconds: number) =>
  seconds % 86_400 === 0 ? `${seconds / 86_400} days` : fmtDuration(seconds);

/** "Run your own agent": the three steps, then (behind a fold) register + bond, and a vault run by the agent. */
export function RegisterAgent({ registry }: { registry: Registry }) {
  const ob = useOnboarding().data;
  const dec = registry.usdg.decimals;
  const usdg = (x: bigint) => `${fmtAmount(x, dec)} USDG`;
  return (
    <div className={s.root}>
      <ol className={s.steps}>
        <li>
          <span className="index">01</span>
          <h3 className={s.stepTitle}>Register</h3>
          <p>
            Your wallet becomes the agent&apos;s owner. The <strong>signer</strong> is the only key that may
            propose (one agent per signer); the <strong>payout</strong> address gets the agent&apos;s fee
            share. Linking an ERC-8004 identity is optional.
            {ob?.registryVersion === "v3"
              ? " On this network a signer key other than your wallet first signs its consent (EIP-712)."
              : ""}
          </p>
        </li>
        <li>
          <span className="index">02</span>
          <h3 className={s.stepTitle}>Bond</h3>
          <p>
            Post at least <strong>{usdg(registry.minBond)}</strong>: an agent below the minimum cannot
            propose. Each rejected proposal costs {usdg(registry.slashAmount)} (paid to that vault&apos;s
            depositors); {registry.maxStrikes} strikes suspend the agent.
            {ob ? ` Unbonding takes ${days(ob.unbondDelay)} and stays slashable.` : ""}
          </p>
        </li>
        <li>
          <span className="index">03</span>
          <h3 className={s.stepTitle}>Run a vault</h3>
          <p>
            Create your own vault on an allowed stock, with a mandate and your agent (you become its curator),
            or ask a vault&apos;s curator to assign your agent id. Every mandate must pass the protocol
            floors: {FLOORS}.
          </p>
        </li>
      </ol>
      <p className={s.agentsNote}>
        AI agents can do the same without the app: <code className="mono">register_agent</code> and{" "}
        <code className="mono">create_vault</code> in the Strike MCP server, or the example agent&apos;s{" "}
        <code className="mono">--register</code>.{" "}
        <a href={`${LINKS.skill}#join-as-a-new-agent`} target="_blank" rel="noreferrer" className="text-link">
          Skill file <ArrowUpRight size={11} aria-hidden />
        </a>
      </p>
      <Fold closed summary="Register an agent" openSummary="Hide the form">
        <Onboard registry={registry} ob={ob} />
      </Fold>
    </div>
  );
}

function Onboard({ registry, ob }: { registry: Registry; ob: OnboardingState | undefined }) {
  const { address, isConnected } = useConnection();
  const [chosen, setChosen] = useState<bigint | null>(null);
  if (!isConnected || !address) {
    return (
      <div className={s.connect}>
        <p className="body">Connect the wallet that will own the agent and pay its bond.</p>
        <ConnectButton />
      </div>
    );
  }
  if (!ob) return <p className={s.muted}>Reading the registry…</p>;
  const mine = registry.agents.filter((a) => a.owner.toLowerCase() === address.toLowerCase());
  const agent = mine.find((a) => a.id === chosen) ?? (chosen === null ? mine.at(-1) : undefined);
  return (
    <div className={s.forms}>
      {mine.length > 0 ? (
        <div className={s.mine} role="group" aria-label="Your agents">
          <span className="micro micro-muted">Your agents</span>
          <div className={s.chips}>
            {mine.map((a) => (
              <button
                key={a.id.toString()}
                type="button"
                className="chip"
                aria-pressed={agent?.id === a.id}
                onClick={() => setChosen(a.id)}
              >
                Agent {a.id.toString()} · {fmtAmount(a.bond, registry.usdg.decimals)} USDG
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <RegisterForm registry={registry} ob={ob} wallet={address} onRegistered={setChosen} />
      {agent ? <CreateVault key={agent.id.toString()} agent={agent} registry={registry} ob={ob} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ register + bond

/**
 * Signers registered from this browser session (`chainId:registry:signer` → agent id): after a successful register the
 * form's live check sees the signer taken by the new agent, which is expected, not a "use a fresh key" warning.
 */
const registeredThisSession = new Map<string, bigint>();
const sessionKey = (chainId: number, registry: string, signer: string) =>
  `${chainId}:${registry.toLowerCase()}:${signer.toLowerCase()}`;

function RegisterForm({
  registry,
  ob,
  wallet,
  onRegistered,
}: {
  registry: Registry;
  ob: OnboardingState;
  wallet: Address;
  onRegistered: (id: bigint) => void;
}) {
  const { client, deployment, chainId } = useStrike();
  const tx = useTx();
  const { mutateAsync: signTypedData } = useSignTypedData();
  const dec = ob.usdgDecimals;
  const [signerText, setSignerText] = useState<string | null>(null);
  const [payoutText, setPayoutText] = useState<string | null>(null);
  const [identityText, setIdentityText] = useState("");
  const [bondText, setBondText] = useState<string | null>(null);
  const [consentSigText, setConsentSigText] = useState("");
  const [consentDeadlineText, setConsentDeadlineText] = useState("");
  const [consentMessage, setConsentMessage] = useState<string | null>(null);
  const [stepsDone, setStepsDone] = useState<string[]>([]);
  const [done, setDone] = useState<{ id: bigint; bond: bigint } | null>(null);

  const signerValue = signerText ?? wallet;
  const payoutValue = payoutText ?? wallet;
  const bondValue = bondText ?? formatUnits(ob.minBond, dec);
  const bond = bondValue.trim() === "" ? null : parseAmount(bondValue, dec);
  const signer = addressOf(useDebounced(signerValue, 250));
  const identity = identityOf(useDebounced(identityText, 250));
  const signerAgent = useSignerAgent(signer);
  const identityOwner = useIdentityOwner(ob.identityRegistry, identity);

  const checks = registrationChecks({
    wallet,
    signerText: signerValue,
    signerAgent: signer && addressOf(signerValue) === signer ? signerAgent.data : undefined,
    registeredAs:
      signer && deployment
        ? registeredThisSession.get(sessionKey(chainId, deployment.agentRegistry, signer))
        : undefined,
    payoutText: payoutValue,
    identityText,
    identityRegistry: ob.identityRegistry,
    identityOwner:
      identity !== null && identity > 0n && identityOf(identityText) === identity
        ? identityOwner.data
        : undefined,
    bond,
    minBond: ob.minBond,
    balance: ob.balance ?? undefined,
    usdgDecimals: dec,
  });
  // v3: a signer key that is not this wallet consents with an EIP-712 `Register` signature before `register`.
  const v3 = ob.registryVersion === "v3";
  const signerNow = addressOf(signerValue);
  const separate = v3 && signerNow !== null && signerNow.toLowerCase() !== wallet.toLowerCase();
  const pasted = consentSigText.trim();
  if (v3 && signerNow) {
    checks.push(
      separate
        ? pasted
          ? {
              id: "consent",
              label: "Consent",
              state:
                /^0x[0-9a-fA-F]{130}$/.test(pasted) && /^\d+$/.test(consentDeadlineText.trim())
                  ? "ok"
                  : "fail",
              detail: /^0x[0-9a-fA-F]{130}$/.test(pasted)
                ? /^\d+$/.test(consentDeadlineText.trim())
                  ? `The pasted consent is checked against ${shortAddr(signerNow)} before anything is sent.`
                  : "Enter the deadline the consent was signed with (unix seconds)."
                : "A consent signature is 65 bytes: 0x and 130 hex digits.",
            }
          : {
              id: "consent",
              label: "Consent",
              state: "warn",
              detail: `This registry (v3) needs the signer's consent: your wallet will be asked to sign it as ${shortAddr(signerNow)}, so that key must be one of your wallet's connected accounts. Otherwise paste a signature made with it below.`,
            }
        : {
            id: "consent",
            label: "Consent",
            state: "ok",
            detail: "Your wallet is the signer, so this registry (v3) needs no consent signature.",
          },
    );
  }
  const needsApproval = bond !== null && bond > 0n && (ob.allowance ?? 0n) < bond;
  const canSend = !blocked(checks) && !tx.busy && !!client && !!deployment;
  const lowBalance = checks.some((c) => c.id === "balance" && c.state === "fail");

  // v3's steps, in the order they run.
  const steps: string[] = v3
    ? [
        ...(separate ? ["Sign consent"] : []),
        "Register",
        ...(bond !== null && bond > 0n && needsApproval ? ["Approve USDG"] : []),
        ...(bond !== null && bond > 0n ? ["Post bond"] : []),
      ]
    : [];
  const label = v3
    ? stepSentence(steps)
    : bond === null || bond === 0n
      ? "Register agent"
      : needsApproval
        ? "Approve, register & bond"
        : "Register & bond";

  const strike = () =>
    createStrikeClient({ publicClient: client!, chainId, addresses: deployment!, registryVersion: "v3" });

  async function copyConsentMessage(signerAddr: Address, payoutAddr: Address, id: bigint) {
    const deadline = consentDeadlineText.trim();
    const td = await strike().registerConsentTypedData({
      signer: signerAddr,
      payout: payoutAddr,
      erc8004Id: id,
      owner: wallet,
      deadline: /^\d+$/.test(deadline) ? BigInt(deadline) : undefined,
    });
    setConsentDeadlineText(td.message.deadline.toString());
    const json = JSON.stringify(td, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    setConsentMessage(json);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      // no clipboard permission: the message is shown below
    }
  }

  async function submitV3(signerAddr: Address, payoutAddr: Address, id: bigint, amount: bigint) {
    if (!client || !deployment) return;
    const reg = { address: deployment.agentRegistry, chainId } as const;
    setStepsDone([]);
    let consent: SignerConsent = { signature: "0x", deadline: 0n };
    if (separate) {
      const signed = await tx.sign("Sign consent", async () => {
        if (pasted) {
          const deadline = BigInt(consentDeadlineText.trim());
          const td = await strike().registerConsentTypedData({
            signer: signerAddr,
            payout: payoutAddr,
            erc8004Id: id,
            owner: wallet,
            deadline,
          });
          const by = await consentSignerOf(td, pasted as Hex);
          if (by !== signerAddr) {
            throw new Error(
              `the pasted signature ${by ? `was made by ${shortAddr(by)}` : "is malformed"}, not by the signer ${shortAddr(signerAddr)} for this owner, payout, identity, deadline and the signer's current nonce.`,
            );
          }
          if (deadline < (await client.getBlock()).timestamp)
            throw new Error("the pasted consent has expired.");
          return { signature: pasted as Hex, deadline };
        }
        const td = await strike().registerConsentTypedData({
          signer: signerAddr,
          payout: payoutAddr,
          erc8004Id: id,
          owner: wallet,
        });
        try {
          const signature = await signTypedData({ account: signerAddr, ...td });
          return { signature, deadline: td.message.deadline };
        } catch (err) {
          if (/not found for connector/i.test(String((err as Error)?.message ?? err))) {
            throw new Error(
              `your wallet does not hold the signer key ${shortAddr(signerAddr)}. Connect that account too, or paste a signature made with it.`,
            );
          }
          throw err;
        }
      });
      if (!signed) return;
      consent = signed;
      setStepsDone(["Sign consent"]);
    }
    const ok = await tx.exec("Register", (w) =>
      w({
        ...reg,
        abi: agentRegistryV3Abi,
        functionName: "register",
        args: [signerAddr, payoutAddr, id, consent.deadline, consent.signature],
      }),
    );
    if (!ok) return;
    setStepsDone((d) => [...d, "Register"]);
    const agentId = await client.readContract({
      ...reg,
      abi: agentRegistryAbi,
      functionName: "agentOfSigner",
      args: [signerAddr],
    });
    registeredThisSession.set(sessionKey(chainId, deployment.agentRegistry, signerAddr), agentId);
    setDone({ id: agentId, bond: 0n });
    onRegistered(agentId);
    if (amount === 0n) return;
    if (needsApproval) {
      const approved = await tx.exec("Approve USDG", (w) =>
        w({
          address: deployment.usdg,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.agentRegistry, amount],
          chainId,
        }),
      );
      if (!approved) return;
      setStepsDone((d) => [...d, "Approve USDG"]);
    }
    const bonded = await tx.exec("Post bond", (w) =>
      w({ ...reg, abi: agentRegistryAbi, functionName: "postBond", args: [agentId, amount] }),
    );
    if (bonded) {
      setStepsDone((d) => [...d, "Post bond"]);
      setDone({ id: agentId, bond: amount });
    }
  }

  async function submit() {
    const signerAddr = addressOf(signerValue);
    const payoutAddr = addressOf(payoutValue);
    const id = identityOf(identityText);
    if (!client || !deployment || !signerAddr || !payoutAddr || id === null || bond === null) return;
    if (v3) return submitV3(signerAddr, payoutAddr, id, bond);
    const reg = { address: deployment.agentRegistry, abi: agentRegistryAbi, chainId } as const;
    if (needsApproval) {
      const ok = await tx.exec("Approve USDG", (w) =>
        w({
          address: deployment.usdg,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.agentRegistry, bond],
          chainId,
        }),
      );
      if (!ok) return;
    }
    const ok = await tx.exec("Register agent", (w) =>
      w({ ...reg, functionName: "register", args: [signerAddr, payoutAddr, id] }),
    );
    if (!ok) return;
    const agentId = await client.readContract({ ...reg, functionName: "agentOfSigner", args: [signerAddr] });
    registeredThisSession.set(sessionKey(chainId, deployment.agentRegistry, signerAddr), agentId);
    setDone({ id: agentId, bond: 0n });
    onRegistered(agentId);
    if (bond > 0n) {
      const bonded = await tx.exec("Post bond", (w) =>
        w({ ...reg, functionName: "postBond", args: [agentId, bond] }),
      );
      if (bonded) setDone({ id: agentId, bond });
    }
  }

  const registered = done ? registry.agents.find((a) => a.id === done.id) : undefined;
  return (
    <form
      className={s.form}
      aria-label="Register an agent"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void submit();
      }}
    >
      <div className={s.fields}>
        <TextField
          label="Signer"
          value={signerValue}
          onChange={setSignerText}
          hint="The key that proposes. Defaults to this wallet; a separate key is safer (the owner can rotate it)."
        />
        <TextField
          label="Payout"
          value={payoutValue}
          onChange={setPayoutText}
          hint="Receives the agent's share of performance fees."
        />
        <TextField
          label="ERC-8004 identity (optional)"
          value={identityText}
          onChange={setIdentityText}
          placeholder="None"
          inputMode="numeric"
          hint={
            ob.identityRegistry
              ? `Token id on the identity registry ${shortAddr(ob.identityRegistry)}; your wallet must own it.`
              : "No identity registry on this network."
          }
        />
        <div className={s.bondField}>
          <AmountField
            label="Bond"
            value={bondValue}
            onChange={setBondText}
            unit="USDG"
            decimals={dec}
            max={ob.balance ?? undefined}
            maxLabel="Balance"
            compact
          />
          <span className={s.hint}>
            Minimum {fmtAmount(ob.minBond, dec)} USDG. 0 registers without a bond.
          </span>
        </div>
      </div>
      {separate && signerNow ? (
        <Fold closed summary="Signer key not in this wallet?" openSummary="Hide">
          <div className={s.consent}>
            <p className={s.hint}>
              The signer key can consent anywhere: copy the consent message (EIP-712 typed data for{" "}
              {shortAddr(signerNow)}, at its current nonce), sign it with that key (the Strike SDK&apos;s{" "}
              <code className="mono">signRegisterConsent</code>, or any EIP-712 signer), and paste the
              signature and its deadline here. Change the owner, payout or identity and the message changes
              too.
            </p>
            <div className={s.fields}>
              <TextField
                label="Consent signature"
                value={consentSigText}
                onChange={setConsentSigText}
                hint="65 bytes from the signer key. Empty: your wallet is asked to sign as the signer."
              />
              <TextField
                label="Consent deadline"
                value={consentDeadlineText}
                onChange={setConsentDeadlineText}
                placeholder="Unix seconds"
                inputMode="numeric"
                hint="The deadline in the signed message (copying the message fills it in)."
              />
            </div>
            <div className={s.actions}>
              <button
                type="button"
                className="chip"
                disabled={
                  !client || !deployment || !addressOf(payoutValue) || identityOf(identityText) === null
                }
                onClick={() =>
                  void copyConsentMessage(
                    signerNow,
                    addressOf(payoutValue)!,
                    identityOf(identityText)!,
                  ).catch((err: unknown) => setConsentMessage(`Could not build the message: ${String(err)}`))
                }
              >
                Copy consent message
              </button>
            </div>
            {consentMessage ? (
              <textarea
                className={s.consentMessage}
                aria-label="Consent message"
                readOnly
                rows={8}
                value={consentMessage}
              />
            ) : null}
          </div>
        </Fold>
      ) : null}
      <Checks checks={checks} label="Registration checks" />
      {lowBalance && CHAIN_META[chainId]?.testnet ? (
        <p className={s.hint}>
          Short of USDG?{" "}
          <Link href="/app/faucet" className="text-link">
            Get test USDG
          </Link>
          .
        </p>
      ) : null}
      <div className={s.actions}>
        <button type="submit" className="pill" disabled={!canSend}>
          {label}
        </button>
        <TxNote tx={tx} />
      </div>
      {v3 ? (
        <ol className={s.txSteps} aria-label="Steps">
          {steps.map((step, i) => (
            <li
              key={step}
              data-state={
                stepsDone.includes(step)
                  ? "done"
                  : tx.label === step && tx.phase === "error"
                    ? "error"
                    : tx.label === step && tx.busy
                      ? "active"
                      : "todo"
              }
            >
              <span className="index">{String(i + 1).padStart(2, "0")}</span> {step}
            </li>
          ))}
        </ol>
      ) : null}
      {done ? (
        <div className={s.success} role="status">
          <span className="micro micro-muted">Registered</span>
          <p>
            <strong>Agent {done.id.toString()}</strong> is registered
            {done.bond > 0n ? ` and bonded ${fmtAmount(done.bond, dec)} USDG` : ""}.{" "}
            {registered && registered.bond >= ob.minBond
              ? "It can propose once a vault it runs has deposits."
              : `It cannot propose until its bond reaches ${fmtAmount(ob.minBond, dec)} USDG.`}{" "}
            It now shows in the leaderboard above.
          </p>
        </div>
      ) : null}
    </form>
  );
}

// ------------------------------------------------------------------ create a vault

function CreateVault({ agent, registry, ob }: { agent: AgentRow; registry: Registry; ob: OnboardingState }) {
  const { client, deployment, chainId } = useStrike();
  const { address } = useConnection();
  const tx = useTx();
  const vaults = useVaults().data;
  const allowed = ob.stocks.filter((x) => x.allowed);
  const [stockSym, setStockSym] = useState<string | null>(null);
  const [isCall, setIsCall] = useState(false);
  const [capText, setCapText] = useState<string | null>(null);
  const [form, setForm] = useState<MandateForm>(DEFAULT_MANDATE_FORM);
  const [created, setCreated] = useState<{ address: Address; symbol: string } | null>(null);
  const headingId = useId();

  // Default: a stock that already has vaults (its feed and volatility are proven), else the first allowed one.
  const listed = new Set((vaults ?? []).map((v) => v.summary.underlying.address.toLowerCase()));
  const stock =
    allowed.find((x) => x.symbol === stockSym) ??
    allowed.find((x) => listed.has(x.address.toLowerCase())) ??
    allowed[0];
  const capDecimals = isCall ? (stock?.decimals ?? 18) : ob.usdgDecimals;
  const capUnit = isCall ? (stock?.symbol ?? "") : "USDG";
  const defaultCap = useMemo(() => {
    const want = (isCall ? 10_000n : 1_000_000n) * 10n ** BigInt(capDecimals);
    return want > ob.maxDepositCap ? ob.maxDepositCap : want;
  }, [isCall, capDecimals, ob.maxDepositCap]);
  const capValue = capText ?? formatUnits(defaultCap, capDecimals);
  const cap = parseAmount(capValue, capDecimals);
  const { mandate, problems } = mandateOf(form);
  const names = vaultNames(
    stock?.symbol ?? "",
    isCall,
    agent.id,
    (vaults ?? []).map((v) => v.summary.symbol),
  );
  const active = agent.status === 1 && agent.bond >= registry.minBond && agent.strikes < registry.maxStrikes;
  const checks = vaultChecks({
    allowed: stock ? stock.allowed : false,
    mandateProblems: problems,
    depositCap: cap,
    maxDepositCap: ob.maxDepositCap,
    capUnit,
    capDecimals,
    agentActive: active,
    minBond: registry.minBond,
    usdgDecimals: ob.usdgDecimals,
  });
  const canSend = !!stock && !!mandate && !blocked(checks) && !tx.busy && !!client && !!deployment;

  async function submit() {
    if (!client || !deployment || !stock || !mandate || cap === null || !address) return;
    const params = {
      underlying: stock.address,
      isCall,
      agentId: agent.id,
      depositCap: cap,
      name: names.name,
      symbol: names.symbol,
      mandate,
    };
    const ok = await tx.exec("Create vault", (w) =>
      w({
        address: deployment.vaultFactory,
        abi: vaultFactoryAbi,
        functionName: "createVault",
        args: [params],
        chainId,
      }),
    );
    if (!ok) return;
    const vault = await findCreatedVault(client, deployment, address, agent.id);
    if (vault) setCreated({ address: vault, symbol: names.symbol });
  }

  const set = (k: keyof MandateForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <section className={s.vault} aria-labelledby={headingId}>
      <div className={s.vaultHead}>
        <h3 id={headingId} className={s.vaultTitle}>
          Create a vault run by agent {agent.id.toString()}
        </h3>
        <p className={s.hint}>
          You become its curator; agent {agent.id.toString()}&apos;s signer ({shortAddr(agent.signer)}) opens
          its epochs and proposes. The mandate is fixed for the vault&apos;s lifetime.
        </p>
      </div>
      {allowed.length === 0 ? (
        <p className={s.hint}>No stock token is allow-listed for vaults on this network yet.</p>
      ) : (
        <form
          className={s.form}
          aria-label="Create a vault"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) void submit();
          }}
        >
          <div className={s.pickers}>
            <div role="group" aria-label="Stock" className={s.picker}>
              <span className="micro micro-muted">Stock</span>
              <div className={s.chips}>
                {allowed.map((x) => (
                  <button
                    key={x.symbol}
                    type="button"
                    className="chip"
                    aria-pressed={stock?.symbol === x.symbol}
                    onClick={() => {
                      setStockSym(x.symbol);
                      setCapText(null);
                    }}
                  >
                    {x.symbol}
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-label="Kind" className={s.picker}>
              <span className="micro micro-muted">Kind</span>
              <div className={s.chips}>
                {(
                  [
                    [false, "Cash-secured put"],
                    [true, "Covered call"],
                  ] as const
                ).map(([call, text]) => (
                  <button
                    key={text}
                    type="button"
                    className="chip"
                    aria-pressed={isCall === call}
                    onClick={() => {
                      setIsCall(call);
                      setCapText(null);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
            <div className={s.bondField}>
              <AmountField
                label="Deposit cap"
                value={capValue}
                onChange={setCapText}
                unit={capUnit}
                decimals={capDecimals}
                compact
              />
              <span className={s.hint}>
                Collateral: {isCall ? `${stock?.symbol} tokens` : "USDG"}. Share token {names.symbol}.
              </span>
            </div>
          </div>
          <fieldset className={s.mandate}>
            <legend className="micro micro-muted">Mandate</legend>
            <MiniField label="Min |delta|" value={form.minDelta} onChange={set("minDelta")} />
            <MiniField label="Max |delta|" value={form.maxDelta} onChange={set("maxDelta")} />
            <MiniField
              label="Premium floor"
              unit="% of fair"
              value={form.minPremiumPct}
              onChange={set("minPremiumPct")}
            />
            <MiniField label="Min yield" unit="bps" value={form.minYieldBps} onChange={set("minYieldBps")} />
            <MiniField
              label="Max sold"
              unit="% of vault"
              value={form.maxSharePct}
              onChange={set("maxSharePct")}
            />
            <MiniField
              label="Min tenor"
              unit="days"
              value={form.minTenorDays}
              onChange={set("minTenorDays")}
            />
            <MiniField
              label="Max tenor"
              unit="days"
              value={form.maxTenorDays}
              onChange={set("maxTenorDays")}
            />
          </fieldset>
          <Checks checks={checks} label="Vault checks" />
          <div className={s.actions}>
            <button type="submit" className="pill" disabled={!canSend}>
              Create vault
            </button>
            <TxNote tx={tx} />
          </div>
          {created ? (
            <div className={s.success} role="status">
              <span className="micro micro-muted">Vault created</span>
              <p>
                <Link href={`/app/vault/${created.address}`} className="text-link">
                  {created.symbol} <ArrowUpRight size={11} aria-hidden />
                </Link>{" "}
                is live and run by agent {agent.id.toString()}. Next: deposits, then the agent proposes during
                NYSE hours (<code className="mono">risk_check</code>, then{" "}
                <code className="mono">propose_epoch</code>).
              </p>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ bits

/** "Sign consent, register, approve USDG & post bond": the steps as the submit button's text. */
function stepSentence(steps: string[]): string {
  const words = steps.map((x, i) => (i === 0 ? x : x === "Approve USDG" ? "approve USDG" : x.toLowerCase()));
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} & ${words.at(-1)}`;
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder = "0x…",
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  inputMode?: "numeric";
}) {
  const id = useId();
  return (
    <div className={`field ${s.text}`}>
      <label htmlFor={id} className="micro micro-muted">
        {label}
      </label>
      <div className="input-row">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {hint ? <span className={s.hint}>{hint}</span> : null}
    </div>
  );
}

function MiniField({
  label,
  value,
  onChange,
  unit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
}) {
  const id = useId();
  return (
    <div className={s.mini}>
      <label htmlFor={id} className="micro micro-muted">
        {label}
      </label>
      <div className={s.miniRow}>
        <input
          id={id}
          value={value}
          inputMode="decimal"
          autoComplete="off"
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
        />
        {unit ? <span>{unit}</span> : null}
      </div>
    </div>
  );
}

const ICON = { ok: CheckIcon, fail: X, warn: AlertTriangle, pending: LoaderCircle } as const;

function Checks({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul className={s.checks} aria-label={label}>
      {checks.map((c) => {
        const Icon = ICON[c.state];
        return (
          <li key={c.id} data-state={c.state}>
            <Icon size={14} aria-hidden />
            <span className={s.checkLabel}>{c.label}</span>
            <span className={s.checkDetail}>{c.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}
