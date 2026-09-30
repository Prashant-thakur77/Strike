//! Command-line wrapper around the pricer math, used by the Foundry differential tests via FFI.
//!
//! Usage: pricer_cli <spot> <strike> <timeToExpiry> <sigma> <isCall: 0|1>
//! Prints the ABI encoding of (bool ok, uint256 price, int256 delta, uint8 errorCode) as 0x-hex.
//!
//! Other commands (same 0x-hex ABI output, `ok = false` and the error code on rejection):
//!   strike   <spot> <targetDelta> <time> <sigma> <isCall>  → (bool ok, uint256 strike, uint8 code)
//!   greeks   <spot> <strike> <time> <sigma> <isCall>       → (bool ok, int256 delta, uint256 gamma, uint256 vega,
//!                                                              int256 theta, uint8 code)
//!   iv       <price> <spot> <strike> <time> <isCall>       → (bool ok, uint256 sigma, uint8 code)
//!   scenario <isCall> <strike> <sold> <spot> <shocks>      → (bool ok, uint256 worst, uint256[] losses, uint8 code)
//!            shocks: comma-separated signed WAD values, e.g. -300000000000000000,0,300000000000000000

use alloy_primitives::{I256, U256};
use alloy_sol_types::SolValue;
use strike_pricer::{math, risk};

fn risk_command(cmd: &str, args: &[String]) -> Option<Vec<u8>> {
    let n = |s: &str| U256::from_str_radix(s, 10).unwrap();
    let b = |s: &str| s == "1" || s == "true";
    // The error code as a full word: `u8` is not a `SolValue`, and a uint8 decodes from the same word.
    let code = |c: u8| U256::from(c);
    let zero = U256::ZERO;
    Some(match cmd {
        "greeks" => match risk::greeks(
            n(&args[0]),
            n(&args[1]),
            n(&args[2]),
            n(&args[3]),
            b(&args[4]),
        ) {
            Ok(g) => (true, g.delta, g.gamma, g.vega, g.theta, zero).abi_encode_params(),
            Err(c) => (false, I256::ZERO, zero, zero, I256::ZERO, code(c)).abi_encode_params(),
        },
        "iv" => match risk::implied_vol(
            n(&args[0]),
            n(&args[1]),
            n(&args[2]),
            n(&args[3]),
            b(&args[4]),
        ) {
            Ok(v) => (true, v, zero).abi_encode_params(),
            Err(c) => (false, zero, code(c)).abi_encode_params(),
        },
        "scenario" => {
            let shocks: Vec<I256> = args[4]
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| I256::from_dec_str(s).unwrap())
                .collect();
            match risk::scenario_loss(b(&args[0]), n(&args[1]), n(&args[2]), n(&args[3]), &shocks) {
                Ok((worst, losses)) => (true, worst, losses, zero).abi_encode_params(),
                Err(c) => (false, zero, Vec::<U256>::new(), code(c)).abi_encode_params(),
            }
        }
        _ => return None,
    })
}

fn word(x: U256) -> String {
    format!("{:064x}", x)
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(out) = args.first().and_then(|c| risk_command(c, &args[1..])) {
        print!("0x{}", alloy_primitives::hex::encode(out));
        return;
    }
    // `pricer_cli strike <spot> <targetDelta> <time> <sigma> <isCall>` prints (bool ok, uint256 strike, uint8 code).
    if args.first().map(String::as_str) == Some("strike") {
        args.remove(0);
        let parse = |s: &str| U256::from_str_radix(s, 10).unwrap();
        let is_call = args[4] == "1" || args[4] == "true";
        let out = match math::strike_for_delta(
            parse(&args[0]),
            parse(&args[1]),
            parse(&args[2]),
            parse(&args[3]),
            is_call,
        ) {
            Ok(k) => [word(U256::from(1)), word(k), word(U256::ZERO)].concat(),
            Err(code) => [word(U256::ZERO), word(U256::ZERO), word(U256::from(code))].concat(),
        };
        print!("0x{out}");
        return;
    }
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
