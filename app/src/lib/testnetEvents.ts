/** Chain the landing page's "Live on testnet" events happened on (Robinhood Chain testnet). */
export const LIVE_EVENTS_CHAIN_ID = 46630;

export interface LiveEvent {
  /** Block timestamp, unix seconds. */
  time: number;
  /** The contract event the transaction emitted. */
  event: string;
  title: string;
  text: string;
  tx: `0x${string}`;
  tone: "ok" | "bad";
}

/**
 * Real on-chain events from the first live epoch, oldest first. Append settlement (and later epochs) here;
 * every row links to its transaction on Blockscout.
 */
export const LIVE_EVENTS: readonly LiveEvent[] = [
  {
    time: 1790701741,
    event: "SeriesProposed",
    title: "Covered call accepted",
    text: "The agent proposed a 0.20-delta TSLA call: strike $369.86 with spot at $352.45, 4 options, expiring Fri Oct 2 at the close. Inside the mandate, so it went on sale.",
    tx: "0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4",
    tone: "ok",
  },
  {
    time: 1790701765,
    event: "ProposalRejected",
    title: "Reckless put rejected",
    text: "An at-the-money put (strike $352.44), far outside the 0.10 – 0.35 delta band. The contract rejected it without reverting and slashed 10 USDG of the agent's bond to the put vault's depositors.",
    tx: "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0",
    tone: "bad",
  },
  {
    time: 1790701785,
    event: "OptionsBought",
    title: "Buyer agent took the calls",
    text: "A buyer agent bought all 4 calls for 10.01 USDG, priced off the oracle at that moment. The premium is escrowed for the vault's depositors.",
    tx: "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9",
    tone: "ok",
  },
];
