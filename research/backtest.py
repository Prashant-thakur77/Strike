"""Historical backtest of Strike's weekly covered-call and cash-secured-put vaults.

Reproduce:  python3 research/backtest.py
Outputs:    research/results/*.csv, research/results/tables.md, research/charts/*.png

The simulation follows the contracts (docs/design.md, EpochManager, MandateGuard, FeeManager):

* One epoch per NYSE week. The vault opens at the close of the week's first trading day and the
  option expires at the close of the week's last trading day (Friday, or Thursday when Friday is a
  holiday, as `MarketCalendar.weeklyExpiry`). Tenor = calendar days between the two closes x 86,400 s.
* Strike = `strikeForDelta(spot, target, tenor, sigma)`: 48 bisection rounds over [S/10, 10 S],
  then rounded down to a whole cent (`EpochManager.proposeByDelta`). The strike is solved at today's
  token price and applied as moneyness (Black-Scholes is scale-invariant), so the cent rounding has
  its real size rather than its size on back-adjusted early prices.
* Premium per option = Black-Scholes fair value (r = 0, 365-day year) x premiumBps.
* Size = capacity x maxShareSoldBps (80%). Capacity is one token per call, collateral / K per put.
* Settlement at the expiry close. Calls pay (S-K)/S tokens per option, puts pay K-S USDG per option.
* pnl = premium - payoutValue; fee = 10% of pnl when pnl > 0 (half to the agent, half to treasury);
  depositors receive premium - fee in USDG.
* Premium is either held as USDG next to the collateral (what the vault does: an accumulator the
  depositor claims) or reinvested into collateral at the settlement price (a depositor who claims
  and re-deposits every week). Both are reported.

Assumptions that are not in the contracts are stated in docs/backtest.md: the vault sells its full
80% every week at the opening quote (no demand risk, no bid/ask), and implied volatility is
modelled as trailing realised volatility x a volatility-risk-premium factor.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"
CHARTS = ROOT / "charts"

TICKERS = ["TSLA", "NVDA", "AMZN", "SPY"]
START = pd.Timestamp("2019-01-01")
SECONDS_PER_YEAR = 31_536_000
VOL_WINDOW = 21  # trading days, about 30 calendar days
MAX_SHARE_SOLD = 0.80
PERF_FEE = 0.10
AGENT_SHARE = 0.50
# Pricer input bounds (stylus/pricer/src/math.rs).
MIN_VOL, MAX_VOL = 0.01, 5.0
# Demo mandate (contracts/script/Seed.s.sol).
MANDATE = dict(min_delta_bps=1000, max_delta_bps=3500, min_premium_bps=9500, min_yield_bps=5)

PERIODS = {
    "2020 crash": ("2020-02-14", "2020-03-20"),
    "2020 rebound": ("2020-03-20", "2020-12-31"),
    "2022 bear": ("2021-12-31", "2022-10-14"),
}


# --------------------------------------------------------------------------------------- pricer


def ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def bs_quote(s: float, k: float, t_sec: float, sigma: float, is_call: bool) -> tuple[float, float]:
    """Black-Scholes premium and delta, r = 0, T = seconds / 31,536,000 (same model as math.rs)."""
    t = t_sec / SECONDS_PER_YEAR
    vs = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + 0.5 * sigma * sigma * t) / vs
    d2 = d1 - vs
    if is_call:
        return max(s * ncdf(d1) - k * ncdf(d2), 0.0), ncdf(d1)
    return max(k * ncdf(-d2) - s * ncdf(-d1), 0.0), ncdf(d1) - 1.0


def strike_for_delta(s: float, target: float, t_sec: float, sigma: float, is_call: bool) -> float:
    """48 bisection rounds over [S/10, 10 S], as `strike_for_delta` in math.rs."""
    lo, hi = s / 10.0, s * 10.0
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        d = abs(bs_quote(s, mid, t_sec, sigma, is_call)[1])
        go_up = d > target if is_call else d < target
        if go_up:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def round_down_cent(k: float) -> float:
    # proposeByDelta: strike -= strike % 1e16 (WAD), i.e. floor to $0.01. The epsilon absorbs float noise.
    return math.floor(k * 100.0 + 1e-9) / 100.0


def cross_check() -> dict:
    """Compare the float pricer with the fixed-point Rust pricer's published outputs."""
    out = {}
    p, d = bs_quote(250.0, 275.0, 7 * 86_400, 0.6, True)
    out["known_quote"] = {"price": p, "delta": d, "rust_price": 1.360283237652240, "rust_delta": 0.1344687460128014}
    vec = json.loads((REPO / "contracts/test/vectors/pricer.json").read_text())
    rel_err, d_err = [], []
    for i in range(len(vec["spot"])):
        s = int(vec["spot"][i]) / 1e18
        k = int(vec["strike"][i]) / 1e18
        t = int(vec["time"][i])
        v = int(vec["sigma"][i]) / 1e18
        c = bool(vec["isCall"][i])
        fp, fd = bs_quote(s, k, t, v, c)
        rel_err.append(abs(fp - int(vec["price"][i]) / 1e18) / s)
        d_err.append(abs(fd - int(vec["delta"][i]) / 1e18))
    out["vectors"] = {"n": len(rel_err), "max_price_err_over_spot": max(rel_err), "max_delta_err": max(d_err)}
    # docs/risk-model.md example table (7-day, 0.20 delta) and docs/gas.md strike ($369, 60%, 4 days).
    rows = []
    for name, s, v, call in [("TSLA", 250, 0.60, True), ("TSLA", 250, 0.60, False), ("NVDA", 180, 0.50, True), ("SPY", 650, 0.18, True)]:
        k = strike_for_delta(s, 0.20, 7 * 86_400, v, call)
        prem = bs_quote(s, k, 7 * 86_400, v, call)[0]
        rows.append({"underlying": name, "vault": "call" if call else "put", "strike_vs_spot": k / s - 1, "yield": prem / (s if call else k)})
    out["risk_model_table"] = rows
    out["gas_md_strike"] = round_down_cent(strike_for_delta(369.0, 0.20, 4 * 86_400, 0.60, True))
    return out


# ----------------------------------------------------------------------------------------- data


def load_prices() -> dict[str, pd.Series]:
    px = {}
    for t in TICKERS + ["VIX"]:
        df = pd.read_csv(DATA / f"{t}.csv", parse_dates=["date"]).set_index("date")
        # Stock tokens carry dividends and splits in the ERC-8056 multiplier and the Chainlink price already
        # includes it, so the token behaves like a split- and dividend-adjusted price series.
        px[t] = df["adj_close"].astype(float) if t != "VIX" else df["close"].astype(float)
    return px


def weekly_schedule(dates: pd.DatetimeIndex) -> pd.DataFrame:
    iso = dates.isocalendar()
    g = pd.DataFrame({"date": dates, "yw": iso.year.values * 100 + iso.week.values})
    weeks = g.groupby("yw")["date"].agg(["first", "last"]).reset_index(drop=True)
    weeks.columns = ["open", "expiry"]
    weeks = weeks[weeks["expiry"] > weeks["open"]]  # need at least one day of tenor (minTenor = 1 day)
    # Drop the week still in progress at the end of the data.
    if dates[-1].weekday() < 4:
        weeks = weeks[weeks["expiry"] < dates[-1] - pd.Timedelta(days=dates[-1].weekday())]
    weeks = weeks[weeks["open"] >= START].reset_index(drop=True)
    weeks["tenor"] = (weeks["expiry"] - weeks["open"]).dt.days * 86_400
    return weeks


def trailing_vol(px: pd.Series) -> pd.Series:
    r = np.log(px).diff()
    return r.rolling(VOL_WINDOW).std(ddof=1) * math.sqrt(252)


# ------------------------------------------------------------------------------------ simulation


@dataclass(frozen=True)
class Config:
    delta: float = 0.20
    vrp: float = 1.15
    premium_bps: float = 1.00
    reinvest: bool = False
    vol_source: str = "realized"  # or "vix" (SPY only)
    sigma_floor: float = MIN_VOL  # 0.20 = the deploy script's admin lower bound


_strike_cache: dict = {}


def simulate(ticker: str, is_call: bool, cfg: Config, px: dict[str, pd.Series]) -> pd.DataFrame:
    s_all = px[ticker]
    vol = trailing_vol(s_all)
    weeks = weekly_schedule(s_all.index)
    s_ref = float(s_all.iloc[-1])
    held_units = 1.0 / s_all[weeks["open"].iloc[0]] if is_call else 1.0  # tokens (call) or USDG (put) collateral
    cash = 0.0  # USDG premium held
    recs = []
    nav0 = 1.0
    for w in weeks.itertuples():
        s0, s1 = s_all[w.open], s_all[w.expiry]
        if cfg.vol_source == "vix":
            sigma = px["VIX"].get(w.open, np.nan) / 100.0
        else:
            sigma = vol[w.open] * cfg.vrp
        sigma = min(max(sigma, cfg.sigma_floor, MIN_VOL), MAX_VOL)
        # Black-Scholes is scale-invariant, so the strike is solved at today's token price (s_ref) and applied as
        # moneyness to the historical spot. That keeps proposeByDelta's cent rounding at its real size; on
        # back-adjusted 2019 prices (NVDA about $4) it would be exaggerated.
        key = (ticker, is_call, cfg.delta, round(sigma, 12), w.tenor)
        if key not in _strike_cache:
            k_ref = round_down_cent(strike_for_delta(s_ref, cfg.delta, w.tenor, sigma, is_call))
            fair_ref, dlt = bs_quote(s_ref, k_ref, w.tenor, sigma, is_call)
            _strike_cache[key] = (k_ref / s_ref, fair_ref / s_ref, dlt)
        m, fair_m, dlt = _strike_cache[key]
        k, fair = m * s0, fair_m * s0
        prem_per = fair * cfg.premium_bps
        collateral_per = s0 if is_call else k

        # Mandate diagnostic (demo vault mandate), using the same integer rules as MandateGuard.check.
        abs_delta_bps = math.floor(abs(dlt) * 10_000 + 1e-12)
        reason = "None"
        if (is_call and k <= s0) or (not is_call and k >= s0):
            reason = "StrikeWrongSide"
        elif cfg.premium_bps * 10_000 < MANDATE["min_premium_bps"]:
            reason = "PremiumBelowFair"
        elif abs_delta_bps < MANDATE["min_delta_bps"] or abs_delta_bps > MANDATE["max_delta_bps"]:
            reason = "DeltaOutOfBand"
        elif prem_per < MANDATE["min_yield_bps"] / 10_000 * collateral_per:
            reason = "PremiumTooSmall"

        nav_open = held_units * s0 + cash if is_call else held_units + cash
        n = MAX_SHARE_SOLD * (held_units if is_call else held_units / k)
        premium = n * prem_per
        if is_call:
            itm = s1 > k
            payout_tokens = n * (s1 - k) / s1 if itm else 0.0
            payout_value = payout_tokens * s1
        else:
            itm = s1 < k
            payout_value = n * (k - s1) if itm else 0.0
        pnl = premium - payout_value
        fee = PERF_FEE * pnl if pnl > 0 else 0.0
        net_prem = premium - fee
        if is_call:
            held_units -= payout_tokens
            if cfg.reinvest:
                held_units += net_prem / s1
            else:
                cash += net_prem
            nav = held_units * s1 + cash
        else:
            held_units -= payout_value
            if cfg.reinvest:
                held_units += net_prem
            else:
                cash += net_prem
            nav = held_units + cash
        recs.append(
            dict(
                open=w.open, expiry=w.expiry, tenor_days=w.tenor / 86_400, spot=s0, settle=s1, sigma=sigma,
                strike=k, strike_vs_spot=k / s0 - 1, delta=dlt, fair=fair, premium_yield=prem_per / collateral_per,
                itm=itm, premium=premium, payout_value=payout_value, fee=fee, nav_open=nav_open, nav=nav,
                mandate=reason,
            )
        )
    df = pd.DataFrame(recs)
    df["ret"] = df["nav"] / df["nav"].shift(1, fill_value=nav0) - 1
    df["bh_nav"] = df["settle"] / df["spot"].iloc[0]
    df["bh_ret"] = df["bh_nav"] / df["bh_nav"].shift(1, fill_value=1.0) - 1
    return df


def curve(df: pd.DataFrame, col: str) -> pd.Series:
    s = pd.Series(df[col].values, index=df["expiry"])
    start = pd.Series([1.0], index=[df["open"].iloc[0]])
    return pd.concat([start, s])


def stats(nav: pd.Series) -> dict:
    r = nav.pct_change().dropna()
    years = (nav.index[-1] - nav.index[0]).days / 365.25
    cagr = (nav.iloc[-1] / nav.iloc[0]) ** (1 / years) - 1
    vol = r.std(ddof=1) * math.sqrt(52)
    sharpe = r.mean() * 52 / vol if vol > 0 else float("nan")
    dd = (nav / nav.cummax() - 1).min()
    return dict(cagr=cagr, vol=vol, sharpe=sharpe, max_dd=dd, worst_week=r.min(), total=nav.iloc[-1] / nav.iloc[0] - 1)


def period_return(nav: pd.Series, a: str, b: str) -> float:
    va = nav.asof(pd.Timestamp(a))
    vb = nav.asof(pd.Timestamp(b))
    return vb / va - 1


def summarise(ticker: str, is_call: bool, df: pd.DataFrame) -> dict:
    v = stats(curve(df, "nav"))
    b = stats(curve(df, "bh_nav"))
    row = dict(ticker=ticker, vault="covered call" if is_call else "cash-secured put", weeks=len(df))
    for k, val in v.items():
        row[k] = val
    for k, val in b.items():
        row["bh_" + k] = val
    row["assigned"] = df["itm"].mean()
    row["avg_premium_yield"] = df["premium_yield"].mean()
    row["avg_vault_yield"] = (df["premium"] / df["nav_open"]).mean()
    row["avg_strike_vs_spot"] = df["strike_vs_spot"].mean()
    row["avg_sigma"] = df["sigma"].mean()
    row["premium_total"] = df["premium"].sum()
    row["payout_total"] = df["payout_value"].sum()
    row["fees_total"] = df["fee"].sum()
    row["overlay_ratio"] = df["payout_value"].sum() / df["premium"].sum()
    nav, bh = curve(df, "nav"), curve(df, "bh_nav")
    for name, (a, bb) in PERIODS.items():
        row[f"{name}"] = period_return(nav, a, bb)
        row[f"{name} bh"] = period_return(bh, a, bb)
    row["mandate_rejects"] = (df["mandate"] != "None").sum()
    row["mandate_reasons"] = ",".join(sorted(set(df.loc[df["mandate"] != "None", "mandate"])))
    return row


# ------------------------------------------------------------------------------------------ vix


def vix_check(px: dict[str, pd.Series]) -> dict:
    spy = px["SPY"]
    r = np.log(spy).diff()
    trail = r.rolling(VOL_WINDOW).std(ddof=1) * math.sqrt(252)
    fwd = r[::-1].rolling(VOL_WINDOW).std(ddof=1)[::-1].shift(-1) * math.sqrt(252)  # next 21 trading days
    df = pd.DataFrame({"vix": px["VIX"] / 100.0, "trail": trail, "fwd": fwd}).dropna()
    df = df[df.index >= START]
    return dict(
        days=len(df),
        mean_vix=df["vix"].mean(),
        mean_trailing_rv=df["trail"].mean(),
        mean_forward_rv=df["fwd"].mean(),
        median_vix_over_trailing=(df["vix"] / df["trail"]).median(),
        median_vix_over_forward=(df["vix"] / df["fwd"]).median(),
        share_vix_above_forward=(df["vix"] > df["fwd"]).mean(),
        mean_vix_over_trailing=(df["vix"] / df["trail"]).mean(),
    )


# --------------------------------------------------------------------------------------- charts

INK, INK2, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#8a8984", "#e6e5e1", "#fcfcfb"
C_CALL, C_PUT, C_BH = "#2a78d6", "#eb6834", "#52514e"


def _style():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
            "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
            "text.color": INK, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
            "axes.spines.top": False, "axes.spines.right": False, "font.size": 10, "axes.titlesize": 12,
            "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
        }
    )
    return plt


def chart_equity(runs: dict, vrp: float, path: Path):
    plt = _style()
    from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter

    fig, axes = plt.subplots(2, 2, figsize=(12, 7.8), sharex=True)
    for ax, t in zip(axes.flat, TICKERS):
        call, put = runs[(t, True)], runs[(t, False)]
        series = [("Buy and hold", curve(call, "bh_nav"), C_BH), ("Covered call vault", curve(call, "nav"), C_CALL), ("Cash-secured put vault", curve(put, "nav"), C_PUT)]
        for name, s, c in series:
            ax.plot(s.index, s.values, color=c, lw=2 if name != "Buy and hold" else 1.6, label=name)
            ax.annotate(f"{s.iloc[-1]:.2f}x", (s.index[-1], s.iloc[-1]), xytext=(4, 0), textcoords="offset points",
                        va="center", fontsize=9, color=INK2)
        ax.set_yscale("log")
        ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
        ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}x"))
        ax.yaxis.set_minor_formatter(NullFormatter())
        ax.set_title(t)
        ax.margins(x=0.08)
    h, l = axes[0, 0].get_legend_handles_labels()
    fig.legend(h, l, loc="upper left", bbox_to_anchor=(0.01, 0.945), ncol=3, fontsize=10)
    fig.suptitle(f"Growth of $1: weekly 0.20-delta vaults vs buy and hold (IV = trailing realised vol x {vrp:.2f}, premium held in USDG)",
                 x=0.01, ha="left", fontsize=12, color=INK)
    fig.text(0.01, 0.005, "Log scale. Values at weekly settlement closes, Jan 2019 to Sep 2026. Data: Yahoo Finance daily adjusted closes. Code: research/backtest.py.",
             fontsize=8.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.02, 1, 0.91))
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_yield_dist(runs: dict, path: Path):
    plt = _style()
    fig, axes = plt.subplots(1, 4, figsize=(13, 4.2), sharey=False)
    for ax, t in zip(axes, TICKERS):
        yc = runs[(t, True)]["premium_yield"] * 100
        yp = runs[(t, False)]["premium_yield"] * 100
        hi = np.percentile(np.concatenate([yc, yp]), 99.5)
        bins = np.linspace(0, hi, 30)
        ax.hist(yc, bins=bins, histtype="step", lw=2, color=C_CALL, label="Covered call")
        ax.hist(yp, bins=bins, histtype="step", lw=2, color=C_PUT, label="Cash-secured put")
        for y, c in [(yc, C_CALL), (yp, C_PUT)]:
            ax.axvline(y.median(), color=c, lw=1, ls=(0, (3, 2)))
        ax.set_title(t)
        ax.text(0.97, 0.95, f"median call {yc.median():.2f}%\nmedian put {yp.median():.2f}%", transform=ax.transAxes,
                ha="right", va="top", fontsize=8.5, color=INK2)
    axes[0].set_ylabel("Weeks")
    fig.supxlabel("Premium / collateral per option, % per week (dashed line = median)", fontsize=10, color=INK2)
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, loc="upper left", bbox_to_anchor=(0.01, 0.90), ncol=2, fontsize=10)
    fig.suptitle("Weekly premium yield, 0.20 delta, IV = trailing realised vol x 1.15", x=0.01, ha="left", fontsize=12)
    fig.tight_layout(rect=(0, 0, 1, 0.86))
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_heatmap(grid: pd.DataFrame, path: Path):
    plt = _style()
    from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm

    rows = [(t, v) for t in TICKERS for v in ["covered call", "cash-secured put"]]
    cols = [(d, vrp) for vrp in (1.0, 1.15) for d in (0.10, 0.20, 0.30)]
    m = np.zeros((len(rows), len(cols) + 1))
    for i, (t, v) in enumerate(rows):
        for j, (d, vrp) in enumerate(cols):
            r = grid[(grid.ticker == t) & (grid.vault == v) & (grid.delta == d) & (grid.vrp == vrp) & (grid.premium_bps == 1.0)].iloc[0]
            m[i, j] = r["sharpe"]
        m[i, -1] = r["bh_sharpe"]
    cmap = LinearSegmentedColormap.from_list("div", ["#a83232", "#e34948", "#f0efec", "#2a78d6", "#104281"])
    lim = max(np.abs(m).max(), 1.0)
    fig, ax = plt.subplots(figsize=(10, 6.2))
    ax.grid(False)
    im = ax.imshow(m, cmap=cmap, norm=TwoSlopeNorm(0, -lim, lim), aspect="auto")
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            ax.text(j, i, f"{m[i, j]:.2f}", ha="center", va="center", fontsize=9.5, color=INK if abs(m[i, j]) < 0.6 * lim else "white")
    labels = [f"delta {d:.2f}\nVRP {vrp:.2f}" for d, vrp in cols] + ["buy and\nhold"]
    ax.set_xticks(range(len(labels)), labels, fontsize=9)
    ax.set_yticks(range(len(rows)), [f"{t} {'call' if v == 'covered call' else 'put'}" for t, v in rows], fontsize=9.5)
    ax.axvline(2.5, color=SURFACE, lw=3)
    ax.axvline(5.5, color=SURFACE, lw=6)
    for i in range(1, len(TICKERS)):
        ax.axhline(2 * i - 0.5, color=SURFACE, lw=3)
    cb = fig.colorbar(im, ax=ax, shrink=0.8)
    cb.set_label("Sharpe ratio (weekly, annualised, rf = 0)", color=INK2)
    cb.outline.set_visible(False)
    ax.set_title("Sharpe ratio by target delta and volatility premium (premiumBps 1.00, premium held)")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


# ----------------------------------------------------------------------------------------- main


def pct(x, d=1):
    return "n/a" if pd.isna(x) else f"{x * 100:.{d}f}%"


def md_table(df: pd.DataFrame) -> str:
    cols = list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "|" + "|".join(["---"] * len(cols)) + "|"]
    for _, r in df.iterrows():
        lines.append("| " + " | ".join(str(r[c]) for c in cols) + " |")
    return "\n".join(lines)


def main():
    RESULTS.mkdir(exist_ok=True)
    CHARTS.mkdir(exist_ok=True)
    px = load_prices()

    cc = cross_check()
    (RESULTS / "pricer_crosscheck.json").write_text(json.dumps(cc, indent=2, default=float) + "\n")
    print("pricer cross-check:", json.dumps({k: cc[k] for k in ("known_quote", "vectors", "gas_md_strike")}, default=float))
    for r in cc["risk_model_table"]:
        print(f"  {r['underlying']} {r['vault']}: strike {r['strike_vs_spot']*100:+.2f}%  yield {r['yield']*100:.3f}%/wk")

    # Full grid.
    grid_rows, runs_by_cfg = [], {}
    for delta in (0.10, 0.20, 0.30):
        for vrp in (1.0, 1.15):
            for pbps in (1.0, 0.95):
                cfg = Config(delta=delta, vrp=vrp, premium_bps=pbps)
                for t in TICKERS:
                    for is_call in (True, False):
                        df = simulate(t, is_call, cfg, px)
                        runs_by_cfg[(cfg, t, is_call)] = df
                        row = summarise(t, is_call, df)
                        row.update(delta=delta, vrp=vrp, premium_bps=pbps, reinvest=False, vol_source="realized")
                        grid_rows.append(row)
    # Variants at the base case.
    variants = [
        ("reinvested", Config(reinvest=True), TICKERS),
        ("reinvested_vrp1", Config(vrp=1.0, reinvest=True), TICKERS),
        ("vix_iv", Config(vol_source="vix", vrp=1.0), ["SPY"]),
        ("sigma_floor_20", Config(sigma_floor=0.20), ["SPY"]),
        ("sigma_floor_20_vrp1", Config(sigma_floor=0.20, vrp=1.0), ["SPY"]),
    ]
    var_rows = []
    for name, cfg, tick in variants:
        for t in tick:
            for is_call in (True, False):
                df = simulate(t, is_call, cfg, px)
                row = summarise(t, is_call, df)
                row.update(variant=name, delta=cfg.delta, vrp=cfg.vrp, premium_bps=cfg.premium_bps, reinvest=cfg.reinvest,
                           vol_source=cfg.vol_source, sigma_floor=cfg.sigma_floor)
                var_rows.append(row)
    grid = pd.DataFrame(grid_rows)
    var = pd.DataFrame(var_rows)
    grid.to_csv(RESULTS / "grid.csv", index=False)
    var.to_csv(RESULTS / "variants.csv", index=False)
    vix = vix_check(px)
    (RESULTS / "vix_check.json").write_text(json.dumps(vix, indent=2, default=float) + "\n")
    print("VIX check:", json.dumps(vix, default=float))

    # Weekly records for the base cases.
    for vrp in (1.0, 1.15):
        base = Config(vrp=vrp)
        frames = []
        for t in TICKERS:
            for is_call in (True, False):
                d = runs_by_cfg[(base, t, is_call)].copy()
                d.insert(0, "vault", "call" if is_call else "put")
                d.insert(0, "ticker", t)
                frames.append(d)
        pd.concat(frames).to_csv(RESULTS / f"weekly_delta020_vrp{int(round(vrp * 100))}.csv", index=False)

    # Charts.
    for vrp in (1.0, 1.15):
        runs = {(t, c): runs_by_cfg[(Config(vrp=vrp), t, c)] for t in TICKERS for c in (True, False)}
        chart_equity(runs, vrp, CHARTS / f"equity_vrp{int(round(vrp * 100))}.png")
    chart_yield_dist({(t, c): runs_by_cfg[(Config(vrp=1.15), t, c)] for t in TICKERS for c in (True, False)}, CHARTS / "premium_yield_distribution.png")
    chart_heatmap(grid, CHARTS / "delta_sensitivity.png")

    # Markdown tables.
    out = []
    first = runs_by_cfg[(Config(), TICKERS[0], True)]
    out.append(f"Weeks simulated: {len(first)} ({first['open'].iloc[0].date()} to {first['expiry'].iloc[-1].date()})\n")
    for vrp in (1.0, 1.15):
        sel = grid[(grid.delta == 0.20) & (grid.vrp == vrp) & (grid.premium_bps == 1.0)]
        t1 = pd.DataFrame({
            "Ticker": sel.ticker, "Vault": sel.vault,
            "CAGR": sel.cagr.map(pct), "B&H CAGR": sel.bh_cagr.map(pct),
            "Vol": sel.vol.map(pct), "B&H vol": sel.bh_vol.map(pct),
            "Sharpe": sel.sharpe.map(lambda x: f"{x:.2f}"), "B&H Sharpe": sel.bh_sharpe.map(lambda x: f"{x:.2f}"),
            "Max DD": sel.max_dd.map(pct), "B&H max DD": sel.bh_max_dd.map(pct),
            "Assigned": sel.assigned.map(pct), "Avg premium/wk": sel.avg_premium_yield.map(lambda x: pct(x, 2)),
            "Worst week": sel.worst_week.map(pct), "B&H worst week": sel.bh_worst_week.map(pct),
        })
        out.append(f"### Base case, delta 0.20, VRP {vrp:.2f}, premiumBps 1.00, premium held\n\n" + md_table(t1) + "\n")
        t2 = pd.DataFrame({
            "Ticker": sel.ticker, "Vault": sel.vault,
            **{f"{p}": [f"{a*100:.1f}% ({b*100:.1f}%)" for a, b in zip(sel[p], sel[p + ' bh'])] for p in PERIODS},
            "Payout / premium": sel.overlay_ratio.map(lambda x: f"{x:.2f}"),
            "Avg strike vs spot": sel.avg_strike_vs_spot.map(lambda x: f"{x*100:+.1f}%"),
            "Avg IV": sel.avg_sigma.map(pct),
            "Mandate rejects": sel.mandate_rejects,
        })
        out.append(f"#### Stress periods, VRP {vrp:.2f} (vault, buy-and-hold in brackets)\n\n" + md_table(t2) + "\n")
    sens = grid.copy()
    sens["cfg"] = sens.apply(lambda r: f"{r.delta:.2f} / {r.vrp:.2f} / {r.premium_bps:.2f}", axis=1)
    t3 = sens.pivot_table(index=["ticker", "vault"], columns="cfg", values="cagr", aggfunc="first").map(pct)
    t3 = t3.reset_index()
    out.append("### Sensitivity: CAGR by delta / VRP / premiumBps\n\n" + md_table(t3) + "\n")
    t3s = sens.pivot_table(index=["ticker", "vault"], columns="cfg", values="sharpe", aggfunc="first").map(lambda x: f"{x:.2f}").reset_index()
    out.append("### Sensitivity: Sharpe by delta / VRP / premiumBps\n\n" + md_table(t3s) + "\n")
    t3a = sens.pivot_table(index=["ticker", "vault"], columns="cfg", values="assigned", aggfunc="first").map(pct).reset_index()
    out.append("### Sensitivity: share of weeks assigned\n\n" + md_table(t3a) + "\n")
    mand = sens[sens.premium_bps == 1.0].pivot_table(index=["ticker", "vault"], columns="cfg", values="mandate_rejects", aggfunc="first").reset_index()
    out.append("### Weeks the demo mandate would reject (premiumBps 1.00)\n\n" + md_table(mand) + "\n")
    reasons = sens[(sens.mandate_rejects > 0) & (sens.premium_bps == 1.0)][["ticker", "vault", "delta", "vrp", "mandate_rejects", "mandate_reasons"]]
    out.append(md_table(reasons) + "\n")
    tv = pd.DataFrame({
        "Variant": var.variant, "Ticker": var.ticker, "Vault": var.vault, "CAGR": var.cagr.map(pct), "B&H CAGR": var.bh_cagr.map(pct),
        "Vol": var.vol.map(pct), "Sharpe": var.sharpe.map(lambda x: f"{x:.2f}"), "Max DD": var.max_dd.map(pct),
        "Assigned": var.assigned.map(pct), "Avg premium/wk": var.avg_premium_yield.map(lambda x: pct(x, 2)), "Avg IV": var.avg_sigma.map(pct),
    })
    out.append("### Variants\n\n" + md_table(tv) + "\n")
    (RESULTS / "tables.md").write_text("\n".join(out))
    print((RESULTS / "tables.md").read_text())


if __name__ == "__main__":
    main()
