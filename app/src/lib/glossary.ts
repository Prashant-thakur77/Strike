/** Plain-language definitions for the terms a first-time visitor won't know. One sentence each, defined once here
 *  and reused by <Term> tooltips and the /app/glossary page. */

export interface GlossaryEntry {
  term: string;
  def: string;
}

export const GLOSSARY = {
  option: {
    term: "Option",
    def: "A contract that gives its buyer the right to buy (a call) or sell (a put) a stock at a set price until a set date.",
  },
  strike: {
    term: "Strike",
    def: "The stock price an option is written at: a call pays its buyer above it, a put pays below it.",
  },
  premium: {
    term: "Premium",
    def: "The price an option buyer pays up front; in Strike it goes to the vault's depositors, in USDG.",
  },
  coveredCall: {
    term: "Covered call",
    def: "You hold the stock and sell the right to buy it from you at the strike: you get paid now and give up gains above the strike.",
  },
  cashSecuredPut: {
    term: "Cash-secured put",
    def: "You set cash aside and sell the right to sell you the stock at the strike: you get paid now and may end up buying the stock at the strike if it falls below.",
  },
  series: {
    term: "Series",
    def: "One week's batch of identical options (same stock, strike, expiry and type) that a vault sells.",
  },
  delta: {
    term: "Delta",
    def: "How much the option's price moves for a $1 move in the stock, from 0 to 1; roughly the chance it ends up paying out.",
  },
  gamma: {
    term: "Gamma",
    def: "How fast delta changes as the stock price moves.",
  },
  vega: {
    term: "Vega",
    def: "How much the option's price changes when volatility moves by one percentage point.",
  },
  theta: {
    term: "Theta",
    def: "How much value the option loses per day as expiry gets closer, everything else equal.",
  },
  greeks: {
    term: "Greeks",
    def: "Delta, gamma, vega and theta: standard measures of how an option's price reacts to the stock, volatility and time.",
  },
  impliedVol: {
    term: "Implied volatility",
    def: "How much the stock is expected to move in a year, as a percentage; higher volatility makes options cost more.",
  },
  fairValue: {
    term: "Fair value",
    def: "The option's price from the Black-Scholes formula, given the stock price, strike, time left and volatility.",
  },
  expiry: {
    term: "Expiry",
    def: "When the option ends and is settled; Strike's weekly options expire at the US market close, usually on Friday.",
  },
  epoch: {
    term: "Epoch",
    def: "One week in a vault's life: a new option series is listed, sold, then settled at expiry.",
  },
  tenor: {
    term: "Tenor",
    def: "How long an option runs, from listing to expiry.",
  },
  mandate: {
    term: "Mandate",
    def: "A vault's fixed rules (delta range, minimum premium, size and tenor) written into the contract; any proposal outside them is rejected.",
  },
  agent: {
    term: "Agent",
    def: "A program (often AI) registered on-chain that proposes each week's strike for a vault, within its mandate.",
  },
  bond: {
    term: "Bond",
    def: "USDG an agent locks up to be allowed to propose; it is what gets slashed when the agent breaks the rules.",
  },
  slash: {
    term: "Slash",
    def: "A penalty taken from an agent's bond when the contract rejects its proposal, paid to the vault's depositors.",
  },
  spotBuffer: {
    term: "Spot buffer",
    def: "How far the stock can move, as a percentage of today's price, before the option starts paying out.",
  },
  intrinsic: {
    term: "Intrinsic value",
    def: "What the option would pay if it expired right now: how far the stock is past the strike, or zero.",
  },
  multiplier: {
    term: "Multiplier (ERC-8056)",
    def: "The stock token's adjustment for splits and dividends: one token may stand for more or less than one share.",
  },
  erc8004: {
    term: "ERC-8004",
    def: "An on-chain identity standard for AI agents: each agent gets an ID that anyone can look up and rate.",
  },
  usdg: {
    term: "USDG",
    def: "Global Dollar, a US-dollar stablecoin issued by Paxos; Strike takes deposits, pays premiums and settles in it.",
  },
  stockToken: {
    term: "Stock token",
    def: "A token on Robinhood Chain that tracks one share of a US stock, such as TSLA.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;
