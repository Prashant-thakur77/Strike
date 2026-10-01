"""Regenerate every chart in docs/media/charts/ from committed data.

Usage (from the repository root):

    python3 scripts/charts/build_charts.py            # all charts, light and dark
    python3 scripts/charts/build_charts.py gas epoch  # only some

Inputs:
    scripts/charts/data/forge-tests.txt   `forge test --summary` lines ("Ran N tests for ..." and "Suite result: ...")
    scripts/charts/data/tests.json        counts for the other suites, each with its command
    scripts/charts/data/coverage.txt      the `make coverage` summary table
    docs/gas.md                           the two gas tables
    research/results/*.csv                the backtest
    scripts/charts/data/epoch.json        the live epoch's transactions
    scripts/charts/data/competition.json  the capability matrix and positioning, with sources
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import OrderedDict, defaultdict
from datetime import date, datetime

import matplotlib.dates as mdates
import matplotlib.transforms as transforms
import matplotlib.ticker as mticker
from matplotlib.lines import Line2D
from matplotlib.patches import Circle, Rectangle, Wedge

from theme import DATA, MONO, ROOT, THEMES, figure, footer, header, save, style_axes

# --------------------------------------------------------------------------- data


def load_tests():
    # Count passing tests: each "Ran N tests for test/<folder>/..." line is followed by its "Suite result" line, whose
    # passed count leaves out skipped tests (the conformance rules an example does not implement).
    folders = defaultdict(int)
    skipped = 0
    folder = None
    for line in (DATA / "forge-tests.txt").read_text().splitlines():
        m = re.match(r"Ran \d+ tests? for test/(?:([a-z]+)/)?\S+", line)
        if m:
            folder = m.group(1) or "root"
            continue
        m = re.match(r"Suite result: ok\. (\d+) passed; \d+ failed; (\d+) skipped", line)
        if m and folder is not None:
            folders[folder] += int(m.group(1))
            skipped += int(m.group(2))
            folder = None
    foundry_total = sum(folders.values())
    names = {
        "root": "version check",
    }
    foundry = sorted(((names.get(k, k + "/"), v) for k, v in folders.items()), key=lambda x: -x[1])
    skip_note = f", {skipped} skipped" if skipped else ""
    groups = [(f"Foundry main suite: {foundry_total} passing{skip_note} (make test)", foundry)]
    for g in json.loads((DATA / "tests.json").read_text())["groups"]:
        items = sorted(((i["label"], i["count"]) for i in g["items"]), key=lambda x: -x[1])
        groups.append((f"{g['group']}: {sum(c for _, c in items)}", items))
    return groups, foundry_total


def load_coverage():
    rows = []
    total = None
    pat = re.compile(r"([0-9.]+)% \((\d+)/(\d+)\)")
    for line in (DATA / "coverage.txt").read_text().splitlines():
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5 or not pat.search(cells[1]):
            continue
        name = cells[0]
        lines = pat.search(cells[1]).groups()
        br = pat.search(cells[3]).groups()
        rec = {
            "file": name,
            "lines": float(lines[0]),
            "lines_n": f"{lines[1]}/{lines[2]}",
            "branches": float(br[0]) if int(br[2]) else None,
            "branches_n": f"{br[1]}/{br[2]}",
        }
        if name == "Total":
            total = rec
        else:
            rows.append(rec)
    return rows, total


def load_gas():
    text = (ROOT / "docs" / "gas.md").read_text()
    # Only the dev-node tables (both Solidity and Stylus measured): the live-chain section has Stylus only.
    text = text.split("\n## Measured on the live chain", 1)[0]
    rows = []
    num = lambda s: int(s.replace(",", "").strip())  # noqa: E731
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and cells[0].startswith("`") and re.match(r"^[\d,]+$", cells[2]):
            rows.append({"group": "call", "call": cells[0].strip("`"), "inputs": cells[1], "sol": num(cells[2]), "sty": num(cells[3])})
        elif len(cells) >= 4 and cells[0].startswith("`") and re.match(r"^[\d,]+$", cells[1]):
            label = re.sub(r"\s*\(.*\)", "", cells[0]).replace("`", "")
            rows.append({"group": "tx", "call": label, "inputs": re.search(r"\((.*)\)", cells[0]).group(1), "sol": num(cells[1]), "sty": num(cells[2])})
    return rows


GAS_LABELS = {
    "TSLA 250, K 275 call, 7 days, 60% vol": "quote · 7-day call, TSLA 250, K 275",
    "K 235 put, 4.2 days": "quote · 4.2-day put, K 235",
    "at-the-money call, 30 days, 50% vol": "quote · 30-day at-the-money call",
    "0.20 delta; solves the strike on-chain": "proposeByDelta · 0.20 delta",
    "live Black-Scholes quote": "buy · 5 options at a live quote",
}


def ratio_text(sol, sty):
    if sty < sol:
        r = sol / sty
        return f"Stylus {r:.1f}× less" if r >= 1.5 else f"Stylus {round((1 - sty / sol) * 100)}% less"
    return f"Stylus {sty / sol:.2f}× more"


def load_backtest(vrp="115"):
    series = defaultdict(lambda: {"d": [], "nav": [], "bh": []})
    with open(ROOT / "research" / "results" / f"weekly_delta020_vrp{vrp}.csv") as f:
        for r in csv.DictReader(f):
            s = series[(r["ticker"], r["vault"])]
            s["d"].append(date.fromisoformat(r["expiry"]))
            s["nav"].append(float(r["nav"]))
            s["bh"].append(float(r["bh_nav"]))
    stats = {}
    with open(ROOT / "research" / "results" / "grid.csv") as f:
        for r in csv.DictReader(f):
            if r["delta"] == "0.2" and r["vrp"] == str(int(vrp) / 100) and r["premium_bps"] == "1.0":
                stats[(r["ticker"], r["vault"])] = {k: float(r[k]) for k in ("cagr", "bh_cagr", "vol", "bh_vol", "max_dd", "bh_max_dd", "sharpe", "bh_sharpe")}
    return series, stats


def blended(fig, ax):
    """x in figure fraction, y in data units: for row headers in the left margin."""
    return transforms.blended_transform_factory(fig.transFigure, ax.transData)


def short(h):
    return f"{h[:10]}…{h[-4:]}"


# --------------------------------------------------------------------------- (a) tests


def chart_tests(t, theme):
    groups, _ = load_tests()
    total = sum(c for _, items in groups for _, c in items)
    rows = []  # (kind, label, count)
    for g, items in groups:
        rows.append(("h", g, None))
        rows.extend(("b", label, c) for label, c in items)
    row_px = 25
    top, bottom = 96, 56
    H = top + bottom + row_px * len(rows)
    W = 1000
    fig = figure(W, H, t)
    left = 250
    ax = fig.add_axes([left / W, bottom / H, (W - left - 70) / W, (H - top - bottom) / H])
    style_axes(ax, t, "x")
    n = len(rows)
    ax.set_ylim(n - 0.5, -0.7)
    xmax = max(c for k, _, c in rows if k == "b")
    ax.set_xlim(0, xmax * 1.08)
    ax.set_yticks([])
    ax.xaxis.set_major_locator(mticker.MultipleLocator(50))
    ax.axvline(0, color=t["axis"], linewidth=1)
    for i, (kind, label, c) in enumerate(rows):
        if kind == "h":
            ax.text(24 / W, i + 0.12, label, transform=blended(fig, ax), ha="left", va="center", color=t["ink"], fontsize=10.5, fontweight="bold")
            continue
        ax.barh(i, c, height=0.62, color=t["s1"], linewidth=0)
        ax.text(-0.012, i, label, transform=ax.get_yaxis_transform(), ha="right", va="center", color=t["ink2"], fontsize=10)
        ax.text(c + xmax * 0.01, i, f"{c}", ha="left", va="center", color=t["ink"], fontsize=10)
    header(fig, t, f"{total} tests and proofs, by suite", "Every count is re-measured by a command listed in scripts/charts/data; Playwright counts one viewport (x2 runs).")
    footer(fig, t, "Sources: forge test --summary · corepack pnpm -r test · npx playwright test --list · grep over test files · measured " + json.loads((DATA / "tests.json").read_text())["measured"])
    return save(fig, "tests-by-suite", theme)


# --------------------------------------------------------------------------- (b) coverage


def chart_coverage(t, theme):
    rows, total = load_coverage()
    rows.sort(key=lambda r: (min(r["lines"], r["branches"] if r["branches"] is not None else 100), r["file"]))
    rows.append(None)  # spacer
    rows.append(total)
    row_px = 34
    top, bottom = 112, 64
    H = top + bottom + row_px * len(rows)
    W = 1000
    fig = figure(W, H, t)
    left = 270
    ax = fig.add_axes([left / W, bottom / H, (W - left - 60) / W, (H - top - bottom) / H])
    style_axes(ax, t, "x")
    lo = 88
    ax.set_xlim(lo, 100.9)
    ax.set_ylim(len(rows) - 0.4, -0.6)
    ax.set_yticks([])
    ax.xaxis.set_major_locator(mticker.MultipleLocator(2))
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:.0f}%"))
    # the CI gate: total line coverage must stay at or above 95%
    ax.axvline(95, color=t["ink2"], linewidth=1)
    ax.text(95.1, -0.55, "CI gate: total line coverage ≥ 95%", color=t["ink2"], fontsize=9.5, va="bottom", ha="left")
    off = 0.21
    for i, r in enumerate(rows):
        if r is None:
            ax.axhline(i, color=t["axis"], linewidth=1)
            continue
        name = r["file"].replace("src/", "").replace(".sol", "")
        is_total = r is total
        ax.text(-0.012, i, "Total (src/ and examples/)" if is_total else name, transform=ax.get_yaxis_transform(), ha="right", va="center",
                color=t["ink"] if is_total else t["ink2"], fontsize=10, fontweight="bold" if is_total else "normal")
        ax.hlines(i, lo, 100, color=t["grid"], linewidth=1, zorder=0)
        for val, dy, col, key in ((r["lines"], -off, t["s1"], "lines"), (r["branches"], off, t["s2"], "branches")):
            if val is None:
                ax.text(99.6, i + dy, "no branches", ha="right", va="center", color=t["muted"], fontsize=8.5)
                continue
            ax.scatter([val], [i + dy], s=58, color=col, edgecolors=t["surface"], linewidths=2, zorder=3)
            if val < 100 or is_total:
                ax.text(val - 0.22, i + dy, f"{val:.1f}%", ha="right", va="center", color=t["ink"], fontsize=8.5)
    # legend (two series)
    w, h = W, H
    lx, ly = 30 / w, 1 - 78 / h
    for k, (lab, col) in enumerate((("Lines", t["s1"]), ("Branches", t["s2"]))):
        x = lx + k * 0.11
        fig.add_artist(Line2D([x], [ly], marker="o", markersize=8, color=col, markeredgecolor=t["surface"], markeredgewidth=2, linestyle="none", transform=fig.transFigure))
        fig.text(x + 0.012, ly, lab, color=t["ink2"], fontsize=10, va="center")
    header(fig, t, f"Coverage by contract: {total['lines']:.1f}% of lines, {total['branches']:.1f}% of branches",
           f"forge coverage over src/ and examples/, {total['lines_n']} lines and {total['branches_n']} branches. Axis starts at {lo}%.")
    footer(fig, t, "Source: make coverage (forge coverage --ir-minimum --report summary --no-match-coverage \"(test|script|lib)/\"), 2026-09-30")
    return save(fig, "coverage-by-contract", theme)


# --------------------------------------------------------------------------- (c) gas


def chart_gas(t, theme):
    rows = load_gas()
    items = []
    items.append(("h", "One pricer call, through PricerGasProbe"))
    items += [("r", r) for r in rows if r["group"] == "call"]
    items.append(("h", "A whole EpochManager transaction (L2 execution gas)"))
    items += [("r", r) for r in rows if r["group"] == "tx"]
    row_px = 34
    top, bottom = 118, 60
    H = top + bottom + row_px * len(items)
    W = 1000
    fig = figure(W, H, t)
    left, right = 300, 175
    ax = fig.add_axes([left / W, bottom / H, (W - left - right) / W, (H - top - bottom) / H])
    style_axes(ax, t, "x")
    ax.set_xscale("log")
    ax.set_xlim(15_000, 3_000_000)
    ax.set_ylim(len(items) - 0.5, -0.7)
    ax.set_yticks([])
    ticks = [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000]
    ax.xaxis.set_major_locator(mticker.FixedLocator(ticks))
    ax.xaxis.set_minor_locator(mticker.NullLocator())
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v / 1e6:g}M" if v >= 1e6 else f"{v / 1e3:g}k"))
    for i, (kind, r) in enumerate(items):
        if kind == "h":
            ax.text(24 / W, i + 0.1, r, transform=blended(fig, ax), ha="left", va="center", color=t["ink"], fontsize=10.5, fontweight="bold")
            continue
        label = GAS_LABELS.get(r["inputs"], f"{r['call']} · {r['inputs']}")
        ax.text(-0.012, i, label, transform=ax.get_yaxis_transform(), ha="right", va="center", color=t["ink2"], fontsize=9.5)
        ax.hlines(i, min(r["sol"], r["sty"]), max(r["sol"], r["sty"]), color=t["axis"], linewidth=2, zorder=1)
        ax.scatter([r["sol"]], [i], s=70, color=t["s2"], edgecolors=t["surface"], linewidths=2, zorder=3)
        ax.scatter([r["sty"]], [i], s=70, color=t["s1"], edgecolors=t["surface"], linewidths=2, zorder=3)
        ax.text(1.02, i, ratio_text(r["sol"], r["sty"]), transform=ax.get_yaxis_transform(), ha="left", va="center",
                color=t["ink"], fontsize=10, fontweight="bold" if r["sty"] < r["sol"] else "normal")
    w, h = W, H
    lx, ly = 30 / w, 1 - 82 / h
    for k, (lab, col) in enumerate((("Solidity (BlackScholesLib)", t["s2"]), ("Stylus (Rust, WASM)", t["s1"]))):
        x = lx + k * 0.25
        fig.add_artist(Line2D([x], [ly], marker="o", markersize=8, color=col, markeredgecolor=t["surface"], markeredgewidth=2, linestyle="none", transform=fig.transFigure))
        fig.text(x + 0.012, ly, lab, color=t["ink2"], fontsize=10, va="center")
    header(fig, t, "Gas per call: Solidity vs Stylus pricer",
           "A single quote is cheaper in Solidity (Stylus pays a fixed entry cost); the 48-step strike solver is 6.5× cheaper in Stylus.")
    footer(fig, t, "Log scale. Source: docs/gas.md, measured on a Nitro dev node (nitro-node v3.7.1), Stylus program uncached. scripts/stylus-gas.sh, scripts/stylus-e2e.sh")
    return save(fig, "gas-stylus-vs-solidity", theme)


# --------------------------------------------------------------------------- (d) backtest


def chart_backtest(t, theme):
    series, stats = load_backtest("115")
    W, H = 1000, 800
    fig = figure(W, H, t)
    tickers = ["TSLA", "NVDA", "AMZN", "SPY"]
    pw, ph = 0.36, 0.27
    xs = [0.075, 0.555]
    ys = [0.495, 0.1]
    for k, tk in enumerate(tickers):
        ax = fig.add_axes([xs[k % 2], ys[k // 2], pw, ph])
        style_axes(ax, t, "y")
        ax.set_yscale("log")
        call, put = series[(tk, "call")], series[(tk, "put")]
        ax.plot(call["d"], call["bh"], color=t["context"], linewidth=1.4, solid_joinstyle="round", solid_capstyle="round")
        ax.plot(put["d"], put["nav"], color=t["s2"], linewidth=1.6, solid_joinstyle="round", solid_capstyle="round")
        ax.plot(call["d"], call["nav"], color=t["s1"], linewidth=2, solid_joinstyle="round", solid_capstyle="round")
        ends = sorted([(call["bh"][-1], t["context"]), (call["nav"][-1], t["s1"]), (put["nav"][-1], t["s2"])])
        for v, _ in ends:
            ax.text(call["d"][-1], v, f"  {v:.2f}×", va="center", ha="left", color=t["ink2"], fontsize=9)
        ax.axhline(1, color=t["axis"], linewidth=1, zorder=1)
        ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}×"))
        ax.yaxis.set_minor_formatter(mticker.NullFormatter())
        lo = min(min(put["nav"]), min(call["bh"]), min(call["nav"]))
        hi = max(max(call["bh"]), max(call["nav"]))
        ax.set_ylim(lo * 0.85, hi * 1.25)
        ax.yaxis.set_major_locator(mticker.LogLocator(base=10, subs=(1, 2, 5) if hi / lo > 6 else (1, 1.5, 2, 3)))
        ax.yaxis.set_minor_locator(mticker.NullLocator())
        ax.tick_params(which="both", length=0)
        ax.xaxis.set_major_locator(mdates.YearLocator(2))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
        ax.set_xlim(date(2019, 1, 1), date(2026, 12, 31))
        s = stats[(tk, "covered call")]
        cut = (1 - s["vol"] / s["bh_vol"]) * 100
        ax.text(0, 1.14, tk, transform=ax.transAxes, color=t["ink"], fontsize=13, fontweight="bold", va="bottom")
        ax.text(0, 1.03, f"Covered call volatility {s['vol'] * 100:.1f}% vs {s['bh_vol'] * 100:.1f}% held (−{cut:.0f}%)",
                transform=ax.transAxes, color=t["ink2"], fontsize=9.5, va="bottom")
    # legend
    lx, ly = 24 / W, 1 - 84 / H
    for k, (lab, col, lw) in enumerate((("Covered-call vault", t["s1"], 2), ("Cash-secured-put vault", t["s2"], 1.6), ("Buy and hold", t["context"], 1.4))):
        x = lx + k * 0.22
        fig.add_artist(Line2D([x, x + 0.03], [ly, ly], color=col, linewidth=lw + 1, transform=fig.transFigure, solid_capstyle="round"))
        fig.text(x + 0.037, ly, lab, color=t["ink2"], fontsize=10, va="center")
    header(fig, t, "Growth of $1: weekly 0.20-delta vaults vs holding the stock, 2019–2026",
           "403 weekly epochs per ticker. Implied volatility = trailing 21-day realised × 1.15. Premium held in USDG.")
    footer(fig, t, "Log scale; values at each Friday settlement. Source: research/results/weekly_delta020_vrp115.csv and grid.csv (python3 research/backtest.py)")
    return save(fig, "backtest-equity", theme)


# --------------------------------------------------------------------------- (e) live epoch


def chart_epoch(t, theme):
    d = json.loads((DATA / "epoch.json").read_text())
    ev = d["events"]
    kinds = OrderedDict(
        [
            ("accepted", ("Proposal accepted", t["s1"])),
            ("rejected", ("Proposal rejected, bond slashed", t["s2"])),
            ("payout", ("Slash paid to depositors", t["s3"])),
            ("neutral", ("Other transaction", t["context"])),
            ("pending", ("Not yet happened", None)),
        ]
    )
    rows = []
    last_day = None
    for e in ev:
        dt = datetime.strptime(e["utc"], "%Y-%m-%dT%H:%M:%SZ")
        if dt.date() != last_day:
            rows.append(("day", dt.strftime("%a %Y-%m-%d") + " (UTC)"))
            last_day = dt.date()
        rows.append(("ev", e, dt))
    row_px = 38
    top, bottom = 122, 52
    W = 1000
    H = top + bottom + row_px * len(rows)
    fig = figure(W, H, t)
    ax = fig.add_axes([0, bottom / H, 1, (H - top - bottom) / H])
    ax.set_axis_off()
    ax.set_xlim(0, W)
    ax.set_ylim(len(rows) - 0.5, -0.5)
    rail_x = 128
    ev_rows = [i for i, r in enumerate(rows) if r[0] == "ev"]
    for a, b in zip(ev_rows, ev_rows[1:]):
        if b == a + 1:  # same day: connect; a day header in between breaks the rail
            ax.plot([rail_x, rail_x], [a, b], color=t["axis"], linewidth=1.5, zorder=1)
    for i, r in enumerate(rows):
        if r[0] == "day":
            ax.text(24, i, r[1], color=t["ink"], fontsize=11, fontweight="bold", va="center")
            continue
        e, dt = r[1], r[2]
        ax.text(24, i, dt.strftime("%H:%M:%S"), color=t["muted"], fontsize=10, va="center", family=MONO)
        _, col = kinds[e["kind"]]
        if col is None:
            ax.scatter([rail_x], [i], s=90, facecolor=t["surface"], edgecolors=t["context"], linewidths=1.6, zorder=3)
        else:
            ax.scatter([rail_x], [i], s=90, color=col, edgecolors=t["surface"], linewidths=2, zorder=3)
        ax.text(150, i, e["text"], color=t["ink"] if e["kind"] != "neutral" else t["ink2"], fontsize=10.5, va="center",
                fontweight="bold" if e["kind"] in ("accepted", "rejected", "payout") else "normal")
        tx = short(e["tx"]) if e["tx"] else "pending"
        blk = f"block {e['block']:,}" if e["block"] else ""
        ax.text(W - 24, i - 0.13, tx, color=t["ink2"], fontsize=9.5, va="center", ha="right", family=MONO)
        if blk:
            ax.text(W - 24, i + 0.2, blk, color=t["muted"], fontsize=8, va="center", ha="right")
    # legend
    lx, ly = 24 / W, 1 - 84 / H
    x = lx
    for key, (lab, col) in kinds.items():
        if col is None:
            fig.add_artist(Line2D([x], [ly], marker="o", markersize=8, markerfacecolor=t["surface"], markeredgecolor=t["context"], markeredgewidth=1.6, linestyle="none", transform=fig.transFigure))
        else:
            fig.add_artist(Line2D([x], [ly], marker="o", markersize=8, color=col, markeredgecolor=t["surface"], markeredgewidth=2, linestyle="none", transform=fig.transFigure))
        fig.text(x + 0.012, ly, lab, color=t["ink2"], fontsize=9.5, va="center")
        x += 0.012 + len(lab) * 0.0068 + 0.03
    header(fig, t, "The first agent-run epoch on Robinhood Chain testnet (v2)", "Every row is a transaction on Blockscout; times are block timestamps.")
    footer(fig, t, "Source: docs/testnet-epochs/2026-09-29.md. Block times read with cast from rpc.testnet.chain.robinhood.com; links in docs/DEPLOYMENTS.md")
    return save(fig, "live-epoch-timeline", theme)


# --------------------------------------------------------------------------- (f) competition matrix


GLYPH_ROWS = {"On-chain agent mandate", "Slashing paid to depositors", "Oracle-anchored pricing", "Stock-token (ERC-8056) safety", "ERC-8004 agent identity", "USDG"}

SHORT = {
    "Chain": ["RH Chain testnet;\nArbitrum Sepolia", "RH Chain mainnet", "RH Chain testnet", "Ethereum, Avalanche,\nSolana; Aevo rollup", "Optimism (v1);\nDerive chain", "Base; Ethereum", "RH Chain testnet",
              "RH Chain testnet", "RH Chain testnet", "RH Chain mainnet;\nBase"],
    "Live status": ["Testnet, three\nlive epochs", "Mainnet since\n2026-09-25", "Testnet proof\nof concept", "Aevo launched;\nvaults not described", "v3 on testnet", "V4 on Base,\nearly testing", "Testnet; NYC\nonline 1st place",
                    "Testnet; entered\nthis buildathon", "Testnet, mocks;\nentry not confirmed", "Mainnet, live;\nentry not confirmed"],
    "Who picks the strike": ["Bonded AI agent,\nchecked on-chain", "Writers, from\na listed ladder", "Traders", "Off-chain algorithm,\n10 delta", "Owner lists (v1);\nusers (v3)", "Requesting trader\n(RFQ)", "No options;\nAI-managed vaults",
                             "Buyers", "not described", "not described"],
}


def cell_state(text):
    s = text.lower()
    if s.startswith("yes"):
        return "yes"
    if s.startswith("partly") or s.startswith("nyse-close") or s.startswith("curator"):
        return "partly"
    if s.startswith("not described"):
        return "nd"
    return "other"


def cell_short(row, text):
    st = cell_state(text)
    if st == "yes":
        return "Yes"
    if st == "nd":
        return "not described"
    if row == "On-chain agent mandate" and text.startswith("Partly"):
        return "Partly: auto-roll\nand maker bounds"
    if row == "On-chain agent mandate" and text.startswith("Curator"):
        return "Curator stake\nfloor only"
    if row == "Stock-token (ERC-8056) safety" and text.startswith("NYSE"):
        return "NYSE-close expiry\nonly"
    if row == "Stock-token (ERC-8056) safety" and text.startswith("Partly: closed-market"):
        return "Partly: prices\nclosed hours"
    if row == "Stock-token (ERC-8056) safety" and text.startswith("Partly: NYSE calendar"):
        return "Partly: NYSE\ncalendar on-chain"
    return {
        "Order book; oracle at settlement": "Order book;\noracle settles",
        "Order book; no oracle": "Order book;\nno oracle",
        "Auctions; oracle at settlement": "Auctions;\noracle settles",
        "AMM model (v1); order book and RFQ (v3)": "AMM model (v1);\nbook + RFQ (v3)",
        "RFQ; oracle at expiry": "RFQ;\noracle settles",
        "RFQ engine; an oracle parses SEC and STOCK Act filings": "RFQ; oracle reads\nSEC filings",
        "Agent budgets in TradeLogic; no bond described": "Agent budgets;\nno bond",
        "Stylus model on realised volatility, closed-market time priced separately; settles on the first feed print at or after expiry": "Stylus model on\nrealised volatility",
        "Venues, RFQ and auctions; a Stylus kernel re-prices margin across 39 scenarios": "Venues, RFQ,\nauctions",
        "No: uses tUSD": "No: tUSD",
    }.get(text, text)


def chart_matrix(t, theme):
    d = json.loads((DATA / "competition.json").read_text())
    projects, rows = d["projects"], d["rows"]
    left = 290
    W = left + 24 + 162 * len(projects)
    col_w = (W - left - 24) / len(projects)
    row_h = 54
    top, bottom = 150, 70
    H = top + bottom + row_h * len(rows)
    fig = figure(W, H, t)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_xlim(0, W)
    ax.set_ylim(H, 0)
    # Strike column band
    ax.add_patch(Rectangle((left, top - 44), col_w, row_h * len(rows) + 44, facecolor=t["band"], edgecolor="none", zorder=0))
    for j, p in enumerate(projects):
        cx = left + col_w * (j + 0.5)
        ax.text(cx, top - 22, p, ha="center", va="center", color=t["ink"], fontsize=11.5, fontweight="bold")
    ax.plot([24, W - 24], [top, top], color=t["axis"], linewidth=1)
    for i, r in enumerate(rows):
        y0 = top + i * row_h
        cy = y0 + row_h / 2
        ax.text(24, cy, r["row"], ha="left", va="center", color=t["ink"], fontsize=10.5, fontweight="bold", wrap=True)
        ax.plot([24, W - 24], [y0 + row_h, y0 + row_h], color=t["grid"], linewidth=1)
        for j, text in enumerate(r["cells"]):
            cx = left + col_w * (j + 0.5)
            if r["row"] in SHORT:
                ax.text(cx, cy, SHORT[r["row"]][j], ha="center", va="center", color=t["ink2"], fontsize=9.5, linespacing=1.3)
                continue
            st = cell_state(text)
            label = cell_short(r["row"], text)
            gx = cx - col_w / 2 + 16
            if st == "yes":
                ax.scatter([gx], [cy], s=80, color=t["s1"], edgecolors=t["surface"], linewidths=2, zorder=3)
            elif st == "partly":
                ax.add_patch(Wedge((gx, cy), 6.5, 90, 270, facecolor=t["s1"], edgecolor="none", zorder=3))
                ax.add_patch(Circle((gx, cy), 6.5, facecolor="none", edgecolor=t["s1"], linewidth=1.5, zorder=3))
            elif st == "nd":
                ax.add_patch(Circle((gx, cy), 6, facecolor="none", edgecolor=t["context"], linewidth=1.3, zorder=3))
            else:
                ax.add_patch(Rectangle((gx - 6, cy - 1), 12, 2, facecolor=t["context"], edgecolor="none", zorder=3))
            ax.text(gx + 14, cy, label, ha="left", va="center", color=t["ink"] if st == "yes" else (t["muted"] if st == "nd" else t["ink2"]),
                    fontsize=9.5, linespacing=1.3, fontweight="bold" if st == "yes" else "normal")
    # key
    ky = top + row_h * len(rows) + 26
    kx = 24
    items = [("yes", "Yes, per its docs"), ("partly", "Partly"), ("other", "A different mechanism (named)"), ("nd", "not described in the cited docs")]
    for st, lab in items:
        gx, cy = kx + 7, ky
        if st == "yes":
            ax.scatter([gx], [cy], s=80, color=t["s1"], edgecolors=t["surface"], linewidths=2, zorder=3)
        elif st == "partly":
            ax.add_patch(Wedge((gx, cy), 6.5, 90, 270, facecolor=t["s1"], edgecolor="none"))
            ax.add_patch(Circle((gx, cy), 6.5, facecolor="none", edgecolor=t["s1"], linewidth=1.5))
        elif st == "nd":
            ax.add_patch(Circle((gx, cy), 6, facecolor="none", edgecolor=t["context"], linewidth=1.3))
        else:
            ax.add_patch(Rectangle((gx - 6, cy - 1), 12, 2, facecolor=t["context"], edgecolor="none"))
        ax.text(gx + 14, cy, lab, va="center", color=t["ink2"], fontsize=9.5)
        kx += 48 + len(lab) * 7.4
    ax.text(24, 24, "Options on stock tokens, weekly option vaults and AI-run stock vaults: what each project's own docs say", color=t["ink"], fontsize=15, fontweight="bold", va="top")
    ax.text(24, 52, "\"not described\" means the cited pages do not cover it, not that the project lacks it. RH Chain = Robinhood Chain.", color=t["ink2"], fontsize=11, va="top")
    ax.text(24, H - 16, "Sources: each project's docs and repositories, read 2026-09-30 and 2026-10-01 (list under the matrix in README.md and in scripts/charts/data/competition.json)",
            color=t["muted"], fontsize=9, va="bottom")
    return save(fig, "competition-matrix", theme)


# --------------------------------------------------------------------------- (g) positioning


def chart_positioning(t, theme):
    d = json.loads((DATA / "competition.json").read_text())["positions"]
    W, H = 1000, 760
    fig = figure(W, H, t)
    left, right, top, bottom = 250, 40, 100, 130
    ax = fig.add_axes([left / W, bottom / H, (W - left - right) / W, (H - top - bottom) / H])
    style_axes(ax, t, None)
    ax.set_xlim(-0.5, 3.5)
    ax.set_ylim(-0.5, 3.5)
    ax.axvline(1.5, color=t["axis"], linewidth=1.2, zorder=0)
    ax.axhline(1.5, color=t["axis"], linewidth=1.2, zorder=0)
    ax.add_patch(Rectangle((1.5, 1.5), 2, 2, facecolor=t["band"], edgecolor="none", zorder=-1))
    ax.set_xticks(range(4))
    ax.set_yticks(range(4))
    xl = ["Each trader\nor writer", "Listed by\nthe operator", "An algorithm at\na fixed delta", "A bonded agent\nthe contract checks"]
    yl = ["Order book", "RFQ or auction", "AMM with a\npricing model", "Oracle-anchored\nmodel at every\npurchase"]
    ax.set_xticklabels(xl, color=t["ink2"], fontsize=10)
    ax.set_yticklabels(yl, color=t["ink2"], fontsize=10)
    ax.tick_params(axis="x", pad=8)
    ax.tick_params(axis="y", pad=8)
    ax.set_xlabel("Who picks the strike  →", color=t["ink"], fontsize=11, fontweight="bold", labelpad=12)
    ax.set_ylabel("How the price is set  →", color=t["ink"], fontsize=11, fontweight="bold", labelpad=12)
    pts = {p["name"]: p for p in d["points"]}
    # spread points that share a cell
    offsets = {
        "Stonkhouse": (-0.22, 0.18),
        "Archer Markets": (-0.22, -0.06),
        "Aevo": (-0.22, -0.3),
        "Derive v3": (0.1, 0.15),
        "Thetanuts V4": (-0.22, 0.0),
        "Ribbon Theta Vaults": (-0.2, 0.0),
        "Lyra v1": (-0.2, 0.0),
        "AfterHours": (-0.22, 0.0),
        "Strike": (-0.1, 0.0),
    }
    pos = {n: (p["x"] + offsets[n][0], p["y"] + offsets[n][1]) for n, p in pts.items()}
    bend = {"Lyra v1": -0.3, "Ribbon Theta Vaults": -0.25}
    for a, b in d["links"]:
        (x0, y0), (x1, y1) = pos[a], pos[b]
        if b == "Aevo":  # end just after the label, so the arrow never crosses text
            x1 += 0.36
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0),
                    arrowprops=dict(arrowstyle="-|>", color=t["context"], lw=1, shrinkA=7, shrinkB=7, mutation_scale=10,
                                    connectionstyle=f"arc3,rad={bend.get(a, 0)}"), zorder=1)
    for n, (x, y) in pos.items():
        strike = n == "Strike"
        ax.scatter([x], [y], s=150 if strike else 70, color=t["s1"] if strike else t["context"], edgecolors=t["surface"], linewidths=2, zorder=3)
        ax.text(x + (0.08 if not strike else 0.1), y, n, va="center", ha="left", color=t["ink"] if strike else t["ink2"],
                fontsize=12.5 if strike else 10, fontweight="bold" if strike else "normal", zorder=4)
    header(fig, t, "Where Strike sits: who picks the strike, and how the price is set",
           "Placed from each project's own docs. Arrows point from a team's earlier product to its later one.")
    footer(fig, t, "Sources: each project's docs and repositories, listed in scripts/charts/data/competition.json and under the chart in README.md")
    return save(fig, "competition-positioning", theme)


CHARTS = OrderedDict(
    [
        ("tests", chart_tests),
        ("coverage", chart_coverage),
        ("gas", chart_gas),
        ("backtest", chart_backtest),
        ("epoch", chart_epoch),
        ("matrix", chart_matrix),
        ("positioning", chart_positioning),
    ]
)


def main(argv):
    wanted = argv or list(CHARTS)
    for name in wanted:
        for theme, t in THEMES.items():
            base = CHARTS[name](t, theme)
            print(f"{base.relative_to(ROOT)}.{{svg,png}}")


if __name__ == "__main__":
    main(sys.argv[1:])
