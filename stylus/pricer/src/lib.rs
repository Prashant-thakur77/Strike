//! Strike pricer: a Black-Scholes quote engine deployed as an Arbitrum Stylus contract.
//!
//! ABI (Solidity view):
//!   quote(uint256 spot, uint256 strike, uint256 timeToExpiry, uint256 sigma, bool isCall)
//!       returns (uint256 price, int256 delta)
//!   price(...) returns (uint256)
//!   delta(...) returns (int256)
//!
//! Units: spot, strike and price are USD per token with 18 decimals; sigma is annualised
//! volatility with 18 decimals; timeToExpiry is in seconds. The math lives in [`math`] and is
//! mirrored exactly by `contracts/src/pricing/BlackScholesLib.sol`.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

pub mod math;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{I256, U256},
    prelude::*,
};

sol! {
    /// Raised when an input is outside the supported range.
    /// which: 1 = spot, 2 = strike, 3 = time to expiry, 4 = volatility.
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
