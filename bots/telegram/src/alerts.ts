import { type Alert, type FormatContext, formatAlert } from "./format.js";
import { type AlertBuilder, type LogFetcher, scanLogs } from "./logs.js";
import type { Sleep } from "./retry.js";

export interface AlertPipeline {
  fetchLogs: LogFetcher;
  builder: AlertBuilder;
  format: FormatContext;
  maxRange: bigint;
  log?: (message: string) => void;
  sleep?: Sleep;
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Turn every alert log in `[from, to]` into a message and hand it to `deliver`, in chain order. After each
 * chunk is delivered, `onProgress` gets the next block to scan (store it as the cursor). A chunk's logs are all
 * decoded and joined with vault data before the first one is delivered, so an RPC failure mid-chunk never
 * leaves half a chunk sent.
 */
export async function processRange(
  from: bigint,
  to: bigint,
  p: AlertPipeline,
  deliver: (text: string, alert: Alert) => Promise<void>,
  onProgress: (nextBlock: bigint) => Promise<void>,
): Promise<number> {
  let delivered = 0;
  await scanLogs({
    from,
    to,
    maxRange: p.maxRange,
    fetchLogs: p.fetchLogs,
    log: p.log,
    sleep: p.sleep,
    retries: p.retries,
    baseDelayMs: p.baseDelayMs,
    onChunk: async (logs, end) => {
      const alerts: Alert[] = [];
      for (const log of logs) alerts.push(await p.builder.build(log));
      for (const alert of alerts) {
        await deliver(formatAlert(alert, p.format), alert);
        delivered += 1;
      }
      await onProgress(end + 1n);
    },
  });
  return delivered;
}
