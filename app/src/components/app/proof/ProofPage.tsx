import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { shortAddr } from "@/lib/format";
import {
  CHECKS,
  CONTRACTS,
  COVERAGE,
  DEPLOYMENT,
  GAS,
  GAS_SOURCE,
  LIVE_EPOCH_LOG,
  RESEARCH,
  REVIEW,
  SLITHER,
  STYLUS,
  TESTS,
  THREAT_MODEL,
  VERIFICATION_NOTE,
  explorerAddress,
  explorerTx,
  gh,
  type Evidence,
} from "@/lib/proof";
import { ActivityFeed } from "../activity/ActivityFeed";
import { Fold } from "../Fold";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { PageIndex } from "../PageIndex";
import { Rail } from "../Rail";
import appStyles from "../app.module.css";
import { ActivePricer } from "./ActivePricer";
import styles from "./proof.module.css";

/** A suite's count from TESTS, so the headline strip and the tests section never disagree. */
const testCount = (label: string) => TESTS.find((t) => t.label === label)?.count ?? "?";

const SECTIONS = [
  { id: "live", label: "Deployment" },
  { id: "stylus", label: "Stylus" },
  { id: "tests", label: "Tests" },
  { id: "checks", label: "Invariants" },
  { id: "security", label: "Security" },
  { id: "activity", label: "Activity" },
  { id: "research", label: "Research" },
];

const n = (x: number) => x.toLocaleString("en-US");

/** `code` spans inside a plain string (finding titles use Markdown backticks). */
function ticks(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="mono">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function Out({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className ?? styles.link}>
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

function EvidenceLinks({ items }: { items: readonly Evidence[] }) {
  return (
    <ul className={styles.evidence} aria-label="Evidence">
      {items.map((e) => (
        <li key={e.href}>
          <Out href={e.href}>{e.label}</Out>
        </li>
      ))}
    </ul>
  );
}

export function ProofPage() {
  const reviewTotal = REVIEW.findings.length;
  return (
    <>
      <PageHero
        index="06"
        label="Proof"
        right="Robinhood Chain testnet · 46630"
        title="Proof"
        lead={
          <>
            <p className="lead">
              Each claim Strike makes, next to the contract, transaction, test or document that backs it.
            </p>
            <p className={styles.leadNote}>
              Figures are taken from the repository and link to their source. The active pricer and the
              activity feed are read from the chain when the page loads. Strike is unaudited: the review below
              is internal.
            </p>
          </>
        }
      />

      <MetaStrip
        cells={[
          {
            label: "Deployment",
            value: DEPLOYMENT.version,
            sub: `${CONTRACTS.length} contracts · deploy block ${n(DEPLOYMENT.block)}`,
          },
          {
            label: "Foundry tests",
            value: testCount("Foundry"),
            sub: `+ ${testCount("Rust")} Rust · ${testCount("TypeScript")} TypeScript · ${testCount("Telegram bot")} bot · ${testCount("Subgraph")} subgraph`,
          },
          {
            label: "Coverage",
            value: COVERAGE.lines,
            sub: `of lines · ${COVERAGE.branches} of branches`,
          },
          {
            label: "Internal review",
            value: `${reviewTotal}/${reviewTotal} fixed`,
            sub: `${REVIEW.counts.High} High · ${REVIEW.counts.Medium} Medium · ${REVIEW.counts.Low} Low · ${REVIEW.counts.Info} Info`,
          },
        ]}
      />

      <PageIndex items={SECTIONS} />

      <div className={`${styles.body} ${appStyles.indexed}`}>
        {/* ------------------------------------------------------------ 01 live deployment */}
        <Rail
          index="01"
          id="live"
          label="Live on Robinhood Chain testnet"
          note={
            <>
              Addresses from <Out href={gh(DEPLOYMENT.file)}>46630.json</Out> and{" "}
              <Out href={gh(DEPLOYMENT.vaultsFile)}>46630-vaults.json</Out>. Verification status checked on
              Blockscout on 2026-09-30.
            </>
          }
        >
          <ActivePricer />
          <Fold summary={`Show all ${CONTRACTS.length} contracts`} openSummary="Hide the contract list">
            <ul className={styles.contracts} aria-label="v2 contracts">
              {CONTRACTS.map((c) => (
                <li
                  key={`${c.name}-${c.address}`}
                  className={styles.contract}
                  data-verification={c.verification}
                >
                  <div className={styles.contractName}>
                    <span className={styles.contractTitle}>
                      {c.name}
                      {c.address.toLowerCase() === DEPLOYMENT.activePricer.toLowerCase() ? (
                        <span className={styles.activeTag}>Active pricer</span>
                      ) : null}
                    </span>
                    <span className={styles.contractRole}>{c.role}</span>
                  </div>
                  <Out href={explorerAddress(c.address)} className={`mono ${styles.addr}`}>
                    <span title={c.address}>{shortAddr(c.address)}</span>
                  </Out>
                  <span className={styles.verified} data-verification={c.verification}>
                    {c.verification === "stylus" ? (
                      <a href="#stylus" className={styles.inlineLink}>
                        {VERIFICATION_NOTE[c.verification]}
                      </a>
                    ) : (
                      VERIFICATION_NOTE[c.verification]
                    )}
                  </span>
                  {c.source ? (
                    <Out href={gh(c.source)} className={styles.source}>
                      Source
                    </Out>
                  ) : (
                    <span className={styles.sourceNone}>External</span>
                  )}
                </li>
              ))}
            </ul>
          </Fold>
          <p className={styles.note}>
            Built from commit <code className="mono">{DEPLOYMENT.sourceCommit}</code>, deployed from{" "}
            <code className="mono">{DEPLOYMENT.deployCommit}</code>. The testnet has no Chainlink stock feeds,
            so MirrorFeeds copy the mainnet rounds.
          </p>
        </Rail>

        {/* ------------------------------------------------------------ 02 stylus */}
        <Rail
          index="02"
          id="stylus"
          label="Stylus"
          note={
            <>
              Method, raw numbers and scripts: <Out href={GAS_SOURCE.doc}>docs/gas.md</Out>.
            </>
          }
        >
          <Fold summary="Show verification and gas" openSummary="Hide section">
            <div className={styles.block}>
              <h3 className={styles.blockTitle}>The live pricer is reproducibly this source</h3>
              <p className={styles.text}>
                <code className="mono">cargo stylus verify</code> rebuilds{" "}
                <Out href={gh("stylus/pricer/src/math.rs")}>stylus/pricer</Out> from the repository and
                reports <strong>Verification successful</strong> for the deployed program.
              </p>
              <pre className={styles.cmd} tabIndex={0} aria-label="Verification command">
                <code>{STYLUS.command}</code>
              </pre>
              <dl className={styles.kv}>
                <dt>Deployment tx</dt>
                <dd>
                  <Out href={explorerTx(STYLUS.deployTx)} className={`mono ${styles.addr}`}>
                    {shortAddr(STYLUS.deployTx)}
                  </Out>
                </dd>
                <dt>Build</dt>
                <dd>{STYLUS.toolchain}</dd>
                <dt>Metadata hash</dt>
                <dd className="mono">{STYLUS.metadataHash}</dd>
                <dt>WASM size</dt>
                <dd>{n(STYLUS.wasmBytes)} bytes</dd>
                <dt>Activation check</dt>
                <dd>
                  The deploy script only sets it as the pricer if its on-chain quote equals the Solidity
                  reference&apos;s (<Out href={STYLUS.equalityCheck}>deploy-testnet.sh</Out>).
                </dd>
              </dl>
              <p className={styles.small}>
                <Out href={STYLUS.doc}>docs/gas.md, “The live Stylus pricer is verifiably this source”</Out>
              </p>
            </div>

            <div className={styles.block}>
              <h3 className={styles.blockTitle}>Gas: Solidity pricer against Stylus pricer</h3>
              <div className={styles.tableWrap}>
                <table className={styles.gas}>
                  <caption className="sr-only">Gas used with the Solidity and the Stylus pricer</caption>
                  <thead>
                    <tr>
                      <th scope="col">Call</th>
                      <th scope="col" className={styles.num}>
                        Solidity
                      </th>
                      <th scope="col" className={styles.num}>
                        Stylus
                      </th>
                      <th scope="col">Stylus is</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GAS.map((g) => (
                      <tr key={g.call} data-solidity-wins={g.solidityWins || undefined}>
                        <th scope="row">
                          <div className={styles.gasHead}>
                            <code className={`mono ${styles.gasCall}`}>{g.call}</code>
                            <span className={styles.gasInputs}>{g.inputs}</span>
                            <span
                              className={styles.gasVerdictInline}
                              data-worse={g.solidityWins || undefined}
                            >
                              Stylus {g.verdict}
                            </span>
                          </div>
                        </th>
                        <td className={styles.num}>{n(g.solidity)}</td>
                        <td className={styles.num}>{n(g.stylus)}</td>
                        <td className={styles.verdict} data-worse={g.solidityWins || undefined}>
                          {g.verdict}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.plain}>
                <strong>A single quote is cheaper in Solidity</strong> ({n(33_969)} gas against {n(40_624)}).
                A Stylus call pays a fixed entry cost of about 35–40k gas, and one Black-Scholes quote is
                cheap in the EVM&apos;s native 256-bit arithmetic. Stylus wins once a call does real work:
                solving a strike by delta runs 48 evaluations and costs 6.5–6.6× less.
              </p>
              <p className={styles.small}>
                Measured on a local Arbitrum Nitro dev node ({GAS_SOURCE.node}). The first two rows are whole
                EpochManager transactions (L2 execution gas), the last two single pricer calls. Reproduce with{" "}
                <Out href={GAS_SOURCE.script}>stylus-gas.sh</Out> and{" "}
                <Out href={GAS_SOURCE.e2e}>stylus-e2e.sh</Out>.
              </p>
            </div>
          </Fold>
        </Rail>

        {/* ------------------------------------------------------------ 03 tests */}
        <Rail
          index="03"
          id="tests"
          label="Tests"
          note={
            <>
              Counts from <Out href={gh("README.md", "safety-evidence")}>README.md</Out> and{" "}
              <Out href={gh("docs/testing.md")}>docs/testing.md</Out>; the Telegram bot&apos;s from its test
              files.
            </>
          }
        >
          <Fold summary="Show tests and coverage" openSummary="Hide section">
            <ul className={styles.tests}>
              {TESTS.map((t) => (
                <li key={t.label} className={styles.test}>
                  <span className={styles.testCount}>{t.count}</span>
                  <span className={styles.testLabel}>{t.label}</span>
                  <p className={styles.testDetail}>{t.detail}</p>
                  <EvidenceLinks items={t.evidence} />
                </li>
              ))}
            </ul>
            <div className={styles.coverage}>
              <h3 className={styles.blockTitle}>Coverage</h3>
              <dl className={styles.coverageGrid}>
                <div>
                  <dt className="micro micro-muted">Lines</dt>
                  <dd>{COVERAGE.lines}</dd>
                </div>
                <div>
                  <dt className="micro micro-muted">Branches</dt>
                  <dd>{COVERAGE.branches}</dd>
                </div>
                <div>
                  <dt className="micro micro-muted">Statements</dt>
                  <dd>{COVERAGE.statements}</dd>
                </div>
                <div>
                  <dt className="micro micro-muted">Functions</dt>
                  <dd>{COVERAGE.functions}</dd>
                </div>
              </dl>
              <p className={styles.small}>
                <code className="mono">make coverage</code>: Foundry with{" "}
                <code className="mono">--ir-minimum</code>, production code in{" "}
                <code className="mono">contracts/src</code> only. CI fails below 95% of lines.
              </p>
              <EvidenceLinks items={COVERAGE.evidence} />
            </div>
          </Fold>
        </Rail>

        {/* ------------------------------------------------------------ 04 deeper checks */}
        <Rail
          index="04"
          id="checks"
          label="Invariants, forks, differential"
          note="Checks that go beyond example-based tests: random call sequences, deliberately broken code, real mainnet state and two independent pricer implementations."
        >
          <Fold summary={`Show all ${CHECKS.length} checks`} openSummary="Hide section">
            <ul className={styles.checks}>
              {CHECKS.map((c) => (
                <li key={c.title} className={styles.check}>
                  <h3 className={styles.checkTitle}>{c.title}</h3>
                  <div className={styles.checkBody}>
                    <p className={styles.checkClaim}>{c.claim}</p>
                    <ul className={styles.checkDetail}>
                      {c.detail.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                    <EvidenceLinks items={c.evidence} />
                  </div>
                </li>
              ))}
            </ul>
          </Fold>
        </Rail>

        {/* ------------------------------------------------------------ 05 security */}
        <Rail
          index="05"
          id="security"
          label="Security"
          note="Static analysis, an internal adversarial review and a threat model. None of this replaces an external audit."
        >
          <Fold summary={`Show analysis and ${reviewTotal} findings`} openSummary="Hide section">
            <div className={styles.secGrid}>
              <div className={styles.secCell}>
                <span className="micro micro-muted">Static analysis</span>
                <span className={styles.secValue}>{SLITHER.result}</span>
                <p className={styles.small}>
                  {SLITHER.version}. {SLITHER.detail}. CI fails on any High.
                </p>
                <EvidenceLinks
                  items={[
                    { label: "docs/security/slither.md", href: SLITHER.doc },
                    { label: "CI slither job", href: SLITHER.ci },
                  ]}
                />
              </div>
              <div className={styles.secCell}>
                <span className="micro micro-muted">Threat model</span>
                <span className={styles.secValue}>{THREAT_MODEL.threats} threats</span>
                <p className={styles.small}>Each with its mitigation and the test that covers it.</p>
                <EvidenceLinks items={[{ label: "docs/threat-model.md", href: THREAT_MODEL.doc }]} />
              </div>
            </div>

            <div className={styles.block}>
              <h3 className={styles.blockTitle}>
                Internal review, {REVIEW.date}: {reviewTotal} findings, all fixed
              </h3>
              <p className={styles.text}>
                {REVIEW.counts.High} High, {REVIEW.counts.Medium} Medium, {REVIEW.counts.Low} Low and{" "}
                {REVIEW.counts.Info} Info. Each finding&apos;s test first reproduced the attack; after the fix
                it asserts the fixed behaviour. {REVIEW.regressionTests} regression tests run in{" "}
                <code className="mono">make test</code>.
              </p>
              <ol className={styles.findings} aria-label="Findings">
                {REVIEW.findings.map((f) => (
                  <li key={f.id} className={styles.finding}>
                    <span className={`mono ${styles.findingId}`}>{f.id}</span>
                    <span className={styles.severity} data-severity={f.severity}>
                      {f.severity}
                    </span>
                    <span className={styles.findingTitle}>{ticks(f.title)}</span>
                    <span className={styles.fixed}>Fixed</span>
                  </li>
                ))}
              </ol>
              <EvidenceLinks
                items={[
                  { label: "docs/security/review-2026-09-29.md", href: REVIEW.doc },
                  { label: `contracts/test/audit (${REVIEW.regressionTests} tests)`, href: REVIEW.tests },
                ]}
              />
            </div>
          </Fold>
        </Rail>

        {/* ------------------------------------------------------------ 06 live activity */}
        <Rail
          index="06"
          id="activity"
          label="Live activity"
          note={
            <>
              Every EpochManager event since the deploy block, read from the chain&apos;s logs. Hover a time
              for UTC. The first live epoch&apos;s full log: <Out href={LIVE_EPOCH_LOG}>2026-09-29.md</Out>.
            </>
          }
        >
          <ActivityFeed />
        </Rail>

        {/* ------------------------------------------------------------ 07 research */}
        <Rail index="07" id="research" label="Research">
          <Fold summary="Show research" openSummary="Hide section">
            <ul className={styles.research}>
              {RESEARCH.map((r) => (
                <li key={r.title} className={styles.researchItem}>
                  <h3 className={styles.blockTitle}>{r.title}</h3>
                  <p className={styles.text}>{r.summary}</p>
                  <EvidenceLinks items={r.evidence} />
                </li>
              ))}
            </ul>
          </Fold>
        </Rail>
      </div>
    </>
  );
}
