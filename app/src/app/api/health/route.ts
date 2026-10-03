import { NextResponse } from "next/server";

// GET /api/health: liveness only. It answers without touching a chain, GitHub or any other service, so a monitor can
// tell "the app is up" apart from "a chain or RPC is slow" (that is /api/status). The commit is Vercel's build commit
// when there is one.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "strike-app",
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}
