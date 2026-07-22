#!/usr/bin/env python3
"""Render the Deuz benchmark charts (matplotlib).

Reads bench/scores.json (+ bench/results.json for the footprint panel) and writes:
  assets/benchmark.png / assets/benchmark-dark.png   — /100 ranking + scenario heatmap
  assets/footprint.png / assets/footprint-dark.png   — install size + cold import (log scale)

Run: python bench/chart.py
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

THEMES = {
    "light": {
        "suffix": "",
        "bg": "#ffffff",
        "fg": "#1f2328",
        "muted": "#6e7781",
        "bar": "#c9d1d9",
        "deuz": "#0969da",
        "grid": "#eaeef2",
        "heat_cmap": "Blues",
        "outline": "#0969da",
    },
    "dark": {
        "suffix": "-dark",
        "bg": "#0d1117",
        "fg": "#e6edf3",
        "muted": "#8b949e",
        "bar": "#30363d",
        "deuz": "#58a6ff",
        "grid": "#21262d",
        "heat_cmap": "Blues",
        "outline": "#58a6ff",
    },
}

SCENARIOS = [("chatbot", "Chatbot"), ("cli", "CLI"), ("coding", "Coding"), ("asi", "ASI"), ("agi", "AGI")]


def load(name):
    with open(os.path.join(ROOT, "bench", name), encoding="utf-8") as fh:
        return json.load(fh)


def ranking_chart(theme):
    t = THEMES[theme]
    scores = sorted(load("scores.json")["scores"], key=lambda s: s["average"], reverse=True)
    names = [s["name"] for s in scores]
    avgs = [s["average"] for s in scores]
    matrix = np.array([[s[k] for k, _ in SCENARIOS] for s in scores], dtype=float)

    fig = plt.figure(figsize=(15.5, 8.2), facecolor=t["bg"])
    gs = fig.add_gridspec(1, 2, width_ratios=[1.05, 1.35], wspace=0.30,
                          left=0.16, right=0.965, top=0.86, bottom=0.09)

    # --- left: overall ranking ---
    ax = fig.add_subplot(gs[0, 0])
    ax.set_facecolor(t["bg"])
    y = np.arange(len(names))[::-1]
    colors = [t["deuz"] if n == "Deuz SDK" else t["bar"] for n in names]
    ax.barh(y, avgs, color=colors, height=0.66)
    for yi, (avg, name) in enumerate(zip(avgs, names)):
        yy = y[yi]
        ax.text(avg + 0.6, yy, f"{avg:.1f}", va="center", ha="left", fontsize=9.5,
                color=t["deuz"] if name == "Deuz SDK" else t["muted"],
                fontweight="bold" if name == "Deuz SDK" else "normal")
    ax.set_yticks(y, [f"{i + 1:>2}. {n}" for i, n in enumerate(names)], fontsize=10.5, color=t["fg"])
    for tick, name in zip(ax.get_yticklabels(), names):
        if name == "Deuz SDK":
            tick.set_fontweight("bold")
            tick.set_color(t["deuz"])
    ax.set_xlim(0, 100)
    ax.xaxis.set_ticks([0, 25, 50, 75, 100])
    ax.tick_params(axis="x", colors=t["muted"], labelsize=9)
    ax.grid(axis="x", color=t["grid"], linewidth=0.8)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_title("Overall score (mean of 5 scenarios) — /100", color=t["fg"], fontsize=12, loc="left", pad=10)

    # --- right: scenario heatmap ---
    ax2 = fig.add_subplot(gs[0, 1])
    ax2.set_facecolor(t["bg"])
    cmap = plt.get_cmap(t["heat_cmap"]).copy()
    if theme == "dark":
        cmap.set_bad(t["bg"])
    im = ax2.imshow(matrix, aspect="auto", cmap=cmap, vmin=40, vmax=100)
    ax2.set_xticks(range(len(SCENARIOS)), [label for _, label in SCENARIOS], fontsize=10, color=t["fg"])
    ax2.set_yticks(range(len(names)), names, fontsize=10, color=t["fg"])
    for i, name in enumerate(names):
        for j in range(len(SCENARIOS)):
            v = matrix[i, j]
            # Blues cmap: low values = near-white cell in BOTH themes → dark text;
            # high values = saturated blue cell → white text.
            ax2.text(j, i, f"{v:.0f}", ha="center", va="center", fontsize=9,
                     color="#ffffff" if v > 72 else "#1f2328",
                     fontweight="bold" if name == "Deuz SDK" else "normal")
    deuz_row = names.index("Deuz SDK")
    ax2.add_patch(plt.Rectangle((-0.5, deuz_row - 0.5), len(SCENARIOS), 1,
                                fill=False, edgecolor=t["outline"], linewidth=2.2))
    ax2.set_title("Scenario scores", color=t["fg"], fontsize=12, loc="left", pad=10)
    ax2.tick_params(length=0)
    for spine in ax2.spines.values():
        spine.set_visible(False)
    cbar = fig.colorbar(im, ax=ax2, fraction=0.025, pad=0.015)
    cbar.ax.tick_params(colors=t["muted"], labelsize=8)
    cbar.outline.set_visible(False)

    fig.suptitle("AI SDK benchmark — 16 SDKs, 5 scenarios, /100  (2026-07-22 · 1.8.0 panel; rubric + sources in bench/)",
                 x=0.16, y=0.955, ha="left", fontsize=13.5, color=t["fg"], fontweight="bold")
    fig.text(0.16, 0.905, "Deuz SDK 74.0 — 9/16 overall · coding 61→71 · community criterion scored at 393 npm downloads/week + 2 stars, no mercy",
             fontsize=10, color=t["muted"])

    out = os.path.join(ASSETS, f"benchmark{t['suffix']}.png")
    fig.savefig(out, dpi=200, facecolor=t["bg"])
    plt.close(fig)
    print("wrote", out)


def footprint_chart(theme):
    t = THEMES[theme]
    results = load("results.json")["results"]
    names = []
    for r in results:
        label = r["name"]
        if label == "@deuz-sdk/core":
            ver = str(r.get("version", ""))
            short = ver.split("+")[0] if ver else "?"
            label = f"@deuz-sdk/core {short}"
        names.append(label)
    mb = [r["installMB"] for r in results]
    ms = [r["importMsMedian"] for r in results]

    fig, axes = plt.subplots(1, 2, figsize=(13.5, 4.4), facecolor=t["bg"])
    fig.subplots_adjust(left=0.20, right=0.97, top=0.78, bottom=0.12, wspace=0.45)
    for ax, values, title, unit in (
        (axes[0], mb, "Installed size (MB, log scale)", "MB"),
        (axes[1], ms, "Cold import time (ms, log scale)", "ms"),
    ):
        ax.set_facecolor(t["bg"])
        y = np.arange(len(names))[::-1]
        colors = [t["deuz"] if "deuz" in n else t["bar"] for n in names]
        ax.barh(y, values, color=colors, height=0.62)
        ax.set_xscale("log")
        for yi, v in enumerate(values):
            ax.text(v * 1.12, y[yi], f"{v:g} {unit}", va="center", fontsize=9,
                    color=t["deuz"] if "deuz" in names[yi] else t["muted"],
                    fontweight="bold" if "deuz" in names[yi] else "normal")
        ax.set_yticks(y, names, fontsize=10, color=t["fg"])
        for tick, name in zip(ax.get_yticklabels(), names):
            if "deuz" in name:
                tick.set_fontweight("bold")
                tick.set_color(t["deuz"])
        ax.set_xlim(min(values) / 2.2, max(values) * 4.5)
        ax.grid(axis="x", color=t["grid"], linewidth=0.8)
        ax.set_axisbelow(True)
        ax.tick_params(axis="x", colors=t["muted"], labelsize=8.5)
        for spine in ax.spines.values():
            spine.set_visible(False)
        ax.set_title(title, color=t["fg"], fontsize=11, loc="left", pad=8)

    date = load("results.json").get("date", "see results.json")
    fig.suptitle(f"The cost of the box — bare npm installs, measured {date} (bench/results.json)",
                 x=0.20, y=0.93, ha="left", fontsize=12.5, color=t["fg"], fontweight="bold")

    out = os.path.join(ASSETS, f"footprint{t['suffix']}.png")
    fig.savefig(out, dpi=200, facecolor=t["bg"])
    plt.close(fig)
    print("wrote", out)


if __name__ == "__main__":
    os.makedirs(ASSETS, exist_ok=True)
    for theme in ("light", "dark"):
        ranking_chart(theme)
        footprint_chart(theme)
