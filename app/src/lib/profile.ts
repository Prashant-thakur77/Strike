/** The vault list's two optional questions, answered from each vault's on-chain mandate (never a hand-set badge).
 *  SDK-free, so the Playwright specs can import it. */

export type Hold = "all" | "stock" | "usdg";
export type Upside = "any" | "some" | "little";

/** "How much upside will you give up?" read as the most a vault's mandate lets the agent sell, in delta (bps). */
export const UPSIDE_MAX_DELTA_BPS: Record<Upside, number | null> = { any: null, some: 3500, little: 2500 };

export const PROFILE_STORAGE_ID = "strike.profile.v1";

/** Does a vault's on-chain mandate fit the answers? */
export function fitsProfile(
  v: { isCall: boolean; mandate: { maxDeltaBps: number } },
  hold: Hold,
  upside: Upside,
): boolean {
  if (hold === "stock" && !v.isCall) return false;
  if (hold === "usdg" && v.isCall) return false;
  const cap = UPSIDE_MAX_DELTA_BPS[upside];
  return cap === null || v.mandate.maxDeltaBps <= cap;
}
