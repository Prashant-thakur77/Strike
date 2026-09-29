import { appendFileSync } from "node:fs";
import { readClient } from "./chain.js";

// Is the NYSE regular session open at the chain's latest block (StockOracle.isMarketOpen, holidays included)?
// Prints the answer and, under GitHub Actions, writes `open=true|false` to $GITHUB_OUTPUT. Always exits 0 when the
// chain answers, so a closed market is a clean skip rather than a failure.

async function main() {
  const strike = readClient();
  const [open, now] = await Promise.all([strike.marketOpen(), strike.blockTimestamp()]);
  const at = new Date(Number(now) * 1000).toISOString();
  console.log(`NYSE ${open ? "open" : "closed"} at chain ${strike.chainId} time ${at}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `open=${open}\n`);
}

main().catch((err: unknown) => {
  console.error(`market check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
