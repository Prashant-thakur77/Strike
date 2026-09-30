#!/usr/bin/env python3
"""High-precision reference for the Strike risk engine (stylus/pricer/src/risk.rs, contracts/src/pricing/RiskLib.sol).

Black-Scholes with r = 0 and a 365-day year, evaluated with mpmath at 50 significant digits:

    python3 research/risk_reference.py                       # print the reference cases used by the Rust unit tests
    python3 research/risk_reference.py --check contracts/test/vectors/risk.json

`--check` compares every vector the Rust engine generated (gen_vectors) against the exact values and fails on a
difference above the documented tolerance:

    delta               |err| <= 1e-12
    gamma               |err| <= 1e-12 × 1 / (S σ √T)        (its at-the-money scale)
    vega                |err| <= 1e-12 × S
    theta (per day)     |err| <= 1e-12 × S σ / √T / 365
    implied vol         the fixed-point engine's own premium at the returned sigma matches the vector's premium
                        (checked in Rust and Solidity); here: |σ − σ_exact| <= 1e-9 whenever vega >= 1e-6 × S,
                        where σ_exact solves the exact (mpmath) premium equation for the same premium
    scenario loss       |err| <= 1e-15 × sold × S' + 3 wei (floor rounding of three WAD operations)

The fixed-point engine uses the Hart/West normal CDF (absolute error ~1e-15), so these bounds leave a margin of
about 1,000× over the engine's actual error.
"""

import json
import sys

from mpmath import erfc, exp, log, mp, mpf, pi, sqrt

mp.dps = 50
YEAR = mpf(31_536_000)
WAD = mpf(10) ** 18


def cdf(x):
    return erfc(-x / sqrt(2)) / 2


def pdf(x):
    return exp(-x * x / 2) / sqrt(2 * pi)


def d1(s, k, t_sec, v):
    t = t_sec / YEAR
    return (log(s / k) + v * v * t / 2) / (v * sqrt(t)), t


def price(s, k, t_sec, v, call):
    d, t = d1(s, k, t_sec, v)
    d2 = d - v * sqrt(t)
    return s * cdf(d) - k * cdf(d2) if call else k * cdf(-d2) - s * cdf(-d)


def greeks(s, k, t_sec, v, call):
    d, t = d1(s, k, t_sec, v)
    phi = pdf(d)
    delta = cdf(d) if call else cdf(d) - 1
    gamma = phi / (s * v * sqrt(t))
    vega = s * phi * sqrt(t)
    theta = -s * phi * v / (2 * sqrt(t)) / 365
    return delta, gamma, vega, theta


def implied_vol(p, s, k, t_sec, call):
    """Bisection on [0.001, 10]: the premium rises with sigma, and 200 halvings reach 50 digits."""
    lo, hi = mpf("0.001"), mpf(10)
    for _ in range(200):
        mid = (lo + hi) / 2
        if price(s, k, t_sec, mid, call) > p:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def scenario(call, k, sold, s, shock):
    s2 = s * (1 + shock)
    if call:
        return sold * (s2 - k) if s2 > k else mpf(0)
    return sold * (k - s2) if k > s2 else mpf(0)


def w(x):
    return mpf(int(x)) / WAD


def print_cases():
    s, k, t, v = mpf(250), mpf(275), mpf(7 * 86_400), mpf("0.6")
    for call in (True, False):
        d, g, vg, th = greeks(s, k, t, v, call)
        p = price(s, k, t, v, call)
        side = "call" if call else "put"
        print(f"S 250 K 275 7d 60% {side}")
        print(f"  price  {mp.nstr(p, 20)}  (wei, floor: {int(p * WAD)})")
        print(f"  delta  {mp.nstr(d, 20)}")
        print(f"  gamma  {mp.nstr(g, 20)}")
        print(f"  vega   {mp.nstr(vg, 20)}")
        print(f"  theta  {mp.nstr(th, 20)}  (per day)")
        print(f"  implied vol of that price: {mp.nstr(implied_vol(p, s, k, t, call), 20)}")
    print("10 calls K 110, spot 100, +20%:", mp.nstr(scenario(True, mpf(110), mpf(10), mpf(100), mpf("0.2")), 20))
    print("10 puts K 90, spot 100, -20%:", mp.nstr(scenario(False, mpf(90), mpf(10), mpf(100), mpf("-0.2")), 20))


def check(path):
    data = json.load(open(path))
    worst = {"delta": 0, "gamma": 0, "vega": 0, "theta": 0, "iv": 0, "scenario": 0}

    def ok(name, err, tol, i):
        rel = err / tol if tol else 0
        worst[name] = max(worst[name], float(rel))
        if err > tol:
            sys.exit(f"{name} vector {i}: error {mp.nstr(err, 5)} above tolerance {mp.nstr(tol, 5)}")

    g = data["greeks"]
    for i in range(len(g["spot"])):
        s, k, t, v = w(g["spot"][i]), w(g["strike"][i]), mpf(int(g["time"][i])), w(g["sigma"][i])
        call = g["isCall"][i]
        d, gm, vg, th = greeks(s, k, t, v, call)
        sq = sqrt(t / YEAR)
        ok("delta", abs(w(g["delta"][i]) - d), mpf("1e-12"), i)
        ok("gamma", abs(w(g["gamma"][i]) - gm), mpf("1e-12") / (s * v * sq), i)
        ok("vega", abs(w(g["vega"][i]) - vg), mpf("1e-12") * s, i)
        ok("theta", abs(w(g["theta"][i]) - th), mpf("1e-12") * s * v / sq / 365, i)

    iv = data["impliedVol"]
    for i in range(len(iv["spot"])):
        p, s, k, t = w(iv["price"][i]), w(iv["spot"][i]), w(iv["strike"][i]), mpf(int(iv["time"][i]))
        call = iv["isCall"][i]
        exact = implied_vol(p, s, k, t, call)
        vega = greeks(s, k, t, exact, call)[2]
        if vega >= mpf("1e-6") * s:
            ok("iv", abs(w(iv["iv"][i]) - exact), mpf("1e-9"), i)

    sc = data["scenario"]
    shocks = [w(x) for x in sc["shocks"]]
    n = len(shocks)
    for i in range(len(sc["spot"])):
        call, k, sold, s = sc["isCall"][i], w(sc["strike"][i]), w(sc["sold"][i]), w(sc["spot"][i])
        for j, shock in enumerate(shocks):
            got = w(sc["losses"][i * n + j])
            want = scenario(call, k, sold, s, shock)
            ok("scenario", abs(got - want), mpf("1e-15") * sold * s * (1 + shock) + 3 / WAD, i)

    counts = (len(g["spot"]), len(iv["spot"]), len(sc["spot"]))
    print(f"{counts[0]} greeks, {counts[1]} implied-vol and {counts[2]} scenario vectors within tolerance")
    print("largest error as a fraction of its tolerance:", {k: f"{v:.2e}" for k, v in worst.items()})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        check(sys.argv[2])
    else:
        print_cases()
