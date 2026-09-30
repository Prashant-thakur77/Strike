import { SKILL_MD } from "@/lib/skill";

// The agent skill file (docs/STRIKE_SKILL.md), so an agent can join from one URL: /skill.md.
export const dynamic = "force-static";

export function GET() {
  return new Response(SKILL_MD, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
