import { NextResponse, type NextRequest } from "next/server";
import { optionSvg } from "@/lib/optionImage";
import { CACHE_HEADERS, ERROR_HEADERS, OptionMetaError, loadOption, parseChainId } from "@/lib/optionMeta";

/** SVG card for an option series: GET /api/option/{id}/image[?chainId=46630] */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const chainId = parseChainId(new URL(req.url).searchParams.get("chainId"));
    const option = await loadOption(chainId, id);
    return new NextResponse(optionSvg(option), {
      headers: { ...CACHE_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8" },
    });
  } catch (err) {
    const status = err instanceof OptionMetaError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status, headers: ERROR_HEADERS });
  }
}
