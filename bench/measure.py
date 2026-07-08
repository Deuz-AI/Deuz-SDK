#!/usr/bin/env python3
"""Package-footprint benchmark: installs each pinned SDK into an isolated temp
project and measures what `npm install <pkg>` really costs.

Metrics (all reproducible, no API keys, no network beyond npm):
  1. install footprint — logical bytes under node_modules (decimal MB, npm convention)
  2. installed packages — entries in node_modules/.package-lock.json
  3. files on disk — regular files under node_modules
  4. cold import — median of 7 fresh-process `await import(pkg)` runs (1 discarded warmup)

`--ignore-scripts` is used for safety; postinstall scripts can only ADD bytes,
so skipping them is conservative in the competitors' favor.

Usage: python bench/measure.py   ->  writes bench/results.json
Requires: Python 3.11+ (stdlib only) and Node >= 22 + npm on PATH.
"""

import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

PACKAGES = [
    {"label": "@deuz-sdk/core", "spec": "@deuz-sdk/core@1.5.0", "importId": "@deuz-sdk/core"},
    {"label": "ai (Vercel AI SDK)", "spec": "ai@7.0.17", "importId": "ai"},
    {"label": "@mastra/core", "spec": "@mastra/core@1.50.1", "importId": "@mastra/core"},
    {"label": "langchain", "spec": "langchain@1.5.2", "importId": "langchain"},
    {"label": "llamaindex", "spec": "llamaindex@0.12.1", "importId": "llamaindex"},
    {"label": "@openai/agents", "spec": "@openai/agents@0.13.0", "importId": "@openai/agents"},
]

IMPORT_RUNS = 7
INSTALL_TIMEOUT_S = 600
IS_WINDOWS = platform.system() == "Windows"


def run_npm(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    # npm is npm.cmd on Windows, which must run through a shell. All args are
    # static strings from PACKAGES (no spaces/metacharacters), so joining them
    # into one command line is safe.
    if IS_WINDOWS:
        return subprocess.run(
            " ".join(["npm", *args]), shell=True, cwd=cwd, capture_output=True,
            text=True, timeout=INSTALL_TIMEOUT_S,
        )
    return subprocess.run(
        ["npm", *args], cwd=cwd, capture_output=True, text=True, timeout=INSTALL_TIMEOUT_S,
    )


def walk_node_modules(root: Path) -> tuple[int, int]:
    """Sum logical bytes and count regular files, skipping symlinks/junctions."""
    total_bytes = 0
    total_files = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue  # avoid double counting links/junctions
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    total_bytes += entry.stat(follow_symlinks=False).st_size
                    total_files += 1
            except OSError:
                continue  # unreadable entry — skip
    return total_bytes, total_files


def count_installed_packages(project_dir: Path) -> tuple[int, str]:
    lock_path = project_dir / "node_modules" / ".package-lock.json"
    raw = lock_path.read_bytes()
    lock = json.loads(raw)
    count = len([k for k in lock.get("packages", {}) if k != ""])
    return count, hashlib.sha256(raw).hexdigest()


def resolved_version(project_dir: Path, import_id: str) -> str | None:
    pkg_json = project_dir.joinpath("node_modules", *import_id.split("/"), "package.json")
    try:
        return json.loads(pkg_json.read_text(encoding="utf-8")).get("version")
    except OSError:
        return None


def cold_import_once(project_dir: Path, import_id: str) -> dict:
    snippet = (
        "const t0 = performance.now(); "
        f"try {{ await import({json.dumps(import_id)}); "
        "console.log('##BENCH##' + JSON.stringify({ ok: true, ms: performance.now() - t0 })); } "
        "catch (e) { console.log('##BENCH##' + JSON.stringify("
        "{ ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) })); }"
    )
    res = subprocess.run(
        ["node", "--no-warnings", "--input-type=module", "-e", snippet],
        cwd=project_dir, capture_output=True, text=True, timeout=120,
    )
    marker = next(
        (line for line in reversed(res.stdout.splitlines()) if "##BENCH##" in line), None
    )
    if marker is None:
        return {
            "ok": False,
            "error": f"no marker line (status {res.returncode}): {res.stderr[:200]}",
        }
    return json.loads(marker[marker.index("##BENCH##") + len("##BENCH##"):])


def rmtree_with_retries(path: Path, attempts: int = 5) -> None:
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except OSError as err:
            if attempt == attempts - 1:
                print(f"  cleanup warning for {path}: {err}", file=sys.stderr)
                return
            time.sleep(0.25 * (attempt + 1))  # Windows AV/EBUSY needs a beat


def measure_package(pkg: dict) -> dict:
    print(f"\n=== {pkg['label']} ({pkg['spec']}) ===", flush=True)
    project_dir = Path(tempfile.mkdtemp(prefix="deuz-bench-"))
    result = {
        "label": pkg["label"],
        "spec": pkg["spec"],
        "importId": pkg["importId"],
        "resolvedVersion": None,
        "installOk": False,
        "installError": None,
        "installBytes": 0,
        "installMB": 0,
        "packageCount": 0,
        "fileCount": 0,
        "importOk": False,
        "importMsMedian": None,
        "importMsRuns": [],
        "importError": None,
        "lockfileSha256": None,
    }
    try:
        # A local package.json is mandatory: without it npm walks UP the tree
        # and installs into whatever project contains the temp dir's parent.
        (project_dir / "package.json").write_text(
            json.dumps({"name": "bench", "private": True, "version": "0.0.0", "type": "module"})
            + "\n",
            encoding="utf-8",
        )

        install_args = [
            "install", pkg["spec"], "--no-audit", "--no-fund", "--ignore-scripts",
            "--loglevel=error", "--progress=false",
        ]
        install = run_npm(install_args, str(project_dir))
        if install.returncode != 0:
            print(f"  install failed once, retrying: {install.stderr[:200]}", file=sys.stderr)
            install = run_npm(install_args, str(project_dir))
        if install.returncode != 0:
            result["installError"] = (install.stderr or "unknown npm failure")[:500]
            print(f"  INSTALL FAILED: {result['installError']}", file=sys.stderr)
            return result
        result["installOk"] = True
        result["resolvedVersion"] = resolved_version(project_dir, pkg["importId"])

        result["installBytes"], result["fileCount"] = walk_node_modules(
            project_dir / "node_modules"
        )
        result["installMB"] = round(result["installBytes"] / 1e6, 2)
        result["packageCount"], result["lockfileSha256"] = count_installed_packages(project_dir)
        print(
            f"  {result['installMB']} MB · {result['packageCount']} packages · "
            f"{result['fileCount']} files · v{result['resolvedVersion']}",
            flush=True,
        )

        warmup = cold_import_once(project_dir, pkg["importId"])
        if not warmup.get("ok"):
            result["importError"] = warmup.get("error")
            print(f"  IMPORT FAILED: {result['importError']}", file=sys.stderr)
            return result
        runs: list[float] = []
        for i in range(IMPORT_RUNS):
            run = cold_import_once(project_dir, pkg["importId"])
            if not run.get("ok"):
                result["importError"] = run.get("error")
                print(f"  IMPORT FAILED on run {i + 1}: {result['importError']}", file=sys.stderr)
                return result
            runs.append(round(run["ms"], 1))
        result["importOk"] = True
        result["importMsRuns"] = runs
        result["importMsMedian"] = round(statistics.median(runs), 1)
        print(f"  cold import median {result['importMsMedian']} ms (runs: {runs})", flush=True)
        return result
    finally:
        rmtree_with_retries(project_dir)


def main() -> None:
    npm_version = run_npm(["--version"], os.getcwd()).stdout.strip() or "unknown"
    node_version = subprocess.run(
        ["node", "--version"], capture_output=True, text=True
    ).stdout.strip()
    packages = [measure_package(pkg) for pkg in PACKAGES]
    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "node": node_version,
        "npm": npm_version,
        "platform": {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}.get(
            platform.system(), platform.system().lower()
        ),
        "arch": platform.machine().lower().replace("amd64", "x64").replace("x86_64", "x64"),
        "method": {
            "installFlags": "--no-audit --no-fund --ignore-scripts",
            "importRuns": IMPORT_RUNS,
            "importWarmupRuns": 1,
            "sizeConvention": "logical bytes under node_modules, decimal MB",
            "packageCountSource": "node_modules/.package-lock.json",
            "note": (
                "bare-package installs; --ignore-scripts skips postinstalls, which can only "
                "add bytes (conservative in competitors favor)"
            ),
        },
        "packages": packages,
    }
    out_path = Path(__file__).resolve().parent / "results.json"
    out_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
