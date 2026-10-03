"use client";

import { AlertTriangle, ArrowUpRight, Check, RotateCw } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  D43_DOC,
  GOV_DEPLOYMENTS,
  GOV_EXPLORERS,
  KIND_ROLES,
  ROLE_INFO,
  STAGED_PATH_DOC,
  STAGES,
  type ContractKind,
  type GovChainId,
  type GovDeploymentJson,
  type GovHolderJson,
  type GovernanceJson,
  deploymentKeyOf,
  holderCounts,
  repoUrl,
  unknownHolders,
} from "@/lib/governance";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { PageIndex } from "../PageIndex";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import { TableWrap } from "../TableWrap";
import appStyles from "../app.module.css";
import { useGovernance } from "./useGovernance";
import styles from "./governance.module.css";

const SECTIONS = [
  { id: "holders", label: "Holders" },
  { id: "roles", label: "Roles" },
  { id: "actions", label: "Last actions" },
  { id: "staged", label: "Staged path" },
  { id: "check", label: "Check it" },
];

const OPTIONS = GOV_DEPLOYMENTS.map(({ record }) => ({
  key: deploymentKeyOf(record),
  chainId: record.chainId as GovChainId,
  label: `${record.chainId === 46630 ? "Robinhood Chain testnet" : "Arbitrum Sepolia"} ${record.version}`,
}));

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const n = (x: number) => x.toLocaleString("en-US");

function Out({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className ?? styles.link}>
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

function Addr({ chainId, address }: { chainId: GovChainId; address: string }) {
  return (
    <Out href={`${GOV_EXPLORERS[chainId]}/address/${address}`} className={`mono ${styles.link}`}>
      <span title={address}>{short(address)}</span>
    </Out>
  );
}

function Tx({ chainId, hash, children }: { chainId: GovChainId; hash: string; children?: ReactNode }) {
  return (
    <Out href={`${GOV_EXPLORERS[chainId]}/tx/${hash}`} className={`mono ${styles.link}`}>
      {children ?? short(hash)}
    </Out>
  );
}

const KIND_TEXT: Record<GovHolderJson["kind"], string> = {
  deployer: "Team EOA",
  keeper: "Team key",
  agent: "Agent key",
  team: "Team wallet",
  contract: "Contract",
  unknown: "Unknown holder",
};

function Holder({ chainId, h }: { chainId: GovChainId; h: GovHolderJson }) {
  return (
    <li className={styles.holder} data-testid="gov-holder" data-kind={h.kind}>
      <span className={styles.holderName}>
        {h.kind === "unknown" ? <AlertTriangle size={13} aria-hidden /> : null}
        {h.label}
      </span>
      <span className={styles.tag} data-kind={h.kind}>
        {KIND_TEXT[h.kind]}
      </span>
      <Addr chainId={chainId} address={h.address} />
    </li>
  );
}

/** Who holds each privileged role on every Strike contract, the role texts, the last admin actions and the staged
 *  path for the admin keys. The holders and actions come from /api/governance for each chain. */
export function GovernancePage() {
  const rh = useGovernance(46630);
  const arb = useGovernance(421614);
  const [selected, setSelected] = useState(OPTIONS[0]!.key);
  const option = OPTIONS.find((o) => o.key === selected) ?? OPTIONS[0]!;
  const query = option.chainId === 46630 ? rh : arb;
  const dep = query.data?.deployments.find((d) => d.key === option.key) ?? null;
  const loaded = [rh.data, arb.data].filter((g): g is GovernanceJson => Boolean(g));
  const allDeps = loaded.flatMap((g) => g.deployments.map((d) => ({ chainId: g.chainId, d })));
  const unknown = loaded.flatMap((g) => unknownHolders(g).map((u) => ({ ...u, chainId: g.chainId })));
  const distinct = new Set(
    allDeps.flatMap(({ d }) =>
      d.contracts.flatMap((c) => c.roles.flatMap((r) => r.holders.map((h) => h.address))),
    ),
  ).size;
  const slots = allDeps.reduce((s, { d }) => s + holderCounts(d).slots, 0);
  const pending = rh.isPending || arb.isPending;
  const failed = [rh, arb].filter((q) => q.isError).length;

  return (
    <>
      <PageHero
        index="09"
        label="Governance"
        right="Live · 46630 and 421614"
        title="Admin keys"
        lead={
          <>
            <p className="lead">
              Three deployments on two testnets, read from the chains when the page loads: role logs since
              each deploy block, every holder confirmed with hasRole, and the last admin actions with their
              transactions.
            </p>
            <p className={styles.leadNote}>
              Today the admin is the team&apos;s deployer key on the testnets (stage 0 below). On mainnet it
              is meant to be a Safe behind a 73-day timelock. The texts come from the{" "}
              <Out href={repoUrl("docs/audit-readiness.md#roles-and-trust")}>roles table</Out> and the{" "}
              <Out href={repoUrl(STAGED_PATH_DOC)}>trust model</Out>. The rest of the evidence is on the{" "}
              <Link href="/app/proof" className="text-link">
                proof page
              </Link>
              .
            </p>
          </>
        }
      />

      <MetaStrip
        cells={[
          { label: "Deployments", value: String(OPTIONS.length), sub: "46630 v2 and v3 · 421614 v3" },
          {
            label: "Roles with a holder",
            value: pending && !loaded.length ? <Skeleton width="2.5em" /> : String(slots),
            sub: "AccessControl roles and Ownable owners",
          },
          {
            label: "Distinct holders",
            value: pending && !loaded.length ? <Skeleton width="2em" /> : String(distinct),
            sub: "confirmed with hasRole or owner()",
          },
          {
            label: "Unknown holders",
            value: pending && !loaded.length ? <Skeleton width="1.5em" /> : String(unknown.length),
            sub: unknown.length ? "see the warning below" : "every holder is a team key or a Strike contract",
          },
        ]}
      />

      <PageIndex items={SECTIONS} />

      <div className={`${styles.body} ${appStyles.indexed}`}>
        <Rail
          index="01"
          label="Role holders"
          id="holders"
          note="Each deployment's RoleGranted and RoleRevoked logs since its deploy block, replayed in order; every holder they leave is then confirmed with hasRole at one block."
        >
          <div className={styles.block}>
            {unknown.length ? (
              <div className={styles.warn} role="alert" data-testid="gov-unknown">
                <p className={styles.warnTitle}>
                  <AlertTriangle size={16} aria-hidden /> {unknown.length} unknown holder
                  {unknown.length === 1 ? "" : "s"}: an address the team cannot name holds a role
                </p>
                <ul>
                  {unknown.map((u) => (
                    <li key={`${u.key}:${u.address}:${u.role}:${u.holder}`}>
                      <span className="mono">{u.key}</span> · {u.contractName} · {u.role} ·{" "}
                      <Addr chainId={u.chainId} address={u.holder} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : loaded.length ? (
              <p className={styles.ok} data-testid="gov-all-known">
                <Check size={14} aria-hidden /> Every holder on the {allDeps.length} deployment
                {allDeps.length === 1 ? "" : "s"} read so far is a team key or a Strike contract.
              </p>
            ) : null}

            <div className={styles.chips} role="group" aria-label="Deployment">
              {OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className="chip"
                  aria-pressed={o.key === selected}
                  onClick={() => setSelected(o.key)}
                  data-testid="gov-deployment"
                >
                  {o.label}
                </button>
              ))}
            </div>

            {query.isError ? (
              <div className={styles.error} role="status" data-testid="gov-error">
                <p>
                  Could not read {option.label}: {query.error.message}
                </p>
                <button type="button" className="chip" onClick={() => query.refetch()}>
                  <RotateCw size={13} aria-hidden /> Try again
                </button>
              </div>
            ) : !dep ? (
              <p className={styles.meta} data-testid="gov-loading">
                {query.data ? `${option.label} could not be read this time.` : `Reading ${option.label}…`}
              </p>
            ) : (
              <HolderTable chainId={option.chainId} dep={dep} generatedAt={query.data?.generatedAt ?? ""} />
            )}
            {failed ? (
              <p className={styles.meta}>
                {failed} of 2 chains could not be read; the counts above cover the rest.
              </p>
            ) : null}
          </div>
        </Rail>

        <Rail
          index="02"
          label="What each role can do"
          id="roles"
          note="Copied from the audit-readiness roles table and the trust model; roles they do not cover are described from the contract's own functions, linked."
        >
          <RoleTable />
        </Rail>

        <Rail
          index="03"
          label="Last admin actions"
          id="actions"
          note="Role grants and revokes and every admin setter event (PricerSet, OracleSet, FeedSet, SpotBufferSet, SigmaSet, TimingsSet and the rest), newest first, with the sender of each transaction."
        >
          <div className={styles.block}>
            <p className={styles.meta}>{option.label}. Choose another deployment under role holders.</p>
            {dep ? <ActionTable chainId={option.chainId} dep={dep} /> : <Skeleton width="12em" />}
          </div>
        </Rail>

        <Rail
          index="04"
          label="Staged path"
          id="staged"
          note="How the admin's power shrinks, each stage with commitments you can check with a test or a read."
        >
          <div className={styles.block}>
            <ol className={styles.stages} aria-label="Stages">
              {STAGES.map((s) => (
                <li
                  key={s.id}
                  className={styles.stage}
                  data-current={s.current || undefined}
                  data-testid="gov-stage"
                  id={s.id}
                >
                  <div className={styles.stageHead}>
                    <h3 className={styles.stageTitle}>{s.title}</h3>
                    {s.current ? (
                      <span className={styles.current} data-testid="gov-stage-current">
                        Current
                      </span>
                    ) : null}
                  </div>
                  <p className={styles.where}>{s.where}</p>
                  <p className={styles.text}>{s.text}</p>
                  <ul className={styles.commitments} aria-label={`What to hold us to, ${s.title}`}>
                    {s.commitments.map((c) => (
                      <li key={c.text}>
                        <p>{c.text}</p>
                        {c.tests.length ? (
                          <ul className={styles.tests}>
                            {c.tests.map((t) => (
                              <li key={t.name}>
                                <Out href={repoUrl(t.path)}>
                                  <span className="mono">{t.name}</span>
                                </Out>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            <p className={styles.meta}>
              The reasons and the alternatives we rejected: <Out href={repoUrl(D43_DOC)}>D43</Out> and the{" "}
              <Out href={repoUrl(STAGED_PATH_DOC)}>staged path</Out> in the trust model. Run the 12 timelock
              tests with{" "}
              <code className="mono">
                forge test --root contracts --match-path &quot;test/governance/*&quot;
              </code>
              .
            </p>
          </div>
        </Rail>

        <Rail index="05" label="Check it yourself" id="check" note="Read-only, no key needed.">
          <div className={styles.block}>
            <p className={styles.text}>
              Is the deployer still the EpochManager&apos;s admin on Robinhood Chain testnet v2?
            </p>
            <pre className={styles.code}>
              <code>
                cast call 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99
                &quot;hasRole(bytes32,address)(bool)&quot;
                0x0000000000000000000000000000000000000000000000000000000000000000
                0x26b277b434B1670f207Afd8946edA9AF78A613Ff --rpc-url https://rpc.testnet.chain.robinhood.com
              </code>
            </pre>
            <p className={styles.text}>Every pricer change on that EpochManager since its deploy block:</p>
            <pre className={styles.code}>
              <code>
                cast logs --address 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 &quot;PricerSet(address)&quot;
                --from-block 125880607 --rpc-url https://rpc.testnet.chain.robinhood.com
              </code>
            </pre>
            <p className={styles.meta}>
              The JSON behind this page:{" "}
              <a className="text-link mono" href="/api/governance?chain=46630">
                /api/governance?chain=46630
              </a>{" "}
              and{" "}
              <a className="text-link mono" href="/api/governance?chain=421614">
                ?chain=421614
              </a>
              .
            </p>
          </div>
        </Rail>
      </div>
    </>
  );
}

function HolderTable({
  chainId,
  dep,
  generatedAt,
}: {
  chainId: GovChainId;
  dep: GovDeploymentJson;
  generatedAt: string;
}) {
  return (
    <div className={styles.block} data-testid="gov-holders" data-deployment={dep.key}>
      <p className={styles.meta}>
        Read at block {n(dep.head)}
        {generatedAt ? ` on ${generatedAt.slice(0, 16).replace("T", " ")} UTC` : ""} · logs from deploy block{" "}
        {n(dep.deployBlock)} · {dep.contracts.length} contracts with a privileged role
      </p>
      {dep.warnings.length ? (
        <ul className={styles.warn} data-testid="gov-warnings">
          {dep.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <TableWrap stack>
        <table className={`${appStyles.table} ${styles.table}`} aria-label={`Role holders, ${dep.key}`}>
          <thead>
            <tr>
              <th scope="col">Contract</th>
              <th scope="col">Role</th>
              <th scope="col">Holder</th>
              <th scope="col">Granted in</th>
            </tr>
          </thead>
          <tbody>
            {dep.contracts.flatMap((c) =>
              c.roles.map((r) => (
                <tr
                  key={`${c.address}:${r.role}`}
                  data-testid="gov-role-row"
                  data-contract={c.name}
                  data-role={r.role}
                  data-unknown={r.holders.some((h) => h.kind === "unknown") || undefined}
                >
                  <th scope="row">
                    <span className={styles.rowHead}>
                      <span className={styles.contract}>
                        {c.name}
                        {c.sharedWith.length ? (
                          <span className={styles.shared}> · also {c.sharedWith.join(", ")}</span>
                        ) : null}
                      </span>
                      <Addr chainId={chainId} address={c.address} />
                    </span>
                  </th>
                  <td className="mono">{r.role}</td>
                  <td className={styles.wrapCell}>
                    {r.holders.length ? (
                      <ul className={styles.holders}>
                        {r.holders.map((h) => (
                          <Holder key={h.address} chainId={chainId} h={h} />
                        ))}
                      </ul>
                    ) : (
                      <span className={styles.none}>Nobody</span>
                    )}
                  </td>
                  <td>
                    <ul className={styles.grants}>
                      {r.holders.map((h) => (
                        <li key={h.address}>
                          {h.grantTx ? (
                            <Tx chainId={chainId} hash={h.grantTx}>
                              block {n(h.grantBlock ?? 0)}
                            </Tx>
                          ) : (
                            <span className={styles.none}>no log found</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </TableWrap>
      {dep.roleFree.length ? (
        <p className={styles.meta}>
          No privileged role:{" "}
          {dep.roleFree.map((c, i) => (
            <span key={c.address}>
              {i ? "; " : ""}
              {c.name} (<Addr chainId={chainId} address={c.address} />, {c.why})
            </span>
          ))}
          . Vaults are clones of one implementation with no admin; each vault&apos;s curator can only replace
          its agent or abort an open epoch.
        </p>
      ) : null}
    </div>
  );
}

const ROLE_ROWS = (Object.keys(ROLE_INFO) as ContractKind[]).flatMap((kind) =>
  KIND_ROLES[kind].map((role) => ({ kind, role, info: ROLE_INFO[kind][role]! })),
);

function RoleTable() {
  return (
    <TableWrap stack>
      <table className={`${appStyles.table} ${styles.table}`} aria-label="What each role can and cannot do">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Can</th>
            <th scope="col">Cannot</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {ROLE_ROWS.map(({ kind, role, info }) => (
            <tr key={`${kind}:${role}`} data-testid="gov-role-info" data-kind={kind} data-role={role}>
              <th scope="row">
                <span className={styles.rowHead}>
                  <span className={styles.contract}>{kind}</span>
                  <span className="mono">{role}</span>
                </span>
              </th>
              <td className={styles.wrapCell}>{info.can}</td>
              <td className={styles.wrapCell}>
                {info.cannot ?? <span className={styles.none}>Not stated</span>}
              </td>
              <td>
                <Out href={repoUrl(info.source)}>
                  <span className="mono">{info.source.split("/").pop()!.split("#")[0]}</span>
                </Out>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function ActionTable({ chainId, dep }: { chainId: GovChainId; dep: GovDeploymentJson }) {
  if (!dep.actions.length)
    return <p className={styles.meta}>No admin action found since the deploy block.</p>;
  return (
    <div className={styles.block} data-testid="gov-actions">
      <p className={styles.meta}>
        The last {dep.actions.length} of {dep.actionCount} (the same event from one contract in one
        transaction counts once).
      </p>
      <TableWrap stack>
        <table className={`${appStyles.table} ${styles.table}`} aria-label={`Last admin actions, ${dep.key}`}>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Contract</th>
              <th scope="col">When</th>
              <th scope="col">By</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {dep.actions.map((a) => (
              <tr key={`${a.tx}:${a.contract}:${a.event}`} data-testid="gov-action" data-event={a.event}>
                <th scope="row" className={styles.wrapCell}>
                  {a.summary}
                </th>
                <td>{a.contractName}</td>
                <td>{a.timestamp ? utc(a.timestamp) : `block ${n(a.block)}`}</td>
                <td>{a.fromLabel ?? (a.from ? short(a.from) : "?")}</td>
                <td>
                  <Tx chainId={chainId} hash={a.tx} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
