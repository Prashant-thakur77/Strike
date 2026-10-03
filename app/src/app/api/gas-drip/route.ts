import { gasDripAbi } from "@strike/sdk";
import { type NextRequest } from "next/server";
import { type Address, type Hex, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAppChain, isAppChainId } from "@/lib/chains";
import { gasDripOf } from "@/lib/drip";
import {
  GAS_DRIP_MAX_BODY,
  type GasDripChain,
  type GasDripDeps,
  gasDripLimiters,
  gasDripStatus,
  handleGasDrip,
} from "@/lib/gasDripServer";
import { serverReadTransport } from "@/lib/rpc/server";
import { readBodyLimited } from "@/lib/rpc/proxy";
import { clientIp } from "@/lib/waitlistServer";

// GET  /api/gas-drip?chainId=46630&address=0x…: the starter drip's live numbers, whether the address qualifies, and
//      the proof-of-work challenge it must solve before asking.
// POST /api/gas-drip {chainId, address, nonce}: checks the limits (lib/gasDripServer.ts) and sends GasDrip.drip(address)
//      from the relayer, waiting for the receipt. The relayer key is GAS_RELAYER_KEY in the server environment, read
//      at request time and never sent anywhere; without it every request answers 503 and the page links the chain's
//      faucet instead. D47. No CORS headers: the faucet page is the only caller.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const limiters = gasDripLimiters();

function relayerKey(): Hex | undefined {
  const k = process.env.GAS_RELAYER_KEY?.trim();
  if (!k) return undefined;
  const hex = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : undefined;
}

function chainFor(chainId: number): GasDripChain | null {
  const d = gasDripOf(chainId);
  if (!d || !isAppChainId(chainId)) return null;
  const key = relayerKey();
  const account = key ? privateKeyToAccount(key) : null;
  const relayer: Address = account?.address ?? d.relayer ?? "0x0000000000000000000000000000000000000000";
  const chain = getAppChain(chainId);
  const transport = serverReadTransport(chainId, { timeout: 10_000 });
  const pub = createPublicClient({ chain, transport });
  const c = { address: d.drip, abi: gasDripAbi } as const;
  return {
    drip: d.drip,
    relayer,
    async read(to) {
      const [amount, dailyCap, dripsLeftToday, remaining, relayerBalance, isRelayer, check] =
        await Promise.all([
          pub.readContract({ ...c, functionName: "amount" }),
          pub.readContract({ ...c, functionName: "dailyCap" }),
          pub.readContract({ ...c, functionName: "dripsLeftToday" }),
          pub.getBalance({ address: d.drip }),
          pub.getBalance({ address: relayer }),
          pub.readContract({ ...c, functionName: "isRelayer", args: [relayer] }),
          to ? pub.readContract({ ...c, functionName: "check", args: [to] }) : null,
        ]);
      return {
        amount,
        dailyCap: Number(dailyCap),
        dripsLeftToday: Number(dripsLeftToday),
        remaining,
        relayerBalance,
        isRelayer,
        check: check ? { ok: check[0], reason: check[1] } : undefined,
      };
    },
    async send(to) {
      if (!account) throw new Error("no relayer key");
      const wallet = createWalletClient({ account, chain, transport });
      const { request } = await pub.simulateContract({ ...c, functionName: "drip", args: [to], account });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 20_000 });
      if (receipt.status !== "success") throw new Error("drip reverted");
      return hash;
    },
  };
}

function deps(): GasDripDeps {
  const key = relayerKey();
  return {
    secret: process.env.GAS_DRIP_SALT || key,
    chain: chainFor,
    attempts: limiters.attempts,
    ipDrips: limiters.ipDrips,
    onError: (stage, err) =>
      console.warn(
        `gas-drip: ${stage} failed (${err instanceof Error ? err.message.split("\n")[0] : "unknown"})`,
      ),
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const p = req.nextUrl.searchParams;
  const r = await gasDripStatus(p.get("chainId"), p.get("address"), deps());
  return json(r.body, r.status, r.headers);
}

export async function POST(request: Request): Promise<Response> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? ""))
    return json({ ok: false, reason: "BadRequest", message: "Send JSON." }, 415);
  const raw = await readBodyLimited(request.body, GAS_DRIP_MAX_BODY);
  if (raw === null) return json({ ok: false, reason: "BadRequest", message: "Request too large." }, 413);
  const r = await handleGasDrip(raw, clientIp(request.headers), deps());
  return json(r.body, r.status, r.headers);
}
