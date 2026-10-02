import { NextResponse, type NextRequest } from "next/server";
import {
  CACHE_HEADERS,
  ERROR_HEADERS,
  OptionMetaError,
  loadOption,
  optionMetadata,
  parseChainId,
} from "@/lib/optionMeta";

/** ERC-1155 metadata for a Strike option series: GET /api/option/{id}.json[?chainId=46630]; without chainId, every deployment is searched. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  try {
    const chainId = parseChainId(url.searchParams.get("chainId"));
    const option = await loadOption(chainId, id);
    return NextResponse.json(optionMetadata(option, url.origin), { headers: CACHE_HEADERS });
  } catch (err) {
    const status = err instanceof OptionMetaError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status, headers: ERROR_HEADERS });
  }
}
