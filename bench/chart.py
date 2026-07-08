#!/usr/bin/env python3
"""Render assets/benchmark.png and assets/benchmark-dark.png from bench/results.json.

OpenAI-release-style benchmark panels: vertical bars, the measured subject first
and highlighted, value labels on top, minimal grid. Deterministic: everything
(numbers, versions, footnote) derives from results.json, which is produced by
`python bench/measure.py`. Requires only matplotlib.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
RESULTS = Path(__file__).resolve().parent / "results.json"
ASSETS = ROOT / "assets"

ACCENT_LABEL = "@deuz-sdk/core"

DISPLAY_NAMES = {
    "@deuz-sdk/core": "Deuz SDK",
    "ai (Vercel AI SDK)": "ai (Vercel)",
    "@mastra/core": "Mastra",
    "langchain": "LangChain",
    "llamaindex": "LlamaIndex",
    "@openai/agents": "OpenAI Agents",
}

THEMES = {
    "light": {
        "file": "benchmark.png",
        "surface": "#fcfcfb",
        "ink": "#0b0b0b",
        "secondary": "#52514e",
        "muted": "#898781",
        "grid": "#e1e0d9",
        "baseline": "#c3c2b7",
        "accent": "#2a78d6",
        "bar_muted": "#b5b3ac",
    },
    "dark": {
        "file": "benchmark-dark.png",
        "surface": "#1a1a19",
        "ink": "#ffffff",
        "secondary": "#c3c2b7",
        "muted": "#898781",
        "grid": "#2c2c2a",
        "baseline": "#383835",
        "accent": "#3987e5",
        "bar_muted": "#55534f",
    },
}

PANELS = [
    ("installMB", "Install footprint", "MB on disk", lambda v: f"{v:,.1f}"),
    ("packageCount", "Installed packages", "count", lambda v: f"{v:,.0f}"),
    ("fileCount", "Files on disk", "count", lambda v: f"{v:,.0f}"),
    ("importMsMedian", "Cold import", "ms, median of 7", lambda v: f"{v:,.0f}"),
]


def tick_label(pkg: dict) -> str:
    name = DISPLAY_NAMES.get(pkg["label"], pkg["label"])
    version = pkg.get("resolvedVersion") or pkg["spec"].rsplit("@", 1)[-1]
    return f"{name}\n{version}"


def render(theme: dict, data: dict) -> None:
    packages = [p for p in data["packages"] if p.get("installOk")]
    # Fixed order in every panel: the measured subject first, then competitors
    # by ascending install size. Color follows the entity, never the rank.
    subject = [p for p in packages if p["label"] == ACCENT_LABEL]
    others = sorted(
        (p for p in packages if p["label"] != ACCENT_LABEL), key=lambda p: p["installBytes"]
    )
    packages = subject + others
    labels = [tick_label(p) for p in packages]
    colors = [
        theme["accent"] if p["label"] == ACCENT_LABEL else theme["bar_muted"] for p in packages
    ]

    fig, axes = plt.subplots(2, 2, figsize=(11, 6.4), dpi=150)
    fig.patch.set_facecolor(theme["surface"])
    fig.subplots_adjust(left=0.055, right=0.98, top=0.82, bottom=0.115, hspace=0.62, wspace=0.18)

    fig.text(
        0.03, 0.955, "What `npm install <sdk>` actually costs",
        fontsize=15, fontweight="bold", color=theme["ink"], ha="left",
    )
    fig.text(
        0.03, 0.905,
        "Bare-package installs of TypeScript AI SDKs, measured — lower is better",
        fontsize=10, color=theme["secondary"], ha="left",
    )

    x = range(len(packages))
    for ax, (key, title, unit, fmt) in zip(axes.flat, PANELS):
        ax.set_facecolor(theme["surface"])
        values = [p.get(key) for p in packages]
        present = [v if isinstance(v, (int, float)) else 0 for v in values]

        ax.bar(list(x), present, width=0.62, color=colors, zorder=3)
        ax.set_xticks(list(x))
        ax.set_xticklabels(labels, fontsize=7.2, color=theme["secondary"], linespacing=1.4)
        for tick, p in zip(ax.get_xticklabels(), packages):
            if p["label"] == ACCENT_LABEL:
                tick.set_color(theme["ink"])
                tick.set_fontweight("bold")

        ax.set_title(
            f"{title}  ·  {unit}", fontsize=10, color=theme["ink"], loc="left", pad=10,
            fontweight="bold",
        )
        max_v = max(present) if any(present) else 1
        ax.set_ylim(0, max_v * 1.22)
        ax.yaxis.grid(True, color=theme["grid"], linewidth=0.7, zorder=0)
        ax.set_axisbelow(True)
        ax.set_yticks([])  # bar-top value labels carry the numbers
        ax.tick_params(axis="x", length=0)
        for spine in ("top", "right", "left"):
            ax.spines[spine].set_visible(False)
        ax.spines["bottom"].set_color(theme["baseline"])
        ax.spines["bottom"].set_linewidth(0.8)

        for xi, (value, pkg) in enumerate(zip(values, packages)):
            if isinstance(value, (int, float)):
                ax.text(
                    xi, value + max_v * 0.035, fmt(value),
                    va="bottom", ha="center", fontsize=8.2, color=theme["ink"],
                    fontweight="bold" if pkg["label"] == ACCENT_LABEL else "normal",
                )
            else:
                ax.text(
                    xi, max_v * 0.04, "import\nfailed",
                    va="bottom", ha="center", fontsize=7, color=theme["muted"], style="italic",
                )

    generated = datetime.fromisoformat(data["generatedAt"].replace("Z", "+00:00"))
    date = generated.astimezone(timezone.utc).strftime("%Y-%m-%d")
    line1 = (
        f"npm install {data['method']['installFlags']} · node {data['node']} · npm {data['npm']} · "
        f"{data['platform']}-{data['arch']} · {date}"
    )
    line2 = (
        f"cold import = fresh Node process, warm OS file cache, median of "
        f"{data['method']['importRuns']} runs · reproduce: python bench/measure.py && "
        f"python bench/chart.py"
    )
    fig.text(0.03, 0.042, line1, fontsize=7, color=theme["muted"], ha="left")
    fig.text(0.03, 0.016, line2, fontsize=7, color=theme["muted"], ha="left")

    ASSETS.mkdir(exist_ok=True)
    out = ASSETS / theme["file"]
    fig.savefig(out, facecolor=theme["surface"])
    plt.close(fig)
    print(f"wrote {out}")


def main() -> None:
    data = json.loads(RESULTS.read_text(encoding="utf-8"))
    for theme in THEMES.values():
        render(theme, data)


if __name__ == "__main__":
    main()
