import { describe, expect, it } from "vitest";
import { DECISION_TOPICS, answerDecisionQuestion, decisionTopicOf } from "../src/index.js";
import accepted from "../../docs/agent-log/2026-10-01-sTSLA-CC.json" with { type: "json" };
import rejected from "../../docs/agent-log/2026-10-01-sTSLA-CSP.json" with { type: "json" };
import settle from "../../docs/agent-log/2026-10-03-sTSLA-CC.json" with { type: "json" };
import pipeline from "../../docs/agent-log/dry-runs/2026-10-03-sTSLA-CSP-as-if-open-dry-run.json" with { type: "json" };

// The deterministic "ask about this record" answers (src/decisionQa.ts) over the published decision records: the
// accepted v3 covered call of 1 October (Claude planned it), the reckless put the contract rejected and slashed, a
// settlement record without a decision, and a 3 October dry run with the specialists' pipeline.

/** Every citation's path must hold exactly the cited value in the record. */
function expectCitationsResolve(record: unknown, citations: { path: string; value: string }[]) {
  for (const c of citations) {
    let cur: unknown = record;
    for (const part of c.path.split(".")) cur = (cur as Record<string, unknown>)[part];
    expect(typeof cur === "object" ? JSON.stringify(cur) : String(cur), c.path).toBe(c.value);
  }
}

describe("answerDecisionQuestion", () => {
  it("why this strike: the strike, target and measured delta, spot, band and the planner's words, each cited", () => {
    const a = answerDecisionQuestion(accepted, "Why this strike?");
    expect(a.topic).toBe("why-strike");
    expect(a.refused).toBe(false);
    expect(a.hashMatches).toBe(true);
    expect(a.answer).toContain("The agent proposed a call at strike $369.37 [dryRun.strike].");
    expect(a.answer).toContain(
      "It targeted |delta| 0.20 [decision.targetDeltaBps]; the contract measured 0.2 [dryRun.delta].",
    );
    expect(a.answer).toContain("Spot was $358.5505 [market.spot], so the strike is 3.0% above it.");
    expect(a.answer).toContain(
      "The mandate's band is |delta| 0.10 [vault.mandate.minDeltaBps] to 0.35 [vault.mandate.maxDeltaBps].",
    );
    expect(a.answer).toContain(
      "Planner: Claude via Claude Code CLI, model claude-opus-5 [decision.planner.label].",
    );
    expect(a.citations.map((c) => c.path)).toContain("decision.reasoning");
    expectCitationsResolve(accepted, a.citations);
  });

  it("within the mandate: the contract's verdict and each rule recomputed, for the rejected put", () => {
    const a = answerDecisionQuestion(rejected, "Was it within the mandate?");
    expect(a.topic).toBe("mandate");
    expect(a.answer).toContain(
      "The contract's dry run (previewProposal) said outside the mandate [dryRun.ok], reason DeltaOutOfBand [dryRun.reason].",
    );
    expect(a.answer).toContain(
      "|delta| 0.4928 [dryRun.delta] against the band 0.10 [vault.mandate.minDeltaBps] to 0.35 [vault.mandate.maxDeltaBps]: outside",
    );
    expect(a.answer).toContain("On-chain the proposal was rejected [result.status].");
    expect(a.answer).toContain("The agent's bond was slashed 10 [result.slashed] USDG.");
    expectCitationsResolve(rejected, a.citations);
    const ok = answerDecisionQuestion(accepted, "did it break any rule?");
    expect(ok.answer).toMatch(/inside the mandate \[dryRun.ok\]/);
    expect(ok.answer).not.toMatch(/: outside/);
  });

  it("what would make this lose: break-even, model odds and the stress loss from the risk analyst's row", () => {
    const a = answerDecisionQuestion(pipeline, "What would make this lose?");
    expect(a.topic).toBe("loss");
    expect(a.hashMatches).toBeNull(); // a dry run is not anchored
    expect(a.answer).toContain(
      "cash-secured put: if the stock closes below the strike $347.27 [dryRun.strike]",
    );
    expect(a.answer).toContain(
      "Depositors lose money on the week below $343.8006 [decision.pipeline.1.output.rows.3.breakEven].",
    );
    expect(a.answer).toContain(
      "The model odds of exercise were 22.3% [decision.pipeline.1.output.rows.3.exerciseProbability]",
    );
    expect(a.answer).toContain(
      "a -30% [decision.pipeline.1.output.rows.3.stress.worstShock] move costs the vault $12.15742",
    );
    expectCitationsResolve(pipeline, a.citations);
    // Without the pipeline the break-even is computed from the strike and the premium per option.
    const cc = answerDecisionQuestion(accepted, "what's the downside?");
    expect(cc.answer).toContain("Depositors end the week behind simply holding the stock above $370.80");
  });

  it("refuses questions outside the record, and questions the record has no fields for", () => {
    for (const q of ["Who is Tesla's CEO?", "What will TSLA do next week?", ""]) {
      const a = answerDecisionQuestion(accepted, q);
      expect(a.refused, q).toBe(true);
      expect(a.citations).toEqual([]);
      expect(a.answer).toContain('"Why this strike?"');
    }
    const s = answerDecisionQuestion(settle, "Why this strike?");
    expect(s.refused).toBe(true);
    expect(s.answer).toMatch(/^This record \(action settle\) does not have the fields/);
    expect(answerDecisionQuestion(settle, "What happened?").answer).toContain("failed [result.status]");
    expect(answerDecisionQuestion("not a record", "why?").refused).toBe(true);
  });

  it("flags a record whose fields no longer match its anchored hash", () => {
    const tampered = structuredClone(accepted) as typeof accepted;
    tampered.dryRun.strike = "400.00";
    const a = answerDecisionQuestion(tampered, "Is this record anchored?");
    expect(a.hashMatches).toBe(false);
    expect(a.answer).toContain("does not equal that hash");
    expect(answerDecisionQuestion(accepted, "is it anchored?").answer).toContain("equals that hash");
  });

  it("answers premium, result, alternatives, market and agent questions from the record", () => {
    expect(answerDecisionQuestion(accepted, "How much premium?").answer).toContain(
      "If all 4 [dryRun.size] options sell, the vault earns about $5.73 of premium",
    );
    expect(answerDecisionQuestion(pipeline, "What else did it consider?").answer).toMatch(
      /^It dry-ran 8 candidates \[decision.candidates\]; the contract would accept 6 of them\./,
    );
    expect(answerDecisionQuestion(accepted, "what was the market like?").answer).toContain(
      "Spot was $358.5505 [market.spot]",
    );
    expect(answerDecisionQuestion(rejected, "agent track record").answer).toMatch(
      /^Agent 1 \[trackRecord.agentId\]/,
    );
    expect(DECISION_TOPICS).toHaveLength(9);
    expect(decisionTopicOf("Why this strike?")).toBe("why-strike");
  });
});
