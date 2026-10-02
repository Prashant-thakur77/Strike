import pino, { type Logger } from "pino";

/** JSON logs on stdout: ISO time, level as a word, the service name; secrets in headers are redacted. */
export function createLogger(level = "info", destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "strike-indexer" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
    },
    destination,
  );
}
