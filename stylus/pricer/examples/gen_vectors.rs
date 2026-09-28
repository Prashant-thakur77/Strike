//! Writes `contracts/test/vectors/pricer.json`: inputs and exact outputs of the Rust pricer.
//! The Solidity reference must reproduce every value exactly (see `BlackScholesVectors.t.sol`).
//!
//! Usage: cargo run --release --example gen_vectors -- <output path>

use alloy_primitives::U256;
use strike_pricer::math::{self, WAD};

/// Small deterministic generator so the vectors are reproducible.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn range(&mut self, lo: u128, hi: u128) -> u128 {
        let wide = ((self.next() as u128) << 53) | self.next() as u128;
        lo + wide % (hi - lo)
    }
}

fn main() {
    let out = std::env::args().nth(1).expect("output path");
    let mut rng = Lcg(0x5741_4b45);
    let (mut spot, mut strike, mut time, mut sigma, mut call, mut price, mut delta) =
        (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
    for i in 0..300 {
        // Spot $1..$2000 with 6 decimals of cents noise; strike 50%..150% of spot.
        let s = rng.range(WAD, 2000 * WAD);
        let k = s * rng.range(50, 150) / 100 + rng.range(0, WAD / 100);
        let t = rng.range(60, 90 * 86_400);
        let v = rng.range(WAD / 20, 2 * WAD);
        let c = i % 2 == 0;
        let (p, d) = math::quote(
            U256::from(s),
            U256::from(k),
            U256::from(t),
            U256::from(v),
            c,
        )
        .unwrap();
        spot.push(format!("\"{s}\""));
        strike.push(format!("\"{k}\""));
        time.push(format!("\"{t}\""));
        sigma.push(format!("\"{v}\""));
        call.push(c.to_string());
        price.push(format!("\"{p}\""));
        delta.push(format!("\"{d}\""));
    }
    let json = format!(
        "{{\n  \"spot\": [{}],\n  \"strike\": [{}],\n  \"time\": [{}],\n  \"sigma\": [{}],\n  \"isCall\": [{}],\n  \"price\": [{}],\n  \"delta\": [{}]\n}}\n",
        spot.join(","),
        strike.join(","),
        time.join(","),
        sigma.join(","),
        call.join(","),
        price.join(","),
        delta.join(",")
    );
    std::fs::write(&out, json).expect("write vectors");
    println!("wrote 300 vectors to {out}");
}
