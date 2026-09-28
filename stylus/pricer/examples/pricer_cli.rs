//! Command-line wrapper around the pricer math, used by the Foundry differential tests via FFI.
//!
//! Usage: pricer_cli <spot> <strike> <timeToExpiry> <sigma> <isCall: 0|1>
//! Prints the ABI encoding of (bool ok, uint256 price, int256 delta, uint8 errorCode) as 0x-hex.

use alloy_primitives::{I256, U256};
use strike_pricer::math;

fn word(x: U256) -> String {
    format!("{:064x}", x)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        5,
        "usage: pricer_cli <spot> <strike> <time> <sigma> <isCall>"
    );
    let parse = |s: &str| {
        U256::from_str_radix(
            s.trim_start_matches("0x"),
            if s.starts_with("0x") { 16 } else { 10 },
        )
        .unwrap()
    };
    let is_call = args[4] == "1" || args[4] == "true";
    let out = match math::quote(
        parse(&args[0]),
        parse(&args[1]),
        parse(&args[2]),
        parse(&args[3]),
        is_call,
    ) {
        Ok((p, d)) => [
            word(U256::from(1)),
            word(p),
            word(d.into_raw()),
            word(U256::ZERO),
        ]
        .concat(),
        Err(code) => [
            word(U256::ZERO),
            word(U256::ZERO),
            word(I256::ZERO.into_raw()),
            word(U256::from(code)),
        ]
        .concat(),
    };
    print!("0x{out}");
}
