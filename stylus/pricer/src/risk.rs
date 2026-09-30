//! Risk engine on the same fixed-point (WAD) Black-Scholes as [`crate::math`]: greeks, implied volatility and
//! the vault's payout under spot shocks.
//!
//! Mirrored operation for operation by `contracts/src/pricing/RiskLib.sol`, so the Solidity reference and the
//! Stylus contract return identical results (checked by vectors and differential fuzzing). No floating point:
//! Stylus activation rejects float instructions.

use crate::math::{
    ERR_SPOT, ERR_STRIKE, MAX_PRICE, MIN_PRICE, SECONDS_PER_YEAR, SQRT_2PI, WAD, cdfs,
    check_inputs, d1, delta_from, div_wad, exp_neg, ln_ge_one, mul_wad, normal_cdf, premium, sqrt,
    u, wad,
};
use alloc::vec::Vec;
use alloy_primitives::{I256, U256};

/// Implied volatility search range: the protocol's sigma range, 5% to 500%.
pub const IV_MIN: u128 = WAD / 20;
pub const IV_MAX: u128 = 5 * WAD;
/// The search stops once a step moves sigma by at most this much (1e-12 in volatility).
pub const IV_TOL: u128 = 1_000_000;
/// ... or once the premium is within spot / 1e15 of the target: the engine's own accuracy (the normal CDF
/// approximation is good to ~1e-15), below which a smaller vega only chases rounding noise.
pub const IV_PRICE_TOL_DIV: u128 = 1_000_000_000_000_000;
/// Upper bound on solver rounds (Newton with bisection fallback; Newton usually needs 3 to 6).
pub const IV_MAX_ROUNDS: u32 = 64;
/// Largest upward spot shock, +1000%. Downward shocks must stay above -100%.
pub const MAX_SHOCK: u128 = 10 * WAD;

/// Error codes, continuing `math`'s: returned as `PricerInputOutOfRange(code)`.
/// The option price is not strictly between intrinsic value and the no-arbitrage cap (S for a call, K for a put).
pub const ERR_PRICE: u8 = 6;
/// The price is valid but its implied volatility lies outside [`IV_MIN`, `IV_MAX`].
pub const ERR_IV: u8 = 7;
/// A spot shock is at or below -100% or above +1000%.
pub const ERR_SHOCK: u8 = 8;

const WAD2: u128 = WAD * WAD;
/// theta per year / (2 × 365) = theta per day.
const TWO_DAYS_PER_YEAR: u128 = 2 * 365;

/// Standard normal density φ(x) for x = |x| >= 0 (WAD).
pub fn pdf(x: U256) -> U256 {
    div_wad(exp_neg(mul_wad(x, x) / U256::from(2)), u(SQRT_2PI))
}

/// Option greeks per option (one token), WAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Greeks {
    /// dPrice/dSpot. Negative for puts.
    pub delta: I256,
    /// dDelta/dSpot, per $1 of spot.
    pub gamma: U256,
    /// dPrice/dSigma, per 1.00 (100 points) of volatility.
    pub vega: U256,
    /// dPrice/dt, per calendar day (365-day year). Never positive at r = 0.
    pub theta: I256,
}

/// Black-Scholes greeks (r = 0), same inputs and input checks as [`crate::math::quote`].
///
/// gamma = φ(d1) / (S σ √T), vega = S φ(d1) √T, theta = −S φ(d1) σ / (2 √T) / 365. Each is one integer
/// expression with a single rounding at the end.
pub fn greeks(
    spot: U256,
    strike: U256,
    time: U256,
    sigma: U256,
    is_call: bool,
) -> Result<Greeks, u8> {
    check_inputs(spot, strike, time, sigma)?;
    let d = d1(spot, strike, time, sigma);
    let phi = pdf(d.abs);
    let spot_phi = spot * phi; // WAD², at most 1e30 × 4e17
    Ok(Greeks {
        delta: delta_from(normal_cdf(d.abs, d.negative), is_call),
        gamma: phi * u(WAD2) / (spot * d.vol_sqrt_t),
        vega: spot_phi * d.sqrt_t / u(WAD2),
        theta: -I256::from_raw(spot_phi * sigma / (d.sqrt_t * u(TWO_DAYS_PER_YEAR) * wad())),
    })
}

/// Premium and vega at `sigma` (inputs already checked). Kept out of line: the solver calls it from three
/// places, and one copy keeps the Stylus binary under the 24 KiB limit.
#[inline(never)]
fn price_vega(spot: U256, strike: U256, time: U256, sigma: U256, is_call: bool) -> (U256, U256) {
    let d = d1(spot, strike, time, sigma);
    let (nd1, nd2) = cdfs(&d);
    let vega = spot * pdf(d.abs) * d.sqrt_t / u(WAD2);
    (premium(spot, strike, nd1, nd2, is_call), vega)
}

/// Implied volatility of a premium (USD per token, WAD): the sigma in [5%, 500%] at which [`crate::math::quote`]
/// returns `price`.
///
/// Newton's method on sigma, kept inside a bracket [lo, hi] that every evaluation tightens (the premium rises
/// with sigma). A Newton step that would leave the bracket, or a zero vega, falls back to bisection. Stops when
/// a step moves sigma by at most [`IV_TOL`], the bracket is that narrow, the premium is within spot / 1e15 of
/// the target (the last Newton step is still applied), or after [`IV_MAX_ROUNDS`] rounds.
///
/// Errors: spot, strike, time as in `quote`; [`ERR_PRICE`] if `price` is not strictly between intrinsic value
/// and the cap (S for a call, K for a put: no sigma can produce it); [`ERR_IV`] if it needs a sigma outside
/// [5%, 500%].
pub fn implied_vol(
    price: U256,
    spot: U256,
    strike: U256,
    time: U256,
    is_call: bool,
) -> Result<U256, u8> {
    check_inputs(spot, strike, time, u(IV_MIN))?;
    let (intrinsic, cap) = if is_call {
        (spot.saturating_sub(strike), spot)
    } else {
        (strike.saturating_sub(spot), strike)
    };
    if price <= intrinsic || price >= cap {
        return Err(ERR_PRICE);
    }
    let mut lo = u(IV_MIN);
    let mut hi = u(IV_MAX);
    let (p_lo, _) = price_vega(spot, strike, time, lo, is_call);
    if price <= p_lo {
        return if price == p_lo { Ok(lo) } else { Err(ERR_IV) };
    }
    let (p_hi, _) = price_vega(spot, strike, time, hi, is_call);
    if price >= p_hi {
        return if price == p_hi { Ok(hi) } else { Err(ERR_IV) };
    }

    // First guess: the larger of the at-the-money approximation (time value ≈ S σ √T / √(2π)) and the
    // inflection point of the premium in sigma, σ* = √(2 |ln(S/K)| / T), from which Newton converges
    // monotonically (Manaster and Koehler, 1982).
    let t_wad = time * wad() / u(SECONDS_PER_YEAR);
    let mut sigma = (price - intrinsic) * u(SQRT_2PI) * wad() / (spot * sqrt(t_wad * wad()));
    let ln_abs = if spot >= strike {
        ln_ge_one(div_wad(spot, strike))
    } else {
        ln_ge_one(div_wad(strike, spot))
    };
    let inflection = sqrt(ln_abs * u(2 * WAD) / t_wad * wad());
    if inflection > sigma {
        sigma = inflection;
    }
    if sigma < lo {
        sigma = lo;
    } else if sigma > hi {
        sigma = hi;
    }

    for _ in 0..IV_MAX_ROUNDS {
        let (p, vega) = price_vega(spot, strike, time, sigma, is_call);
        if p == price {
            return Ok(sigma);
        }
        let above = p > price;
        if above {
            hi = sigma;
        } else {
            lo = sigma;
        }
        let diff = if above { p - price } else { price - p };
        // Newton step when it lands strictly inside the bracket, bisection otherwise.
        let mut next = (lo + hi) >> 1;
        if !vega.is_zero() {
            let step = div_wad(diff, vega);
            if above {
                if step < sigma - lo {
                    next = sigma - step;
                }
            } else if step < hi - sigma {
                next = sigma + step;
            }
        }
        let moved = if next > sigma {
            next - sigma
        } else {
            sigma - next
        };
        sigma = next;
        if moved <= u(IV_TOL) || hi - lo <= u(IV_TOL) || diff <= spot / u(IV_PRICE_TOL_DIV) {
            break;
        }
    }
    Ok(sigma)
}

/// Spot moved by `shock` (WAD, −0.3e18 = −30%), rounded down.
pub fn shocked_spot(spot: U256, shock: I256) -> Result<U256, u8> {
    if shock.is_negative() {
        if shock <= -I256::from_raw(wad()) {
            return Err(ERR_SHOCK);
        }
        Ok(mul_wad(spot, wad() - (-shock).into_raw()))
    } else {
        let up = shock.into_raw();
        if up > u(MAX_SHOCK) {
            return Err(ERR_SHOCK);
        }
        Ok(mul_wad(spot, wad() + up))
    }
}

/// USD value (WAD) the vault pays on `sold` options (WAD, 1e18 = one option on one token) settling at `price`,
/// with the settlement rounding: a call pays (S − K) / S tokens per option, valued at S; a put pays K − S.
pub fn payout_value(is_call: bool, strike: U256, sold: U256, price: U256) -> U256 {
    if is_call {
        if price <= strike {
            return U256::ZERO;
        }
        let per_option = div_wad(price - strike, price);
        mul_wad(mul_wad(sold, per_option), price)
    } else if strike > price {
        mul_wad(sold, strike - price)
    } else {
        U256::ZERO
    }
}

/// The vault's payout (USD, WAD) at each shocked spot, and the worst (largest) of them.
///
/// `sold` is in options, WAD. `shocks` are relative spot moves, WAD (−0.3e18 = −30%), each in (−100%, +1000%].
/// Errors: [`crate::math::ERR_SPOT`], [`crate::math::ERR_STRIKE`] for out-of-range prices, [`ERR_SHOCK`].
pub fn scenario_loss(
    is_call: bool,
    strike: U256,
    sold: U256,
    spot: U256,
    shocks: &[I256],
) -> Result<(U256, Vec<U256>), u8> {
    if spot < u(MIN_PRICE) || spot > u(MAX_PRICE) {
        return Err(ERR_SPOT);
    }
    if strike < u(MIN_PRICE) || strike > u(MAX_PRICE) {
        return Err(ERR_STRIKE);
    }
    let mut worst = U256::ZERO;
    let mut losses = Vec::with_capacity(shocks.len());
    for &shock in shocks {
        let loss = payout_value(is_call, strike, sold, shocked_spot(spot, shock)?);
        if loss > worst {
            worst = loss;
        }
        losses.push(loss);
    }
    Ok((worst, losses))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::quote;
    use proptest::prelude::*;

    fn to_f(x: U256) -> f64 {
        x.to_string().parse::<f64>().unwrap() / 1e18
    }

    fn to_fi(x: I256) -> f64 {
        if x.is_negative() {
            -to_f((-x).into_raw())
        } else {
            to_f(x.into_raw())
        }
    }

    fn w(x: f64) -> U256 {
        U256::from((x * 1e18) as u128)
    }

    fn wi(x: f64) -> I256 {
        let m = I256::from_raw(w(x.abs()));
        if x < 0.0 { -m } else { m }
    }

    const WEEK: u64 = 7 * 86_400;

    fn ref_cdf(x: f64) -> f64 {
        0.5 * libm::erfc(-x / core::f64::consts::SQRT_2)
    }

    /// Closed-form greeks in f64 (r = 0): delta, gamma, vega, theta per day.
    fn ref_greeks(s: f64, k: f64, t_sec: f64, v: f64, call: bool) -> (f64, f64, f64, f64) {
        let t = t_sec / 31_536_000.0;
        let vs = v * t.sqrt();
        let d1 = ((s / k).ln() + 0.5 * v * v * t) / vs;
        let phi = (-0.5 * d1 * d1).exp() / (2.0 * core::f64::consts::PI).sqrt();
        let delta = if call { ref_cdf(d1) } else { ref_cdf(d1) - 1.0 };
        (
            delta,
            phi / (s * vs),
            s * phi * t.sqrt(),
            -s * phi * v / (2.0 * t.sqrt()) / 365.0,
        )
    }

    /// Values from `research/risk_reference.py` (mpmath, 50 digits), to 18 significant digits.
    /// Case: S = 250, K = 275, 7 days, 60% vol (a weekly TSLA covered call) and the matching put.
    #[test]
    fn known_greeks_match_mpmath() {
        let g = greeks(w(250.0), w(275.0), U256::from(WEEK), w(0.6), true).unwrap();
        let rel = |got: f64, want: f64| ((got - want) / want).abs();
        assert!(
            rel(to_fi(g.delta), REF_CALL.0) < 1e-12,
            "delta {}",
            to_fi(g.delta)
        );
        assert!(
            rel(to_f(g.gamma), REF_CALL.1) < 1e-12,
            "gamma {}",
            to_f(g.gamma)
        );
        assert!(
            rel(to_f(g.vega), REF_CALL.2) < 1e-12,
            "vega {}",
            to_f(g.vega)
        );
        assert!(
            rel(to_fi(g.theta), REF_CALL.3) < 1e-12,
            "theta {}",
            to_fi(g.theta)
        );
        let p = greeks(w(250.0), w(275.0), U256::from(WEEK), w(0.6), false).unwrap();
        assert!(rel(to_fi(p.delta), REF_CALL.0 - 1.0) < 1e-12);
        // Gamma, vega and theta do not depend on the side at r = 0.
        assert_eq!((p.gamma, p.vega, p.theta), (g.gamma, g.vega, g.theta));
    }

    // (delta, gamma, vega, theta per day) for the call above, as printed by mpmath.
    #[allow(clippy::excessive_precision)]
    const REF_CALL: (f64, f64, f64, f64) = (
        0.134_468_746_012_801_522,
        0.010_423_844_089_171_537,
        7.496_600_201_116_516_45,
        -0.321_282_865_762_136_419,
    );

    /// Implied vol of mpmath's exact premium for (S 250, K 275, 7 days, 60%) recovers 60%.
    #[test]
    fn known_implied_vol() {
        let price = U256::from(REF_CALL_PRICE_WEI);
        let iv = implied_vol(price, w(250.0), w(275.0), U256::from(WEEK), true).unwrap();
        assert!((to_f(iv) - 0.6).abs() < 1e-9, "iv {}", to_f(iv));
    }

    /// mpmath premium of the call above, in wei (floor).
    const REF_CALL_PRICE_WEI: u128 = 1_360_283_237_652_240_758;

    #[test]
    fn greeks_delta_equals_quote_delta() {
        let (_, d) = quote(w(250.0), w(275.0), U256::from(WEEK), w(0.6), true).unwrap();
        let g = greeks(w(250.0), w(275.0), U256::from(WEEK), w(0.6), true).unwrap();
        assert_eq!(g.delta, d);
    }

    #[test]
    fn greeks_reject_like_quote() {
        let t = U256::from(86_400u64);
        assert_eq!(
            greeks(U256::ZERO, w(1.0), t, w(0.5), true),
            Err(crate::math::ERR_SPOT)
        );
        assert_eq!(
            greeks(w(1.0), w(1.0), U256::ZERO, w(0.5), true),
            Err(crate::math::ERR_TIME)
        );
        assert_eq!(
            greeks(w(1.0), w(1.0), t, w(6.0), true),
            Err(crate::math::ERR_VOL)
        );
    }

    #[test]
    fn implied_vol_rejects_arbitrage_and_range() {
        let (s, k, t) = (w(100.0), w(100.0), U256::from(WEEK));
        // At or below intrinsic, at or above the cap.
        assert_eq!(implied_vol(U256::ZERO, s, k, t, true), Err(ERR_PRICE));
        assert_eq!(implied_vol(s, s, k, t, true), Err(ERR_PRICE));
        assert_eq!(implied_vol(w(10.0), w(110.0), k, t, true), Err(ERR_PRICE));
        assert_eq!(implied_vol(k, s, k, t, false), Err(ERR_PRICE));
        // Valid price, but needs sigma below 5% or above 500%.
        let (tiny, _) = quote(s, k, t, w(0.02), true).unwrap();
        assert_eq!(implied_vol(tiny, s, k, t, true), Err(ERR_IV));
        assert_eq!(implied_vol(w(99.0), s, k, t, true), Err(ERR_IV));
        // Bad spot, strike or time.
        assert_eq!(
            implied_vol(w(1.0), U256::ZERO, k, t, true),
            Err(crate::math::ERR_SPOT)
        );
        assert_eq!(
            implied_vol(w(1.0), s, k, U256::ZERO, true),
            Err(crate::math::ERR_TIME)
        );
    }

    #[test]
    fn implied_vol_at_the_bounds() {
        let (s, k, t) = (w(100.0), w(100.0), U256::from(WEEK));
        let (p_lo, _) = quote(s, k, t, u(IV_MIN), true).unwrap();
        let (p_hi, _) = quote(s, k, t, u(IV_MAX), true).unwrap();
        assert_eq!(implied_vol(p_lo, s, k, t, true), Ok(u(IV_MIN)));
        assert_eq!(implied_vol(p_hi, s, k, t, true), Ok(u(IV_MAX)));
    }

    #[test]
    fn scenario_loss_known_values() {
        // 10 calls struck at 110 on spot 100: +20% pays (120 − 110) × 10 = $100 (to rounding), −20% pays nothing.
        let shocks = [wi(-0.2), wi(0.0), wi(0.2)];
        let (worst, l) = scenario_loss(true, w(110.0), w(10.0), w(100.0), &shocks).unwrap();
        assert_eq!(l[0], U256::ZERO);
        assert_eq!(l[1], U256::ZERO);
        assert!((to_f(l[2]) - 100.0).abs() < 1e-12, "{}", to_f(l[2]));
        assert_eq!(worst, l[2]);
        // 10 puts struck at 90: −20% pays (90 − 80) × 10 = $100 exactly.
        let (worst, l) = scenario_loss(false, w(90.0), w(10.0), w(100.0), &shocks).unwrap();
        assert_eq!(l[0], w(100.0));
        assert_eq!(worst, w(100.0));
        assert_eq!(l[2], U256::ZERO);
    }

    #[test]
    fn scenario_loss_rejects() {
        let s = w(100.0);
        assert_eq!(scenario_loss(true, s, s, s, &[wi(-1.0)]), Err(ERR_SHOCK));
        assert_eq!(scenario_loss(true, s, s, s, &[wi(10.5)]), Err(ERR_SHOCK));
        assert_eq!(scenario_loss(true, s, s, U256::ZERO, &[]), Err(ERR_SPOT));
        assert_eq!(scenario_loss(true, U256::ZERO, s, s, &[]), Err(ERR_STRIKE));
        assert_eq!(
            scenario_loss(true, s, s, s, &[]),
            Ok((U256::ZERO, Vec::new()))
        );
        // Boundary shocks are accepted.
        assert!(
            scenario_loss(
                true,
                s,
                s,
                s,
                &[wi(-0.999_999), I256::from_raw(u(MAX_SHOCK))]
            )
            .is_ok()
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// Greeks against closed form in f64.
        #[test]
        fn greeks_match_closed_form(
            s in 1.0f64..5000.0,
            moneyness in 0.5f64..1.5,
            t in 3600u64..(60 * 86_400),
            v in 0.05f64..2.0,
            call: bool,
        ) {
            let k = s * moneyness;
            let g = greeks(w(s), w(k), U256::from(t), w(v), call).unwrap();
            let (rd, rg, rv, rt) = ref_greeks(s, k, t as f64, v, call);
            prop_assert!((to_fi(g.delta) - rd).abs() < 1e-9);
            // Gamma relative to its at-the-money scale 1 / (S σ √T).
            let scale = 1.0 / (s * v * (t as f64 / 31_536_000.0).sqrt());
            prop_assert!((to_f(g.gamma) - rg).abs() / scale < 1e-9, "gamma {} vs {}", to_f(g.gamma), rg);
            prop_assert!((to_f(g.vega) - rv).abs() / s < 1e-9, "vega {} vs {}", to_f(g.vega), rv);
            let tscale = s * v / (t as f64 / 31_536_000.0).sqrt() / 365.0;
            prop_assert!((to_fi(g.theta) - rt).abs() / tscale < 1e-9, "theta {} vs {}", to_fi(g.theta), rt);
        }

        /// Gamma and vega are the derivatives of the fixed-point delta and price (central differences).
        #[test]
        fn greeks_are_derivatives(
            s in 20.0f64..2000.0,
            moneyness in 0.8f64..1.2,
            t in (2 * 86_400u64)..(60 * 86_400),
            v in 0.1f64..1.5,
            call: bool,
        ) {
            let (k, tt) = (w(s * moneyness), U256::from(t));
            let g = greeks(w(s), k, tt, w(v), call).unwrap();
            let hs = s * 1e-6;
            let (_, d_up) = quote(w(s + hs), k, tt, w(v), call).unwrap();
            let (_, d_dn) = quote(w(s - hs), k, tt, w(v), call).unwrap();
            let fd_gamma = (to_fi(d_up) - to_fi(d_dn)) / (2.0 * hs);
            let scale = 1.0 / (s * v * (t as f64 / 31_536_000.0).sqrt());
            prop_assert!((fd_gamma - to_f(g.gamma)).abs() <= 1e-5 * to_f(g.gamma) + 1e-8 * scale, "gamma {} vs {}", to_f(g.gamma), fd_gamma);
            let hv = 1e-6;
            let (p_up, _) = quote(w(s), k, tt, w(v + hv), call).unwrap();
            let (p_dn, _) = quote(w(s), k, tt, w(v - hv), call).unwrap();
            let fd_vega = (to_f(p_up) - to_f(p_dn)) / (2.0 * hv);
            prop_assert!((fd_vega - to_f(g.vega)).abs() <= 1e-5 * to_f(g.vega) + 1e-8 * s, "vega {} vs {}", to_f(g.vega), fd_vega);
        }

        /// Round trip: premium at sigma → implied vol → sigma, whenever the premium carries enough information
        /// (vega at least 1e-6 of spot). The recovered sigma always reproduces the premium.
        #[test]
        fn implied_vol_round_trip(
            s in 1.0f64..5000.0,
            moneyness in 0.7f64..1.3,
            t in 3600u64..(90 * 86_400),
            v in 0.05f64..5.0,
            call: bool,
        ) {
            let (sw, kw, tt, vw) = (w(s), w(s * moneyness), U256::from(t), w(v));
            let (p, _) = quote(sw, kw, tt, vw, call).unwrap();
            let intrinsic = if call { sw.saturating_sub(kw) } else { kw.saturating_sub(sw) };
            let cap = if call { sw } else { kw };
            prop_assume!(p > intrinsic && p < cap);
            let iv = implied_vol(p, sw, kw, tt, call).unwrap();
            let (p2, _) = quote(sw, kw, tt, iv, call).unwrap();
            let dp = if p2 > p { p2 - p } else { p - p2 };
            // The premium matches to rounding noise, relative to spot.
            prop_assert!(to_f(dp) / s < 1e-15 * 100.0, "premium {} vs {}", to_f(p2), to_f(p));
            let g = greeks(sw, kw, tt, vw, call).unwrap();
            if to_f(g.vega) / s > 1e-6 {
                prop_assert!((to_f(iv) - v).abs() < 1e-8, "iv {} vs {}", to_f(iv), v);
            }
        }

        /// Scenario loss: calls pay less than the collateral value, puts at most the strike.
        #[test]
        fn scenario_loss_bounded(
            s in 1u128..5000,
            k in 1u128..5000,
            sold in 0u128..1_000_000,
            shock_bps in -9_999i64..100_000,
            call: bool,
        ) {
            let (sw, kw, n) = (u(s * WAD), u(k * WAD), u(sold * WAD));
            let shock = I256::try_from(shock_bps as i128 * 100_000_000_000_000).unwrap();
            let (worst, l) = scenario_loss(call, kw, n, sw, &[shock, I256::ZERO]).unwrap();
            let shocked = shocked_spot(sw, shock).unwrap();
            prop_assert!(worst >= l[0] && worst >= l[1]);
            if call {
                prop_assert!(l[0] <= mul_wad(n, shocked));
            } else {
                prop_assert!(l[0] <= mul_wad(n, kw));
            }
        }
    }
}
