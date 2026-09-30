//! Strike pricer: a Black-Scholes quote engine deployed as an Arbitrum Stylus contract.
//!
//! ABI (Solidity view):
//!   quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
//!       returns (uint256 price, int256 delta)
//!   price(...) returns (uint256)
//!   delta(...) returns (int256)
//!   strikeForDelta(uint256 spot, uint256 targetDelta, uint256 timeToExpiry, uint256 sigma, bool isCall)
//!       returns (uint256 strike)
//!
//! Risk engine ([`risk`]):
//!   greeks(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
//!       returns (int256 delta, uint256 gamma, uint256 vega, int256 theta)
//!   impliedVol(uint256 price, uint256 spot, uint256 strike, uint256 timeToExpiry, bool isCall)
//!       returns (uint256 sigma)
//!   scenarioLoss(bool isCall, uint256 strike, uint256 sold, uint256 spot, int256[] shocks)
//!       returns (uint256 worst, uint256[] losses)
//!
//! Units: spot, strike and price are USD per token with 18 decimals; sigma is annualised
//! volatility with 18 decimals; timeToExpiry is in seconds. The math lives in [`math`] and is
//! mirrored exactly by `contracts/src/pricing/BlackScholesLib.sol`.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

pub mod math;
pub mod risk;

use alloc::vec::Vec;
use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{I256, U256},
    prelude::*,
};

sol! {
    /// Raised when an input is outside the supported range.
    /// which: 1 = spot, 2 = strike, 3 = time to expiry, 4 = volatility, 5 = target delta,
    /// 6 = option price outside no-arbitrage bounds, 7 = implied volatility outside [5%, 500%], 8 = spot shock.
    error PricerInputOutOfRange(uint8 which);
}

#[derive(SolidityError)]
pub enum PricerError {
    PricerInputOutOfRange(PricerInputOutOfRange),
}

impl From<u8> for PricerError {
    fn from(which: u8) -> Self {
        PricerError::PricerInputOutOfRange(PricerInputOutOfRange { which })
    }
}

sol_storage! {
    #[entrypoint]
    pub struct StylusPricer {}
}

#[public]
impl StylusPricer {
    /// Premium (USD per token, WAD) and delta (WAD, negative for puts).
    pub fn quote(
        &self,
        spot: U256,
        strike: U256,
        time_to_expiry: U256,
        sigma: U256,
        is_call: bool,
    ) -> Result<(U256, I256), PricerError> {
        Ok(math::quote(spot, strike, time_to_expiry, sigma, is_call)?)
    }

    /// Premium only.
    pub fn price(
        &self,
        spot: U256,
        strike: U256,
        time_to_expiry: U256,
        sigma: U256,
        is_call: bool,
    ) -> Result<U256, PricerError> {
        Ok(math::quote(spot, strike, time_to_expiry, sigma, is_call)?.0)
    }

    /// Strike whose |delta| equals `target_delta` (WAD), by 48 rounds of bisection.
    /// This is where Stylus pays off: ~48 Black-Scholes evaluations in one call.
    pub fn strike_for_delta(
        &self,
        spot: U256,
        target_delta: U256,
        time_to_expiry: U256,
        sigma: U256,
        is_call: bool,
    ) -> Result<U256, PricerError> {
        Ok(math::strike_for_delta(
            spot,
            target_delta,
            time_to_expiry,
            sigma,
            is_call,
        )?)
    }

    /// Delta only.
    pub fn delta(
        &self,
        spot: U256,
        strike: U256,
        time_to_expiry: U256,
        sigma: U256,
        is_call: bool,
    ) -> Result<I256, PricerError> {
        Ok(math::quote(spot, strike, time_to_expiry, sigma, is_call)?.1)
    }

    /// Delta, gamma (per $1 of spot), vega (per 1.00 of volatility) and theta (per day), all WAD per option.
    pub fn greeks(
        &self,
        spot: U256,
        strike: U256,
        time_to_expiry: U256,
        sigma: U256,
        is_call: bool,
    ) -> Result<(I256, U256, U256, I256), PricerError> {
        let g = risk::greeks(spot, strike, time_to_expiry, sigma, is_call)?;
        Ok((g.delta, g.gamma, g.vega, g.theta))
    }

    /// Volatility (WAD, in [5%, 500%]) at which the premium equals `price`: Newton's method with a bisection
    /// fallback, several Black-Scholes evaluations in one call.
    pub fn implied_vol(
        &self,
        price: U256,
        spot: U256,
        strike: U256,
        time_to_expiry: U256,
        is_call: bool,
    ) -> Result<U256, PricerError> {
        Ok(risk::implied_vol(
            price,
            spot,
            strike,
            time_to_expiry,
            is_call,
        )?)
    }

    /// The vault's payout (USD, WAD) on `sold` options (WAD) at each spot shock (WAD, -0.3e18 = -30%), and the
    /// worst of them.
    pub fn scenario_loss(
        &self,
        is_call: bool,
        strike: U256,
        sold: U256,
        spot: U256,
        shocks: Vec<I256>,
    ) -> Result<(U256, Vec<U256>), PricerError> {
        Ok(risk::scenario_loss(is_call, strike, sold, spot, &shocks)?)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::testing::*;

    const WAD: u128 = math::WAD;

    #[test]
    fn contract_quotes_match_math() {
        let vm = TestVM::default();
        let pricer = StylusPricer::from(&vm);
        let args = (
            U256::from(250 * WAD),
            U256::from(275 * WAD),
            U256::from(7 * 86_400u64),
            U256::from(WAD * 6 / 10),
        );
        let (p, d) = pricer
            .quote(args.0, args.1, args.2, args.3, true)
            .ok()
            .unwrap();
        assert_eq!(
            pricer
                .price(args.0, args.1, args.2, args.3, true)
                .ok()
                .unwrap(),
            p
        );
        assert_eq!(
            pricer
                .delta(args.0, args.1, args.2, args.3, true)
                .ok()
                .unwrap(),
            d
        );
        assert!(p > U256::ZERO);
    }

    #[test]
    fn contract_risk_matches_math() {
        let vm = TestVM::default();
        let pricer = StylusPricer::from(&vm);
        let (s, k, t, v) = (
            U256::from(250 * WAD),
            U256::from(275 * WAD),
            U256::from(7 * 86_400u64),
            U256::from(WAD * 6 / 10),
        );
        let g = risk::greeks(s, k, t, v, true).unwrap();
        assert_eq!(
            pricer.greeks(s, k, t, v, true).ok().unwrap(),
            (g.delta, g.gamma, g.vega, g.theta)
        );
        let p = pricer.price(s, k, t, v, true).ok().unwrap();
        let iv = pricer.implied_vol(p, s, k, t, true).ok().unwrap();
        assert_eq!(iv, risk::implied_vol(p, s, k, t, true).unwrap());
        let shocks = vec![
            I256::try_from(-300_000_000_000_000_000i128).unwrap(),
            I256::ZERO,
        ];
        let (worst, losses) = pricer
            .scenario_loss(false, k, U256::from(WAD), s, shocks.clone())
            .ok()
            .unwrap();
        assert_eq!(
            (worst, losses),
            risk::scenario_loss(false, k, U256::from(WAD), s, &shocks).unwrap()
        );
        assert!(matches!(
            pricer.implied_vol(U256::ZERO, s, k, t, true),
            Err(PricerError::PricerInputOutOfRange(PricerInputOutOfRange {
                which: 6
            }))
        ));
    }

    #[test]
    fn contract_reverts_on_bad_input() {
        let vm = TestVM::default();
        let pricer = StylusPricer::from(&vm);
        let r = pricer.quote(
            U256::ZERO,
            U256::from(WAD),
            U256::from(60u64),
            U256::from(WAD / 2),
            true,
        );
        assert!(matches!(
            r,
            Err(PricerError::PricerInputOutOfRange(PricerInputOutOfRange {
                which: 1
            }))
        ));
    }
}
