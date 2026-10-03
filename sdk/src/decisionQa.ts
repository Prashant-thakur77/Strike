import { decisionRecordHash, recordAnchorOf } from "./decisionRecord.js";

// Questions about one decision record, answered without a language model: each answer is a template filled from the
// record's own fields (and the vault mandate the record carries), and cites the path of every field it used. A
// question the record cannot answer is refused with the list of what it can. The record's hash is rebuilt and compared
// with its anchor, so a caller knows whether the fields are the ones committed on-chain (the on-chain side is
// `verifyDecisionAnchor`). The MCP tool `explain_decision` wraps this, so a local agent can phrase the answer with the
// user's own model from the same cited fields.

export const DECISION_TOPICS = [
  { topic: "why-strike", example: "Why this strike?" },
  { topic: "loss", example: "What would make this lose?" },
  { topic: "mandate", example: "Was it within the mandate?" },
  { topic: "result", example: "What happened on-chain?" },
  { topic: "premium", example: "How much premium does it earn?" },
  { topic: "alternatives", example: "What else did the agent consider?" },
  { topic: "market", example: "What was the market when it decided?" },
  { topic: "anchor", example: "Is this record anchored on-chain?" },
  { topic: "agent", example: "What is the agent's track record?" },
] as const;
export type DecisionTopic = (typeof DECISION_TOPICS)[number]["topic"];

/** One field an answer used: its path in the record and its value there. */
export interface DecisionCitation {
  path: string;
  value: string;
}

export interface DecisionAnswer {
  question: string;
  /** The topic the question matched, or null when the record cannot answer it. */
  topic: DecisionTopic | null;
  /** The answer; every figure in it is followed by the path it came from, in brackets. */
  answer: string;
  citations: DecisionCitation[];
  /** True when the question is outside the record (or the record lacks the fields it needs). */
  refused: boolean;
  /**
   * Whether keccak256 of the record (without its anchor) equals `anchor.recordHash`; null when the record has no
   * anchor. Only a true value ties the cited fields to the hash committed on-chain.
   */
  hashMatches: boolean | null;
  /** What this function can answer, as example questions. */
  topics: readonly { topic: DecisionTopic; example: string }[];
}

const TOPIC_PATTERNS: readonly [DecisionTopic, RegExp][] = [
  ["mandate", /mandate|within|allowed|rule|limit|band|breach|comply|complian|legal|permitted/i],
  ["loss", /lose|loss|losing|risk|worst|downside|bad case|go wrong|break.?even|exercis|assign|called away/i],
  ["why-strike", /why|strike|delta|reason|chose|choose|pick/i],
  ["premium", /premium|income|earn|yield|paid|pay|price/i],
  ["alternatives", /alternative|consider|other|instead|option[s]? (did|it)|candidate|ladder|rung/i],
  ["market", /market|spot|volatil|sigma|oracle|feed|open|session/i],
  ["result", /result|happen|accept|reject|outcome|slash|status|sent|series id|transaction/i],
  ["anchor", /anchor|hash|verif|tamper|on.?chain|proof|decisionlog/i],
  ["agent", /agent|track record|history|bond|strikes|reputation|pnl/i],
];

/** The topic a question is about, or null (the answer is then a refusal). */
export function decisionTopicOf(question: string): DecisionTopic | null {
  for (const [topic, re] of TOPIC_PATTERNS) if (re.test(question)) return topic;
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function at(record: unknown, path: string): unknown {
  let cur: unknown = record;
  for (const part of path.split(".")) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const money = (x: number) => `$${x.toFixed(2)}`;
const bpsDelta = (bps: number) => (bps / 10_000).toFixed(2);

/** Collects citations while an answer is written: `c(path)` returns the value with its `[path]` marker. */
class Cite {
  readonly list: DecisionCitation[] = [];
  constructor(private readonly record: unknown) {}
  has(path: string): boolean {
    return present(at(this.record, path));
  }
  raw(path: string): unknown {
    return at(this.record, path);
  }
  num(path: string): number | null {
    return num(at(this.record, path));
  }
  /** The value as text with its path, and the citation recorded. */
  c(path: string, format?: (v: unknown) => string): string {
    const v = at(this.record, path);
    const text = format ? format(v) : String(v);
    if (!this.list.some((x) => x.path === path)) {
      this.list.push({ path, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
    }
    return `${text} [${path}]`;
  }
  /** Record a citation for a value used in a computation (shown as the computed figure). */
  use(...paths: string[]): void {
    for (const p of paths) this.c(p);
  }
}

/** The risk analyst's row for the chosen target delta, when the record has the pipeline (3 October and later). */
function chosenRiskRow(record: unknown): { path: string; row: Obj } | null {
  const pipeline = at(record, "decision.pipeline");
  if (!Array.isArray(pipeline)) return null;
  const i = pipeline.findIndex((s) => isObj(s) && s.stage === "risk");
  const rows = at(record, `decision.pipeline.${i}.output.rows`);
  if (i < 0 || !Array.isArray(rows)) return null;
  const target = num(at(record, "dryRun.targetDeltaBps")) ?? num(at(record, "decision.targetDeltaBps"));
  const j = rows.findIndex((r) => isObj(r) && num(r.targetDeltaBps) === target);
  return j < 0 ? null : { path: `decision.pipeline.${i}.output.rows.${j}`, row: rows[j] as Obj };
}

const isCallRecord = (record: unknown) =>
  at(record, "dryRun.optionType") === "call" || at(record, "vault.kind") === "covered-call";

/**
 * Answer one question about one decision record from its fields only, citing each field used, or refuse. Never reads
 * the chain or calls a model.
 */
export function answerDecisionQuestion(record: unknown, question: string): DecisionAnswer {
  const q = question.trim();
  let hashMatches: boolean | null = null;
  const anchor = recordAnchorOf(record);
  if (anchor) {
    try {
      hashMatches = decisionRecordHash(record).toLowerCase() === anchor.recordHash.toLowerCase();
    } catch {
      hashMatches = false;
    }
  }
  const base = { question: q, hashMatches, topics: DECISION_TOPICS };
  const refuse = (topic: DecisionTopic | null, why: string): DecisionAnswer => ({
    ...base,
    topic,
    answer: `${why} This record can answer: ${DECISION_TOPICS.map((t) => `"${t.example}"`).join(", ")}.`,
    citations: [],
    refused: true,
  });
  if (!isObj(record)) return refuse(null, "That is not a decision record.");
  const topic = q ? decisionTopicOf(q) : null;
  if (!topic) return refuse(null, "This record does not answer that.");
  const k = new Cite(record);
  const lines = writers[topic](k, record);
  if (!lines) {
    const action = at(record, "action");
    return refuse(
      topic,
      `This record (action ${typeof action === "string" ? action : "unknown"}) does not have the fields that question needs.`,
    );
  }
  return { ...base, topic, answer: lines.join(" "), citations: k.list, refused: false };
}

type Writer = (k: Cite, record: unknown) => string[] | null;

const writers: Record<DecisionTopic, Writer> = {
  "why-strike": (k, record) => {
    if (!k.has("dryRun.strike") || !isObj(k.raw("decision"))) return null;
    const out: string[] = [];
    const kind = isCallRecord(record) ? "call" : "put";
    out.push(`The agent proposed a ${kind} at strike $${k.c("dryRun.strike")}.`);
    if (k.has("decision.targetDeltaBps")) {
      out.push(
        `It targeted |delta| ${k.c("decision.targetDeltaBps", (v) => bpsDelta(Number(v)))}; the contract measured ${k.c("dryRun.delta")}.`,
      );
    }
    const spot = k.num("market.spot");
    const strike = k.num("dryRun.strike");
    if (spot !== null && strike !== null) {
      k.use("market.spot");
      out.push(
        `Spot was $${k.c("market.spot")}, so the strike is ${pct(Math.abs(strike - spot) / spot)} ${strike >= spot ? "above" : "below"} it.`,
      );
    }
    if (k.has("vault.mandate.minDeltaBps") && k.has("vault.mandate.maxDeltaBps")) {
      out.push(
        `The mandate's band is |delta| ${k.c("vault.mandate.minDeltaBps", (v) => bpsDelta(Number(v)))} to ${k.c("vault.mandate.maxDeltaBps", (v) => bpsDelta(Number(v)))}.`,
      );
    }
    if (k.has("decision.planner.label")) out.push(`Planner: ${k.c("decision.planner.label")}.`);
    else if (k.has("decision.strategy")) out.push(`Strategy: ${k.c("decision.strategy")}.`);
    if (k.has("decision.reasoning")) out.push(`Its stated reasoning: "${k.c("decision.reasoning")}"`);
    return out;
  },

  loss: (k, record) => {
    const strike = k.num("dryRun.strike");
    const fair = k.num("dryRun.fairValue");
    const premiumBps = k.num("dryRun.premiumBps");
    if (strike === null) return null;
    const call = isCallRecord(record);
    const out: string[] = [];
    const risk = chosenRiskRow(record);
    let breakEven: string | null = null;
    if (risk && present(risk.row.breakEven)) breakEven = k.c(`${risk.path}.breakEven`, (v) => `$${v}`);
    else if (fair !== null && premiumBps !== null) {
      k.use("dryRun.fairValue", "dryRun.premiumBps");
      const perOption = (fair * premiumBps) / 10_000;
      breakEven = `${money(call ? strike + perOption : strike - perOption)} (strike ± premium per option, from [dryRun.strike], [dryRun.fairValue] and [dryRun.premiumBps])`;
    }
    const expiry = k.has("dryRun.expiryIso") ? ` at expiry ${k.c("dryRun.expiryIso")}` : "";
    if (call) {
      out.push(
        `This is a covered call: if the stock closes above the strike $${k.c("dryRun.strike")}${expiry}, the gain above the strike goes to the option buyers.`,
      );
      if (breakEven) out.push(`Depositors end the week behind simply holding the stock above ${breakEven}.`);
      out.push("If the stock falls, depositors still hold it and bear the fall, less the premium earned.");
    } else {
      out.push(
        `This is a cash-secured put: if the stock closes below the strike $${k.c("dryRun.strike")}${expiry}, the vault pays the buyers the difference.`,
      );
      if (breakEven) out.push(`Depositors lose money on the week below ${breakEven}.`);
    }
    if (risk && present(risk.row.exerciseProbability)) {
      out.push(
        `The model odds of exercise were ${k.c(`${risk.path}.exerciseProbability`, (v) => pct(Number(v)))} (Black-Scholes, not a forecast).`,
      );
    } else if (k.has("decision.confidence.worthlessProbability")) {
      out.push(
        `The model odds that the option expires worthless were ${k.c("decision.confidence.worthlessProbability", (v) => pct(Number(v)))} (not a forecast).`,
      );
    }
    if (risk && isObj(risk.row.stress) && present(risk.row.stress.worstLossUsd)) {
      out.push(
        `In the risk engine's stress test, a ${k.c(`${risk.path}.stress.worstShock`, (v) => pct(Number(v), 0))} move costs the vault $${k.c(`${risk.path}.stress.worstLossUsd`)}.`,
      );
    }
    return out;
  },

  mandate: (k, record) => {
    if (!isObj(at(record, "vault.mandate")) || !isObj(at(record, "dryRun"))) return null;
    const out: string[] = [];
    const checks: string[] = [];
    const m = (f: string) => k.num(`vault.mandate.${f}`);
    const delta = k.num("dryRun.delta");
    if (delta !== null && m("minDeltaBps") !== null && m("maxDeltaBps") !== null) {
      const ok = delta >= m("minDeltaBps")! / 10_000 && delta <= m("maxDeltaBps")! / 10_000;
      checks.push(
        `|delta| ${k.c("dryRun.delta")} against the band ${k.c("vault.mandate.minDeltaBps", (v) => bpsDelta(Number(v)))} to ${k.c("vault.mandate.maxDeltaBps", (v) => bpsDelta(Number(v)))}: ${ok ? "inside" : "outside"}`,
      );
    }
    const prem = k.num("dryRun.premiumBps");
    if (prem !== null && m("minPremiumBps") !== null) {
      checks.push(
        `price ${k.c("dryRun.premiumBps", (v) => pct(Number(v) / 10_000, 0))} of fair value against a floor of ${k.c("vault.mandate.minPremiumBps", (v) => pct(Number(v) / 10_000, 0))}: ${prem >= m("minPremiumBps")! ? "inside" : "outside"}`,
      );
    }
    const yieldBps = k.num("dryRun.yieldBps");
    if (yieldBps !== null && m("minYieldBps") !== null) {
      checks.push(
        `yield ${k.c("dryRun.yieldBps", (v) => `${v} bps`)} against a floor of ${k.c("vault.mandate.minYieldBps", (v) => `${v} bps`)}: ${yieldBps >= m("minYieldBps")! ? "inside" : "outside"}`,
      );
    }
    const size = k.num("dryRun.size");
    const capacity = k.num("dryRun.capacity");
    if (size !== null && capacity !== null && capacity > 0 && m("maxShareSoldBps") !== null) {
      k.use("dryRun.size", "dryRun.capacity");
      const share = size / capacity;
      checks.push(
        `size ${pct(share)} of capacity (from [dryRun.size] and [dryRun.capacity]) against at most ${k.c("vault.mandate.maxShareSoldBps", (v) => pct(Number(v) / 10_000, 0))}: ${share <= m("maxShareSoldBps")! / 10_000 + 1e-9 ? "inside" : "outside"}`,
      );
    }
    const expiry = Date.parse(String(at(record, "dryRun.expiryIso") ?? ""));
    const now = Date.parse(String(at(record, "chainTimeIso") ?? ""));
    if (Number.isFinite(expiry) && Number.isFinite(now) && m("minTenor") !== null && m("maxTenor") !== null) {
      k.use("dryRun.expiryIso", "chainTimeIso", "vault.mandate.minTenor", "vault.mandate.maxTenor");
      const tenor = (expiry - now) / 1000;
      const ok = tenor >= m("minTenor")! && tenor <= m("maxTenor")!;
      checks.push(
        `tenor ${(tenor / 86_400).toFixed(2)} days (from [dryRun.expiryIso] and [chainTimeIso]) against ${(m("minTenor")! / 86_400).toFixed(0)} to ${(m("maxTenor")! / 86_400).toFixed(0)} days [vault.mandate.minTenor, vault.mandate.maxTenor]: ${ok ? "inside" : "outside"}`,
      );
    }
    if (k.has("dryRun.ok")) {
      out.push(
        `The contract's dry run (previewProposal) said ${k.c("dryRun.ok", (v) => (v === true ? "inside the mandate" : "outside the mandate"))}, reason ${k.c("dryRun.reason")}.`,
      );
    }
    if (checks.length) out.push(`Rule by rule, recomputed from the record: ${checks.join("; ")}.`);
    if (k.has("result.status")) {
      out.push(`On-chain the proposal was ${k.c("result.status")}.`);
      if (k.has("result.slashed")) out.push(`The agent's bond was slashed ${k.c("result.slashed")} USDG.`);
    }
    out.push("The contract enforces the mandate itself; this answer only reads the record.");
    return checks.length || k.has("dryRun.ok") ? out : null;
  },

  result: (k) => {
    if (!k.has("result.status")) return null;
    const out = [`Result: ${k.c("result.status")}. ${k.c("result.summary")}`];
    const txs = k.raw("transactions");
    if (Array.isArray(txs) && txs.length) {
      out.push(
        `Transactions: ${txs
          .map((t, i) =>
            isObj(t) ? `${k.c(`transactions.${i}.label`)} ${k.c(`transactions.${i}.hash`)}` : "",
          )
          .filter(Boolean)
          .join(", ")}.`,
      );
    }
    return out;
  },

  premium: (k, record) => {
    const fair = k.num("dryRun.fairValue");
    const premiumBps = k.num("dryRun.premiumBps");
    const size = k.num("dryRun.size");
    if (fair === null || premiumBps === null) return null;
    const perOption = (fair * premiumBps) / 10_000;
    k.use("dryRun.fairValue", "dryRun.premiumBps");
    const out = [
      `Each option was offered at ${money(perOption)}: ${k.c("dryRun.premiumBps", (v) => pct(Number(v) / 10_000, 0))} of the fair value $${k.c("dryRun.fairValue")}.`,
    ];
    if (size !== null) {
      k.use("dryRun.size");
      out.push(
        `If all ${k.c("dryRun.size")} options sell, the vault earns about ${money(perOption * size)} of premium (before the performance fee).`,
      );
    }
    if (k.has("dryRun.yieldBps"))
      out.push(`That is a yield of ${k.c("dryRun.yieldBps", (v) => `${v} bps`)} on the collateral.`);
    if (isCallRecord(record)) out.push("Premium is paid in USDG; the collateral stays in the stock token.");
    return out;
  },

  alternatives: (k, record) => {
    const candidates = at(record, "decision.candidates");
    const alternatives = at(record, "decision.alternatives");
    if (!Array.isArray(candidates) && !Array.isArray(alternatives)) return null;
    const out: string[] = [];
    if (Array.isArray(candidates) && candidates.length) {
      const ok = candidates.filter((c) => isObj(c) && c.ok === true).length;
      k.use("decision.candidates");
      out.push(
        `It dry-ran ${candidates.length} candidates [decision.candidates]; the contract would accept ${ok} of them.`,
      );
      candidates.forEach((c, i) => {
        if (!isObj(c) || c.ok === true) return;
        out.push(
          `Target |delta| ${k.c(`decision.candidates.${i}.targetDeltaBps`, (v) => bpsDelta(Number(v)))} failed ${k.c(`decision.candidates.${i}.reason`)}.`,
        );
      });
    }
    if (Array.isArray(alternatives) && alternatives.length) {
      const parts = alternatives.map((a, i) =>
        isObj(a)
          ? `${k.c(`decision.alternatives.${i}.name`)}: premium $${k.c(`decision.alternatives.${i}.premiumIncomeUsd`)}, stress loss $${k.c(`decision.alternatives.${i}.stressLossUsd`)}${a.taken === true ? " (taken)" : ""}`
          : "",
      );
      out.push(`Alternatives to grade at settlement: ${parts.filter(Boolean).join("; ")}.`);
    }
    return out.length ? out : null;
  },

  market: (k) => {
    if (!k.has("market.spot")) return null;
    const out = [
      `Spot was $${k.c("market.spot")} (source: ${k.has("market.source") ? k.c("market.source") : "not stated"}).`,
    ];
    if (k.has("market.sigma"))
      out.push(`The pricer's volatility was ${k.c("market.sigma", (v) => pct(Number(v), 0))} a year.`);
    if (k.has("market.oracleStatus")) out.push(`Price feed status: ${k.c("market.oracleStatus")}.`);
    if (k.has("market.marketOpen")) {
      out.push(`The NYSE session was ${k.c("market.marketOpen", (v) => (v === true ? "open" : "closed"))}.`);
    }
    return out;
  },

  anchor: (k, record) => {
    const anchor = recordAnchorOf(record);
    if (!anchor)
      return [
        "This record has no anchor field: it was not committed on-chain (a dry run, or written before anchoring).",
      ];
    let matches = false;
    try {
      matches = decisionRecordHash(record).toLowerCase() === anchor.recordHash.toLowerCase();
    } catch {
      // not hashable: reported as a mismatch
    }
    return [
      `The record names hash ${k.c("anchor.recordHash")}, committed to DecisionLog ${k.c("anchor.contract")} in transaction ${k.c("anchor.txHash")} for epoch ${k.c("anchor.epoch")}.`,
      matches
        ? "keccak256 of this record (without its anchor field) equals that hash, so these fields are the ones committed."
        : "keccak256 of this record (without its anchor field) does not equal that hash: the record changed after it was anchored, so its fields are not the committed ones.",
      "To check the transaction itself, read it on the chain (the MCP tool explain_decision does with verify: true).",
    ];
  },

  agent: (k) => {
    if (!k.has("trackRecord.agentId")) return null;
    return [
      `Agent ${k.c("trackRecord.agentId")} after this run: ${k.c("trackRecord.accepted")} proposals accepted, ${k.c("trackRecord.rejected")} rejected, ${k.c("trackRecord.strikes")} of ${k.c("trackRecord.maxStrikes")} strikes, bond ${k.c("trackRecord.bond")} USDG, ${k.c("trackRecord.settledEpochs")} settled epochs, cumulative depositor PnL ${k.c("trackRecord.cumulativePnl")} USDG.`,
    ];
  },
};
