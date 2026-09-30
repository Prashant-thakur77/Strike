//! Writes `contracts/test/vectors/pricer.json` and `risk.json`: inputs and exact outputs of the Rust pricer and
//! risk engine. The Solidity reference must reproduce every value exactly (see `BlackScholesVectors.t.sol` and
//! `RiskVectors.t.sol`); `research/risk_reference.py --check` compares the risk vectors with mpmath.
//!
//! Usage: cargo run --release --example gen_vectors -- <pricer.json path> [<risk.json path>]
//! (the risk vectors go next to pricer.json when the second path is omitted)

use alloy_primitives::{I256, U256};
use strike_pricer::math::{self, WAD};
use strike_pricer::risk;

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

fn q(x: impl core::fmt::Display) -> String {
    format!("\"{x}\"")
}

fn field(name: &str, values: &[String]) -> String {
    format!("\"{name}\": [{}]", values.join(","))
}

fn object(fields: &[(&str, &Vec<String>)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(n, v)| format!("    {}", field(n, v)))
        .collect();
    format!("{{\n{}\n  }}", body.join(",\n"))
}

/// Greeks, implied-vol and scenario vectors. Their own generator seed, so pricer.json does not change.
fn risk_vectors(out: &str) {
    let mut rng = Lcg(0x5249_534b);
    let mut g: [Vec<String>; 9] = Default::default();
    for i in 0..200 {
        let s = rng.range(WAD, 2000 * WAD);
        let k = s * rng.range(50, 150) / 100 + rng.range(0, WAD / 100);
        let t = rng.range(60, 90 * 86_400);
        let v = rng.range(WAD / 20, 2 * WAD);
        let c = i % 2 == 0;
        let r = risk::greeks(
            U256::from(s),
            U256::from(k),
            U256::from(t),
            U256::from(v),
            c,
        )
        .unwrap();
        for (col, x) in g.iter_mut().zip([
            q(s),
            q(k),
            q(t),
            q(v),
            c.to_string(),
            q(r.delta),
            q(r.gamma),
            q(r.vega),
            q(r.theta),
        ]) {
            col.push(x);
        }
    }

    // Implied vol: premiums the pricer produced at a known sigma, 5% to 300%, 1 hour to 90 days.
    let mut iv: [Vec<String>; 7] = Default::default();
    while iv[0].len() < 150 {
        let n = iv[0].len();
        let s = rng.range(WAD, 2000 * WAD);
        let k = s * rng.range(70, 130) / 100;
        let t = rng.range(3600, 90 * 86_400);
        let v = rng.range(WAD / 20, 3 * WAD);
        let c = n.is_multiple_of(2);
        let (su, ku, tu) = (U256::from(s), U256::from(k), U256::from(t));
        let (p, _) = math::quote(su, ku, tu, U256::from(v), c).unwrap();
        let Ok(sigma) = risk::implied_vol(p, su, ku, tu, c) else {
            continue; // premium at intrinsic value or cap: no information about sigma
        };
        for (col, x) in iv
            .iter_mut()
            .zip([q(p), q(s), q(k), q(t), c.to_string(), q(sigma), q(v)])
        {
            col.push(x);
        }
    }

    // Scenario loss on the default grid: -30% to +30% in 5% steps.
    let shocks: Vec<I256> = (-6i128..=6)
        .map(|j| I256::try_from(j * 50_000_000_000_000_000).unwrap())
        .collect();
    let mut sc: [Vec<String>; 6] = Default::default();
    for i in 0..60 {
        let s = rng.range(WAD, 2000 * WAD);
        let k = s * rng.range(70, 130) / 100;
        let sold = rng.range(0, 1_000_000 * WAD);
        let c = i % 2 == 0;
        let (worst, losses) =
            risk::scenario_loss(c, U256::from(k), U256::from(sold), U256::from(s), &shocks)
                .unwrap();
        for (col, x) in sc
            .iter_mut()
            .zip([c.to_string(), q(k), q(sold), q(s), q(worst)])
        {
            col.push(x);
        }
        sc[5].extend(losses.iter().map(q));
    }
    let shock_strings: Vec<String> = shocks.iter().map(q).collect();

    let json = format!(
        "{{\n  \"greeks\": {},\n  \"impliedVol\": {},\n  \"scenario\": {}\n}}\n",
        object(&[
            ("spot", &g[0]),
            ("strike", &g[1]),
            ("time", &g[2]),
            ("sigma", &g[3]),
            ("isCall", &g[4]),
            ("delta", &g[5]),
            ("gamma", &g[6]),
            ("vega", &g[7]),
            ("theta", &g[8]),
        ]),
        object(&[
            ("price", &iv[0]),
            ("spot", &iv[1]),
            ("strike", &iv[2]),
            ("time", &iv[3]),
            ("isCall", &iv[4]),
            ("iv", &iv[5]),
            ("sourceSigma", &iv[6]),
        ]),
        object(&[
            ("shocks", &shock_strings),
            ("isCall", &sc[0]),
            ("strike", &sc[1]),
            ("sold", &sc[2]),
            ("spot", &sc[3]),
            ("worst", &sc[4]),
            ("losses", &sc[5]),
        ]),
    );
    std::fs::write(out, json).expect("write risk vectors");
    println!("wrote 200 greeks, 150 implied-vol and 60 scenario vectors to {out}");
}

fn main() {
    let out = std::env::args().nth(1).expect("output path");
    let risk_out = std::env::args().nth(2).unwrap_or_else(|| {
        std::path::Path::new(&out)
            .with_file_name("risk.json")
            .to_string_lossy()
            .into_owned()
    });
    risk_vectors(&risk_out);
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
