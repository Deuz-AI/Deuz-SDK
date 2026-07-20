#!/usr/bin/env python3
"""Fresh install-footprint benchmark for the TypeScript AI SDKs (stdlib-only).

For each package: npm-install into a clean temp dir, measure installed size,
package count, file count, and cold ESM import time (median of N runs).
Writes bench/results.json. Reproducible: python bench/measure.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PACKAGES = [
    "@deuz-sdk/core",
    "ai",
    "@mastra/core",
    "langchain",
    "llamaindex",
    "@openai/agents",
]

IMPORT_RUNS = 5


def run(cmd, cwd=None, timeout=900):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, shell=True)


def dir_stats(root):
    total = 0
    files = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for f in filenames:
            files += 1
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total, files


def package_count(nm):
    count = 0
    try:
        for entry in os.scandir(nm):
            if not entry.is_dir():
                continue
            if entry.name.startswith("@"):
                for sub in os.scandir(entry.path):
                    if sub.is_dir():
                        count += 1
            else:
                count += 1
    except OSError:
        pass
    return count


def import_time_ms(pkg_dir, pkg_name):
    script = (
        "const t = performance.now();"
        f"await import('{pkg_name}');"
        "console.log(Math.round((performance.now() - t) * 10) / 10);"
    )
    times = []
    for i in range(IMPORT_RUNS + 1):  # first run = warmup (fs cache)
        proc = run(f'node --input-type=module -e "{script}"', cwd=pkg_dir, timeout=120)
        if proc.returncode != 0:
            print(f"    import FAILED for {pkg_name}: {proc.stderr.strip()[:200]}")
            return None
        try:
            ms = float(proc.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            print(f"    unparseable import output for {pkg_name}: {proc.stdout!r}")
            return None
        if i > 0:
            times.append(ms)
    times.sort()
    return times[len(times) // 2]


def main():
    results = []
    for pkg in PACKAGES:
        print(f"[{pkg}] installing…", flush=True)
        tmp = tempfile.mkdtemp(prefix="deuz-bench-")
        try:
            t0 = time.time()
            proc = run(f'npm init -y >NUL 2>&1 & npm install {pkg} --no-audit --no-fund --loglevel=error', cwd=tmp)
            if proc.returncode != 0:
                print(f"  npm install FAILED: {proc.stderr.strip()[:300]}")
                continue
            nm = os.path.join(tmp, "node_modules")
            size_bytes, files = dir_stats(nm)
            pkgs = package_count(nm)
            print(f"  {size_bytes / 1e6:.1f} MB, {pkgs} pkgs, {files} files — timing import…", flush=True)
            ms = import_time_ms(tmp, pkg)
            version = "?"
            try:
                with open(os.path.join(nm, pkg, "package.json"), encoding="utf-8") as fh:
                    version = json.load(fh)["version"]
            except OSError:
                pass
            results.append({
                "name": pkg,
                "version": version,
                "installMB": round(size_bytes / 1e6, 2),
                "packageCount": pkgs,
                "fileCount": files,
                "importMsMedian": ms,
                "installSeconds": round(time.time() - t0, 1),
            })
            print(f"  -> import {ms} ms (median of {IMPORT_RUNS})", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    out = os.path.join(os.path.dirname(__file__), "results.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({
            "benchmark": "install-footprint",
            "date": time.strftime("%Y-%m-%d"),
            "machine": f"{os.name}-py{sys.version_info.major}.{sys.version_info.minor}-node{subprocess.check_output('node --version', shell=True, text=True).strip()}",
            "procedure": "npm install <pkg> into a clean temp dir; node_modules size/pkg/file counts; cold ESM import median of 5 (1 warmup)",
            "results": results,
        }, fh, indent=2)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
