//! Fixed-point Black-Scholes on 18-decimal integers (WAD).
//!
//! Every function here is mirrored line for line by `contracts/src/pricing/BlackScholesLib.sol`.
//! Both sides use the same integer operations in the same order, so they return identical
//! results; the Foundry differential suite checks that on random inputs.
//!
//! Model: European option, zero interest rate (weekly tenors on a stablecoin quote),
//! 365-day year. `ln` uses the atanh series, `exp` a range-reduced Taylor series, and the
//! normal CDF the Hart (1968) rational approximation in the form published by West (2005).

use alloy_primitives::{I256, U256};

pub const WAD: u128 = 1_000_000_000_000_000_000;
/// ln(2) * 1e18, rounded down.
pub const LN2: u128 = 693_147_180_559_945_309;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;
/// sqrt(2 * pi) * 1e18, rounded down.
pub const SQRT_2PI: u128 = 2_506_628_274_631_000_502;

/// Input bounds. Outside them the pricer refuses to quote.
pub const MIN_PRICE: u128 = 1_000_000; // 1e-12 USD
pub const MAX_PRICE: u128 = 1_000_000_000_000 * WAD; // 1e12 USD
pub const MIN_TIME: u128 = 1; // seconds
pub const MAX_TIME: u128 = 2 * SECONDS_PER_YEAR;
pub const MIN_VOL: u128 = WAD / 100; // 1%
pub const MAX_VOL: u128 = 5 * WAD; // 500%

/// Error codes, returned as `PricerInputOutOfRange(code)`.
pub const ERR_SPOT: u8 = 1;
pub const ERR_STRIKE: u8 = 2;
pub const ERR_TIME: u8 = 3;
pub const ERR_VOL: u8 = 4;

// Hart / West coefficients, scaled by 1e18.
const A0: u128 = 35_262_496_599_891_100;
const A1: u128 = 700_383_064_443_688_000;
const A2: u128 = 6_373_962_203_531_650_000;
const A3: u128 = 33_912_866_078_383_000_000;
const A4: u128 = 112_079_291_497_871_000_000;
const A5: u128 = 221_213_596_169_931_000_000;
const A6: u128 = 220_206_867_912_376_000_000;
const B0: u128 = 88_388_347_648_318_400;
const B1: u128 = 1_755_667_163_182_640_000;
const B2: u128 = 16_064_177_579_207_000_000;
const B3: u128 = 86_780_732_202_946_100_000;
const B4: u128 = 296_564_248_779_674_000_000;
const B5: u128 = 637_333_633_378_831_000_000;
const B6: u128 = 793_826_512_519_948_000_000;
const B7: u128 = 440_413_735_824_752_000_000;
const CUTOFF: u128 = 7_071_067_811_865_470_000; // 10 / sqrt(2)
const TAIL_ZERO: u128 = 37 * WAD;
const EXP_ZERO: u128 = 42 * WAD;

#[inline]
pub(crate) fn u(x: u128) -> U256 {
    U256::from(x)
}

#[inline]
pub(crate) fn wad() -> U256 {
    u(WAD)
}

/// a * b / 1e18, rounded down. Panics on overflow, like Solidity 0.8.
/// Not inlined (nor `div_wad`): dozens of inlined copies would push the Stylus binary past the 24 KiB compressed
/// limit; the call costs almost nothing in WASM.
#[inline(never)]
pub(crate) fn mul_wad(a: U256, b: U256) -> U256 {
    a.checked_mul(b).expect("mul overflow") / wad()
}

/// a * 1e18 / b, rounded down.
#[inline(never)]
pub(crate) fn div_wad(a: U256, b: U256) -> U256 {
    a.checked_mul(wad()).expect("mul overflow") / b
}

/// Floor of the square root.
/// Integer Newton iteration (no floating point: Stylus WASM rejects float instructions).
pub fn sqrt(x: U256) -> U256 {
    if x.is_zero() {
        return x;
    }
    // Start at 2^ceil(bits/2) >= sqrt(x) so the iteration decreases monotonically to the floor.
    let mut z = U256::from(1) << x.bit_len().div_ceil(2);
    loop {
        let y = (z + x / z) >> 1;
        if y >= z {
            return z;
        }
        z = y;
    }
}

/// e^r for 0 <= r < ln 2 (WAD), Taylor series until the next term rounds to zero.
fn exp_small(r: U256) -> U256 {
    let mut sum = wad();
    let mut term = wad();
    let mut n: u64 = 1;
    loop {
        term = mul_wad(term, r) / U256::from(n);
        if term.is_zero() {
            break;
        }
        sum += term;
        n += 1;
    }
    sum
}

/// e^(-y) for y >= 0 (WAD).
pub fn exp_neg(y: U256) -> U256 {
    if y >= u(EXP_ZERO) {
        return U256::ZERO;
    }
    let k = y / u(LN2);
    let r = y - k * u(LN2);
    let e_neg_r = (wad() * wad()) / exp_small(r);
    // k <= 60 (y < 42), so the low limb is k; this also avoids pulling in the formatting code of `to::<usize>()`.
    e_neg_r >> (k.as_limbs()[0] as usize)
}

/// ln(x) for x >= 1 (WAD). Returns a non-negative WAD.
pub fn ln_ge_one(x: U256) -> U256 {
    debug_assert!(x >= wad());
    let q = x / wad();
    // k = floor(log2(q)); q >= 1 so bit_len >= 1.
    let k = q.bit_len() - 1;
    let m = x >> k; // in [1e18, 2e18)
    let z = div_wad(m - wad(), m + wad());
    let z2 = mul_wad(z, z);
    let mut sum = U256::ZERO;
    let mut term = z;
    let mut n: u64 = 1;
    while !term.is_zero() {
        sum += term / U256::from(n);
        term = mul_wad(term, z2);
        n += 2;
    }
    U256::from(k) * u(LN2) + sum * U256::from(2)
}

/// N(-x) for x >= 0 (WAD): the lower tail of the standard normal distribution.
pub fn normal_tail(x: U256) -> U256 {
    if x > u(TAIL_ZERO) {
        return U256::ZERO;
    }
    let e = exp_neg(mul_wad(x, x) / U256::from(2));
    if x < u(CUTOFF) {
        let mut num = mul_wad(u(A0), x) + u(A1);
        num = mul_wad(num, x) + u(A2);
        num = mul_wad(num, x) + u(A3);
        num = mul_wad(num, x) + u(A4);
        num = mul_wad(num, x) + u(A5);
        num = mul_wad(num, x) + u(A6);
        num = mul_wad(e, num);
        let mut den = mul_wad(u(B0), x) + u(B1);
        den = mul_wad(den, x) + u(B2);
        den = mul_wad(den, x) + u(B3);
        den = mul_wad(den, x) + u(B4);
        den = mul_wad(den, x) + u(B5);
        den = mul_wad(den, x) + u(B6);
        den = mul_wad(den, x) + u(B7);
        div_wad(num, den)
    } else {
        let mut b = x + u(WAD * 65 / 100);
        b = x + div_wad(u(4 * WAD), b);
        b = x + div_wad(u(3 * WAD), b);
        b = x + div_wad(u(2 * WAD), b);
        b = x + div_wad(wad(), b);
        div_wad(div_wad(e, b), u(SQRT_2PI))
    }
}

/// Standard normal CDF of a signed value given as (|x|, x < 0).
pub fn normal_cdf(abs: U256, negative: bool) -> U256 {
    let tail = normal_tail(abs);
    if negative { tail } else { wad() - tail }
}

/// Rejects inputs outside the supported range with the matching error code.
pub(crate) fn check_inputs(spot: U256, strike: U256, time: U256, sigma: U256) -> Result<(), u8> {
    if spot < u(MIN_PRICE) || spot > u(MAX_PRICE) {
        return Err(ERR_SPOT);
    }
    if strike < u(MIN_PRICE) || strike > u(MAX_PRICE) {
        return Err(ERR_STRIKE);
    }
    if time < u(MIN_TIME) || time > u(MAX_TIME) {
        return Err(ERR_TIME);
    }
    if sigma < u(MIN_VOL) || sigma > u(MAX_VOL) {
        return Err(ERR_VOL);
    }
    Ok(())
}

/// d1 of Black-Scholes and the terms it is built from.
pub(crate) struct D1 {
    /// |d1| (WAD).
    pub abs: U256,
    /// d1 < 0.
    pub negative: bool,
    /// sigma * sqrt(T) (WAD).
    pub vol_sqrt_t: U256,
    /// sqrt(T), T in years (WAD).
    pub sqrt_t: U256,
}

/// d1 = (ln(S/K) + sigma^2 T / 2) / (sigma sqrt(T)), inputs already checked.
pub(crate) fn d1(spot: U256, strike: U256, time: U256, sigma: U256) -> D1 {
    let t_wad = time * wad() / u(SECONDS_PER_YEAR);
    let sqrt_t = sqrt(t_wad * wad());
    let vol_sqrt_t = mul_wad(sigma, sqrt_t);
    let half_var = mul_wad(mul_wad(sigma, sigma), t_wad) / U256::from(2);

    // ln(S/K) as (|ln|, sign).
    let (ln_abs, ln_neg) = if spot >= strike {
        (ln_ge_one(div_wad(spot, strike)), false)
    } else {
        (ln_ge_one(div_wad(strike, spot)), true)
    };

    // d1 numerator = ln(S/K) + sigma^2 T / 2.
    let (d1_num, d1_neg) = if !ln_neg {
        (ln_abs + half_var, false)
    } else if ln_abs > half_var {
        (ln_abs - half_var, true)
    } else {
        (half_var - ln_abs, false)
    };
    D1 {
        abs: div_wad(d1_num, vol_sqrt_t),
        negative: d1_neg,
        vol_sqrt_t,
        sqrt_t,
    }
}

/// N(d1) and N(d2), with d2 = d1 - sigma sqrt(T).
pub(crate) fn cdfs(d: &D1) -> (U256, U256) {
    let (d2_abs, d2_neg) = if d.negative {
        (d.abs + d.vol_sqrt_t, true)
    } else if d.abs >= d.vol_sqrt_t {
        (d.abs - d.vol_sqrt_t, false)
    } else {
        (d.vol_sqrt_t - d.abs, true)
    };
    (normal_cdf(d.abs, d.negative), normal_cdf(d2_abs, d2_neg))
}

/// Premium from N(d1) and N(d2), floored at zero.
pub(crate) fn premium(spot: U256, strike: U256, nd1: U256, nd2: U256, is_call: bool) -> U256 {
    let (a, b) = if is_call {
        (mul_wad(spot, nd1), mul_wad(strike, nd2))
    } else {
        (mul_wad(strike, wad() - nd2), mul_wad(spot, wad() - nd1))
    };
    if a > b { a - b } else { U256::ZERO }
}

/// Delta from N(d1): N(d1) for a call, N(d1) - 1 for a put.
pub(crate) fn delta_from(nd1: U256, is_call: bool) -> I256 {
    if is_call {
        I256::from_raw(nd1)
    } else {
        I256::from_raw(nd1) - I256::from_raw(wad())
    }
}

/// Black-Scholes price and delta.
///
/// * `spot`, `strike`: USD per token, WAD.
/// * `time`: seconds to expiry.
/// * `sigma`: annualised volatility, WAD (0.6e18 = 60%).
///
/// Returns (premium in USD per token, WAD) and delta (WAD; negative for puts).
pub fn quote(
    spot: U256,
    strike: U256,
    time: U256,
    sigma: U256,
    is_call: bool,
) -> Result<(U256, I256), u8> {
    check_inputs(spot, strike, time, sigma)?;
    let (nd1, nd2) = cdfs(&d1(spot, strike, time, sigma));
    Ok((
        premium(spot, strike, nd1, nd2, is_call),
        delta_from(nd1, is_call),
    ))
}

/// Bisection rounds for `strike_for_delta` (relative precision ~ 20 / 2^48 ≈ 7e-14 of spot).
pub const STRIKE_SEARCH_ROUNDS: u32 = 48;
pub const ERR_DELTA: u8 = 5;

/// Strike whose |delta| equals `target_delta` (WAD, strictly between 0 and 1), found by a fixed number of
/// bisection rounds over [spot / 10, spot * 10]. Deterministic, so the Solidity mirror returns the same strike.
pub fn strike_for_delta(
    spot: U256,
    target_delta: U256,
    time: U256,
    sigma: U256,
    is_call: bool,
) -> Result<U256, u8> {
    if target_delta.is_zero() || target_delta >= wad() {
        return Err(ERR_DELTA);
    }
    let mut lo = spot / U256::from(10);
    let mut hi = spot * U256::from(10);
    if lo < u(MIN_PRICE) {
        lo = u(MIN_PRICE);
    }
    if hi > u(MAX_PRICE) {
        hi = u(MAX_PRICE);
    }
    for _ in 0..STRIKE_SEARCH_ROUNDS {
        let mid = (lo + hi) >> 1;
        let (_, d) = quote(spot, mid, time, sigma, is_call)?;
        let abs = if d.is_negative() {
            (-d).into_raw()
        } else {
            d.into_raw()
        };
        // Call |delta| falls as the strike rises; put |delta| rises with the strike.
        let go_up = if is_call {
            abs > target_delta
        } else {
            abs < target_delta
        };
        if go_up {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Ok((lo + hi) >> 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn to_f(x: U256) -> f64 {
        x.to_string().parse::<f64>().unwrap() / 1e18
    }

    fn w(x: f64) -> U256 {
        U256::from((x * 1e18) as u128)
    }

    fn ref_cdf(x: f64) -> f64 {
        0.5 * libm::erfc(-x / core::f64::consts::SQRT_2)
    }

    /// Closed-form Black-Scholes in f64, r = 0.
    fn ref_bs(s: f64, k: f64, t_sec: f64, v: f64, call: bool) -> (f64, f64) {
        let t = t_sec / 31_536_000.0;
        let vs = v * t.sqrt();
        let d1 = ((s / k).ln() + 0.5 * v * v * t) / vs;
        let d2 = d1 - vs;
        if call {
            (s * ref_cdf(d1) - k * ref_cdf(d2), ref_cdf(d1))
        } else {
            (k * ref_cdf(-d2) - s * ref_cdf(-d1), ref_cdf(d1) - 1.0)
        }
    }

    #[test]
    fn ln_matches_f64() {
        for x in [1.0, 1.5, 2.0, core::f64::consts::E, 10.0, 1234.5678, 1e12] {
            let got = to_f(ln_ge_one(w(x)));
            assert!((got - x.ln()).abs() < 1e-12, "ln({x}) = {got}");
        }
    }

    #[test]
    fn sqrt_is_floor() {
        for x in [0u128, 1, 2, 3, 4, 15, 16, 17, 1_000_000, WAD, u128::MAX] {
            let r = sqrt(u(x));
            assert!(
                r * r <= u(x) && (r + U256::from(1)) * (r + U256::from(1)) > u(x),
                "sqrt({x})"
            );
        }
        let big = U256::MAX >> 2;
        let r = sqrt(big);
        assert!(r * r <= big);
    }

    #[test]
    fn ln_one_is_zero() {
        assert_eq!(ln_ge_one(wad()), U256::ZERO);
    }

    #[test]
    fn exp_neg_matches_f64() {
        for y in [0.0, 0.1, 0.5, 0.693, 1.0, 5.0, 20.0, 40.0] {
            let got = to_f(exp_neg(w(y)));
            assert!((got - (-y).exp()).abs() < 1e-15, "exp(-{y}) = {got}");
        }
        assert_eq!(exp_neg(u(EXP_ZERO)), U256::ZERO);
        assert_eq!(exp_neg(U256::ZERO), wad());
    }

    #[test]
    fn cdf_matches_erfc() {
        for x in [0.0, 0.1, 0.5, 1.0, 1.96, 3.0, 5.0, 7.0, 7.1, 8.0, 10.0] {
            let up = to_f(normal_cdf(w(x), false));
            let dn = to_f(normal_cdf(w(x), true));
            assert!((up - ref_cdf(x)).abs() < 1e-14, "N({x}) = {up}");
            assert!((dn - ref_cdf(-x)).abs() < 1e-14, "N(-{x}) = {dn}");
        }
        assert_eq!(normal_tail(u(38 * WAD)), U256::ZERO);
    }

    #[test]
    fn known_quote() {
        // S = 250, K = 275, 7 days, 60% vol: a typical weekly TSLA covered call.
        let (p, d) = quote(w(250.0), w(275.0), U256::from(7 * 86_400), w(0.6), true).unwrap();
        let (rp, rd) = ref_bs(250.0, 275.0, 7.0 * 86_400.0, 0.6, true);
        assert!((to_f(p) - rp).abs() < 1e-9, "call {} vs {}", to_f(p), rp);
        assert!((to_f(d.into_raw()) - rd).abs() < 1e-12);
    }

    #[test]
    fn strike_for_delta_hits_target() {
        for (call, target) in [(true, 0.20), (true, 0.35), (false, 0.20), (false, 0.10)] {
            let t = U256::from(7 * 86_400u64);
            let k = strike_for_delta(w(250.0), w(target), t, w(0.6), call).unwrap();
            let (_, d) = quote(w(250.0), k, t, w(0.6), call).unwrap();
            let abs = if d.is_negative() {
                to_f((-d).into_raw())
            } else {
                to_f(d.into_raw())
            };
            assert!((abs - target).abs() < 1e-9, "delta {abs} vs {target}");
            // OTM side: calls above spot, puts below.
            assert_eq!(k > w(250.0), call);
        }
    }

    #[test]
    fn strike_for_delta_rejects_bad_target() {
        let t = U256::from(86_400u64);
        assert_eq!(
            strike_for_delta(w(1.0), U256::ZERO, t, w(0.5), true),
            Err(ERR_DELTA)
        );
        assert_eq!(
            strike_for_delta(w(1.0), wad(), t, w(0.5), true),
            Err(ERR_DELTA)
        );
    }

    #[test]
    fn rejects_out_of_range() {
        let t = U256::from(86_400);
        assert_eq!(quote(U256::ZERO, w(1.0), t, w(0.5), true), Err(ERR_SPOT));
        assert_eq!(quote(w(1.0), U256::ZERO, t, w(0.5), true), Err(ERR_STRIKE));
        assert_eq!(
            quote(w(1.0), w(1.0), U256::ZERO, w(0.5), true),
            Err(ERR_TIME)
        );
        assert_eq!(
            quote(w(1.0), w(1.0), U256::from(MAX_TIME + 1), w(0.5), true),
            Err(ERR_TIME)
        );
        assert_eq!(quote(w(1.0), w(1.0), t, w(0.001), true), Err(ERR_VOL));
        assert_eq!(quote(w(1.0), w(1.0), t, w(6.0), true), Err(ERR_VOL));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// Accuracy against closed-form Black-Scholes, relative to spot.
        #[test]
        fn matches_closed_form(
            s in 1.0f64..5000.0,
            moneyness in 0.5f64..1.5,
            t in 3600u64..(60 * 86_400),
            v in 0.05f64..2.0,
            call: bool,
        ) {
            let k = s * moneyness;
            let (p, d) = quote(w(s), w(k), U256::from(t), w(v), call).unwrap();
            let (rp, rd) = ref_bs(s, k, t as f64, v, call);
            prop_assert!((to_f(p) - rp).abs() / s < 1e-9, "price {} vs {}", to_f(p), rp);
            let delta = if d.is_negative() { -to_f((-d).into_raw()) } else { to_f(d.into_raw()) };
            prop_assert!((delta - rd).abs() < 1e-9, "delta {} vs {}", delta, rd);
        }

        /// Put-call parity with r = 0: C - P = S - K, up to a few wei of rounding.
        #[test]
        fn put_call_parity(
            s in 1u128..5000,
            k in 1u128..5000,
            t in 60u64..(365 * 86_400),
            v in 1u128..300,
        ) {
            let (s, k, v) = (u(s * WAD), u(k * WAD), u(v * WAD / 100));
            let (c, _) = quote(s, k, U256::from(t), v, true).unwrap();
            let (p, _) = quote(s, k, U256::from(t), v, false).unwrap();
            let lhs = I256::from_raw(c) - I256::from_raw(p);
            let rhs = I256::from_raw(s) - I256::from_raw(k);
            // Tolerance: the CDF error (~1e-15) scaled by the larger of S and K.
            let tol = I256::from_raw((if s > k { s } else { k }) / u(100_000_000_000_000));
            prop_assert!((lhs - rhs).abs() <= tol, "C-P {} vs S-K {}", lhs, rhs);
        }

        /// Premium is never below intrinsic value (minus rounding) and never above the cap
        /// (S for a call, K for a put).
        #[test]
        fn bounded(
            s in 1u128..5000,
            k in 1u128..5000,
            t in 60u64..(365 * 86_400),
            v in 1u128..300,
            call: bool,
        ) {
            let (s, k, v) = (u(s * WAD), u(k * WAD), u(v * WAD / 100));
            let (p, _) = quote(s, k, U256::from(t), v, call).unwrap();
            let cap = if call { s } else { k };
            prop_assert!(p <= cap);
            let intrinsic = if call { s.saturating_sub(k) } else { k.saturating_sub(s) };
            let tol = cap / u(100_000_000_000_000);
            prop_assert!(p + tol >= intrinsic);
        }

        /// Call delta lies in [0, 1], put delta in [-1, 0].
        #[test]
        fn delta_range(
            s in 1u128..5000,
            k in 1u128..5000,
            t in 60u64..(365 * 86_400),
            v in 1u128..300,
        ) {
            let (s, k, v) = (u(s * WAD), u(k * WAD), u(v * WAD / 100));
            let (_, dc) = quote(s, k, U256::from(t), v, true).unwrap();
            let (_, dp) = quote(s, k, U256::from(t), v, false).unwrap();
            prop_assert!(!dc.is_negative() && dc.into_raw() <= wad());
            prop_assert!(!dp.is_positive() && (-dp).into_raw() <= wad());
            prop_assert_eq!(dc - dp, I256::from_raw(wad()));
        }
    }
}
