// Small, dependency-free EVM helpers for the evidence scripts (check-claims.mjs, proven-week.mjs): keccak-256, event
// signatures and log decoding for the static types Strike's events use, and a read-only JSON-RPC client that tells an
// unreachable RPC apart from a missing transaction. No package install is needed, so CI runs these with plain Node.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG = JSON.parse(readFileSync(join(ROOT, "strike.config.json"), "utf8"));

// ------------------------------------------------------------------------------------------------ keccak-256

const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
// ROT[x][y], the rho offsets.
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const M64 = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    const d = [0, 1, 2, 3, 4].map((x) => c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1));
    for (let i = 0; i < 25; i++) s[i] ^= d[i % 5];
    const b = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** keccak-256 of a string (UTF-8) or bytes, as 0x-prefixed hex. */
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(bytes.length + (rate - (bytes.length % rate)));
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  let hex = "0x";
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 8; k++) hex += ((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

// ------------------------------------------------------------------------------------------------ events

/**
 * Parses a Solidity-style event declaration, e.g.
 * "Slashed(uint256 indexed agentId, address indexed recipient, uint256 amount, uint32 strikes)".
 */
export function parseEvent(decl) {
  const m = decl.trim().match(/^(\w+)\s*\((.*)\)$/);
  if (!m) throw new Error(`event declaration "${decl}"`);
  const params = m[2].trim()
    ? m[2].split(",").map((p, i) => {
        const parts = p.trim().split(/\s+/);
        const type = parts[0];
        const indexed = parts.includes("indexed");
        const name = parts.length > (indexed ? 2 : 1) ? parts.at(-1) : `arg${i}`;
        return { type, indexed, name };
      })
    : [];
  const signature = `${m[1]}(${params.map((p) => p.type).join(",")})`;
  return { name: m[1], params, signature, topic0: keccak256(signature) };
}

const isDynamic = (type) => type === "string" || type === "bytes" || type.endsWith("[]");

function decodeWord(type, word) {
  const v = BigInt(`0x${word}`);
  if (type === "address") return `0x${word.slice(24)}`;
  if (type === "bool") return v !== 0n;
  if (/^bytes\d+$/.test(type)) return `0x${word.slice(0, Number(type.slice(5)) * 2)}`;
  const int = type.match(/^int(\d*)$/);
  if (int) {
    const bits = BigInt(int[1] || 256);
    const lo = v & ((1n << bits) - 1n);
    return lo >= 1n << (bits - 1n) ? lo - (1n << bits) : lo;
  }
  if (/^uint\d*$/.test(type)) return v;
  throw new Error(`unsupported static type ${type}`);
}

/** Decodes a log against a parsed event. Indexed dynamic values come back as their topic (a hash). */
export function decodeLog(event, log) {
  if (log.topics[0]?.toLowerCase() !== event.topic0) return null;
  // Same name and types, different indexing (ERC-20 and ERC-721 Transfer): the topic count tells them apart.
  if (log.topics.length !== 1 + event.params.filter((p) => p.indexed).length) return null;
  const data = log.data.replace(/^0x/, "");
  if (data.length < 64 * event.params.filter((p) => !p.indexed).length) return null;
  const word = (i) => data.slice(i * 64, i * 64 + 64);
  const out = {};
  let topic = 1;
  let slot = 0;
  for (const p of event.params) {
    if (p.indexed) {
      const t = log.topics[topic++];
      if (t === undefined) return null;
      out[p.name] = isDynamic(p.type) ? t : decodeWord(p.type, t.replace(/^0x/, ""));
    } else if (isDynamic(p.type)) {
      const off = Number(BigInt(`0x${word(slot++)}`)) * 2;
      const len = Number(BigInt(`0x${data.slice(off, off + 64)}`));
      const bytes = data.slice(off + 64, off + 64 + len * 2);
      out[p.name] = p.type === "string" ? Buffer.from(bytes, "hex").toString("utf8") : `0x${bytes}`;
    } else {
      out[p.name] = decodeWord(p.type, word(slot++));
    }
  }
  return out;
}

/** Every log of the receipt (optionally from one address) that decodes as the event. */
export function findEvents(receipt, decl, address) {
  const event = typeof decl === "string" ? parseEvent(decl) : decl;
  return receipt.logs
    .filter((l) => !address || l.address.toLowerCase() === address.toLowerCase())
    .map((l) => ({ log: l, args: decodeLog(event, l) }))
    .filter((x) => x.args);
}

// ------------------------------------------------------------------------------------------------ values

/** Formats an integer amount with `decimals` decimals, trimming trailing zeros ("10005944", 6 -> "10.005944"). */
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

/** "10.005944" with 6 decimals -> 10005944n. */
export function parseUnits(text, decimals) {
  const m = String(text)
    .trim()
    .match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`not a decimal number: "${text}"`);
  const frac = (m[3] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimals`);
  const v = BigInt(m[2]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return m[1] ? -v : v;
}

/** Rounds an integer amount to `places` decimals of a `decimals` unit, half up, as a fixed string. */
export function roundUnits(value, decimals, places) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const step = 10n ** BigInt(decimals - places);
  const r = (abs + step / 2n) / step;
  const s = r.toString().padStart(places + 1, "0");
  const txt = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  return `${neg ? "-" : ""}${txt}`;
}

export const isoMinute = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
export const isoSecond = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ");

// ------------------------------------------------------------------------------------------------ RPC

export class RpcUnreachable extends Error {}

/** The public RPC of a chain in strike.config.json, unless STRIKE_RPC_<chainId> overrides it. */
export function rpcUrl(chainId) {
  return process.env[`STRIKE_RPC_${chainId}`] || CONFIG.chains[String(chainId)]?.rpc?.public || null;
}

/** A read-only JSON-RPC client. Network errors, timeouts and HTTP errors after `retries` tries throw RpcUnreachable. */
export function rpcClient(url, { timeoutMs = 20_000, retries = 3 } = {}) {
  let id = 0;
  async function call(method, params) {
    let last;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          last = new Error(`HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        if (body.error) {
          // Rate limits come back as JSON-RPC errors on some public RPCs: retry those, report the rest.
          if (/rate|limit|too many|timeout|busy/i.test(body.error.message ?? "")) {
            last = new Error(body.error.message);
            continue;
          }
          throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpcError: body.error });
        }
        return body.result;
      } catch (e) {
        if (e.rpcError) throw e;
        last = e;
      }
    }
    throw new RpcUnreachable(`${url}: ${last?.message ?? "no answer"}`);
  }
  return {
    url,
    call,
    chainId: async () => Number(BigInt(await call("eth_chainId", []))),
    receipt: (hash) => call("eth_getTransactionReceipt", [hash]),
    transaction: (hash) => call("eth_getTransactionByHash", [hash]),
    block: async (n) =>
      call("eth_getBlockByNumber", [typeof n === "string" ? n : `0x${BigInt(n).toString(16)}`, false]),
    blockNumber: async () => Number(BigInt(await call("eth_blockNumber", []))),
    ethCall: (to, data, block = "latest") => call("eth_call", [{ to, data }, block]),
    logs: (filter) => call("eth_getLogs", [filter]),
  };
}

/** Runs `fn` over `items` with at most `n` in flight, keeping the order of results. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The 4-byte selector of a function signature, e.g. "balanceOf(address)". */
export const selector = (sig) => keccak256(sig).slice(0, 10);

/** ABI-encodes static arguments (uint/int as bigint or number, address, bool, bytes32) after a selector. */
export function encodeCall(sig, args = []) {
  const types = sig
    .slice(sig.indexOf("(") + 1, -1)
    .split(",")
    .filter(Boolean);
  const words = types.map((t, i) => {
    const a = args[i];
    if (t === "address") return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (t === "bool") return (a ? 1n : 0n).toString(16).padStart(64, "0");
    if (t === "bytes32") return a.replace(/^0x/, "").padEnd(64, "0");
    const v = BigInt(a);
    return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
  });
  return selector(sig) + words.join("");
}

/** Splits eth_call return data into 32-byte words. */
export const words = (hex) => (hex.replace(/^0x/, "").match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));
