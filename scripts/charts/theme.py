"""Shared palette, typography and save helpers for Strike's charts.

The categorical slots were derived from the site palette (ink #121212, paper #e9e9e7,
teal #178f9d / #0e6a74, mint #75d0cb) and validated with the dataviz validator; the run
is recorded in scripts/charts/README.md. The site teal #178f9d sits just under the
chroma floor (OKLCH C 0.098 < 0.10), so slot 1 is the nearest passing teal step.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "media" / "charts"
DATA = Path(__file__).resolve().parent / "data"

# Categorical order is fixed: slot 1 teal, slot 2 coral, slot 3 violet. Never cycled.
THEMES = {
    "light": {
        "surface": "#e9e9e7",  # site paper
        "band": "#dededb",  # one step off the surface, for highlight bands
        "ink": "#121212",  # primary text (15.4:1)
        "ink2": "#45453f",  # secondary text (7.9:1)
        "muted": "#5f5f59",  # axis ticks, footers (5.3:1)
        "context": "#6f6f69",  # de-emphasised series (4.2:1)
        "grid": "#d4d4d0",  # hairline grid
        "axis": "#b3b3ad",  # baseline
        "s1": "#0a8a9f",  # teal
        "s2": "#cf5a24",  # coral
        "s3": "#7457c8",  # violet
    },
    "dark": {
        "surface": "#121212",  # site ink as the surface
        "band": "#1d1d1c",
        "ink": "#e9e9e7",
        "ink2": "#bdbdb6",
        "muted": "#9a9a93",
        "context": "#8d8d86",
        "grid": "#282826",
        "axis": "#44443f",
        "s1": "#1aa3b3",
        "s2": "#e0703a",
        "s3": "#8a74dc",
    },
}

FONT = "DejaVu Sans"
MONO = "DejaVu Sans Mono"

plt.rcParams.update(
    {
        "font.family": FONT,
        "font.size": 11,
        "svg.fonttype": "path",  # text as outlines: identical rendering everywhere
        "svg.hashsalt": "strike-charts",  # stable ids, so re-runs give stable diffs
        "axes.unicode_minus": False,
        "path.simplify": True,
    }
)

PX = 1 / 100  # figures are laid out in CSS pixels at 100 dpi; PNGs are saved at 2x


def figure(width_px: int, height_px: int, t: dict):
    fig = plt.figure(figsize=(width_px * PX, height_px * PX), dpi=100)
    fig.patch.set_facecolor(t["surface"])
    return fig


def style_axes(ax, t: dict, grid_axis: str | None = "x"):
    ax.set_facecolor(t["surface"])
    for side in ("top", "right", "left", "bottom"):
        ax.spines[side].set_visible(False)
    ax.tick_params(colors=t["muted"], labelcolor=t["muted"], length=0, labelsize=10)
    if grid_axis:
        ax.grid(axis=grid_axis, color=t["grid"], linewidth=1, linestyle="-")
        ax.set_axisbelow(True)


def header(fig, t: dict, title: str, subtitle: str | None = None, top_px: int = 22, left_px: int = 24):
    w, h = fig.get_size_inches() * 100
    fig.text(left_px / w, 1 - top_px / h, title, color=t["ink"], fontsize=15, fontweight="bold", va="top")
    if subtitle:
        fig.text(left_px / w, 1 - (top_px + 26) / h, subtitle, color=t["ink2"], fontsize=11, va="top")


def footer(fig, t: dict, text: str, bottom_px: int = 14, left_px: int = 24):
    w, h = fig.get_size_inches() * 100
    fig.text(left_px / w, bottom_px / h, text, color=t["muted"], fontsize=9, va="bottom")


def save(fig, name: str, theme: str):
    OUT.mkdir(parents=True, exist_ok=True)
    base = OUT / f"{name}-{theme}"
    fig.savefig(f"{base}.svg", facecolor=fig.get_facecolor(), metadata={"Date": None, "Creator": None})
    fig.savefig(f"{base}.png", dpi=200, facecolor=fig.get_facecolor(), metadata={"Software": None})
    plt.close(fig)
    return base
