import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

// HTTP for the RPC clients: one keep-alive connection pool and a DNS cache. Node's fetch resolves the host name for
// every new connection and closes idle ones after 4 s, so each poll reopens connections, and a burst of parallel
// reads (block headers, vault values) turns into a burst of lookups. Where lookups are slow (measured 4 s each in a
// Docker network whose embedded DNS falls back to unreachable resolvers), those queue on libuv's four threads past
// the connect timeout and fail as "fetch failed". Here a host is looked up once per minute, concurrent lookups of
// the same host share one, and connections stay open across polls.

type LookupAll = (hostname: string, cb: (err: Error | null, addresses: dns.LookupAddress[]) => void) => void;

const systemLookupAll: LookupAll = (hostname, cb) => dns.lookup(hostname, { all: true }, cb);

type Callback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** A `lookup` for net/tls connect: cached for `ttlMs`, one lookup in flight per host, failures never cached. */
export function cachingLookup(opts: { ttlMs?: number; lookupAll?: LookupAll } = {}) {
  const ttl = opts.ttlMs ?? 60_000;
  const lookupAll = opts.lookupAll ?? systemLookupAll;
  const cache = new Map<string, { at: number; addresses: dns.LookupAddress[] }>();
  const pending = new Map<string, Promise<dns.LookupAddress[]>>();

  const resolveAll = (hostname: string): Promise<dns.LookupAddress[]> => {
    const hit = cache.get(hostname);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.addresses);
    let p = pending.get(hostname);
    if (!p) {
      p = new Promise<dns.LookupAddress[]>((resolve, reject) =>
        lookupAll(hostname, (err, addresses) => (err ? reject(err) : resolve(addresses))),
      )
        .then((addresses) => {
          cache.set(hostname, { at: Date.now(), addresses });
          return addresses;
        })
        .finally(() => pending.delete(hostname));
      pending.set(hostname, p);
    }
    return p;
  };

  return (hostname: string, options: dns.LookupOptions | number | Callback, callback?: Callback): void => {
    const cb = (typeof options === "function" ? options : callback) as Callback;
    const o: dns.LookupOptions =
      typeof options === "number" ? { family: options } : typeof options === "object" ? options : {};
    const family = o.family === 4 || o.family === "IPv4" ? 4 : o.family === 6 || o.family === "IPv6" ? 6 : 0;
    resolveAll(hostname).then(
      (all) => {
        const list = family ? all.filter((a) => a.family === family) : all;
        if (!list.length) {
          const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = "ENOTFOUND";
          return cb(err, o.all ? [] : "", undefined);
        }
        if (o.all) return cb(null, list);
        return cb(null, list[0]!.address, list[0]!.family);
      },
      (err: NodeJS.ErrnoException) => cb(err, o.all ? [] : "", undefined),
    );
  };
}

/** A fetch over one undici Agent with the DNS cache and keep-alive connections (viem's `fetchFn`). */
export function createRpcFetch(): typeof fetch {
  const agent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connect: { lookup: cachingLookup() as never, timeout: 20_000 },
  });
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(
      input as never,
      { ...(init as object), dispatcher: agent } as never,
    )) as unknown as typeof fetch;
}
