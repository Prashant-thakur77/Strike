import { GLOSSARY, type GlossaryId } from "@/lib/glossary";
import { PageHero } from "../PageHero";
import styles from "../app.module.css";

/** Groups, in the order a newcomer meets the ideas. */
const GROUPS: { label: string; ids: GlossaryId[] }[] = [
  {
    label: "Options",
    ids: [
      "option",
      "coveredCall",
      "cashSecuredPut",
      "strike",
      "premium",
      "expiry",
      "series",
      "intrinsic",
      "fairValue",
    ],
  },
  { label: "Risk", ids: ["greeks", "delta", "gamma", "vega", "theta", "impliedVol", "spotBuffer"] },
  { label: "How Strike runs", ids: ["epoch", "tenor", "mandate", "agent", "bond", "slash"] },
  { label: "Tokens and standards", ids: ["stockToken", "usdg", "multiplier", "erc8004"] },
];

export function GlossaryPage() {
  return (
    <>
      <PageHero
        index="08"
        label="Glossary"
        title="Glossary"
        lead={
          <p className="lead">
            The words you&apos;ll meet in Strike, in plain language. Across the app, a dotted underline marks
            a term: hover, focus or tap it for the same definition.
          </p>
        }
      />
      <div className={`gutter ${styles.glossary}`}>
        {GROUPS.map((g) => (
          <section key={g.label} className={styles.glossaryGroup} aria-labelledby={`g-${g.label}`}>
            <h2 id={`g-${g.label}`} className="micro">
              {g.label}
            </h2>
            <dl className={styles.glossaryList}>
              {g.ids.map((id) => (
                <div key={id} id={`term-${id}`} className={styles.glossaryItem}>
                  <dt>{GLOSSARY[id].term}</dt>
                  <dd>{GLOSSARY[id].def}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}
