#!/usr/bin/env python3
# Shows how the numbers in tools/perf/history.jsonl evolve: one row per day, one column per run (oldest first).
#   tools/perf/report.py [-m gpu|cpu|stillGpu|stillCpu|pass:NAME] [-q QUALITY] [-k LAST_N] [--raw] [--vs-base]
# GPU numbers are scaled to the newest run's machine speed (its reference days, see tools/perf/reference), so runs from
# different sessions compare; --raw shows them as measured. --vs-base shows each paired run (-c) against its own base.
import argparse, json, os

ap = argparse.ArgumentParser()
ap.add_argument("-m", "--metric", default="gpu", help="gpu, cpu, stillGpu, stillCpu, or pass:NAME (e.g. pass:gi)")
ap.add_argument("-q", "--quality", default="high")
ap.add_argument("-k", "--last", type=int, default=8)
ap.add_argument("--raw", action="store_true", help="don't scale to a common machine speed")
ap.add_argument("--vs-base", action="store_true", help="each paired run's change against its own base")
args = ap.parse_args()

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history.jsonl")
runs = [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
runs = [r for r in runs if r["quality"] == args.quality][-args.last:]
if not runs:
    raise SystemExit("no runs recorded yet: tools/perf/run.sh")


def stat(r, d, days_key="days"):
    day = r.get(days_key, {}).get(d) if days_key == "days" else r.get("base", {}).get("days", {}).get(d)
    if not day:
        return None
    if args.metric.startswith("pass:"):
        v = day.get("passes", {}).get(args.metric[5:])
        return {"med": v} if v is not None else None
    return day.get(args.metric)


days = sorted({d for r in runs for d in r["days"]}, key=lambda d: int(d) if d.isdigit() else 999)
heads = [f"{r['commit']}{' ' + r['label'] if r['label'] else ''}"[:24] for r in runs]
gpuMetric = args.metric != "cpu" and args.metric != "stillCpu"

if args.vs_base:
    paired = [(h, r) for h, r in zip(heads, runs) if "base" in r]
    if not paired:
        raise SystemExit("no paired runs (run.sh -c BASE) in range")
    print(f"{args.metric}: change against each run's own base (measured alongside it)")
    print(f"{'day':>4} " + " ".join(f"{h:>24}" for h, _ in paired))
    for d in days:
        cells = []
        for _, r in paired:
            a, b = stat(r, d, "base"), stat(r, d)
            cells.append(f"{(b['med'] / a['med'] - 1) * 100:>+23.1f}%" if a and b and a["med"] else f"{'–':>24}")
        print(f"{d:>4} " + " ".join(cells))
    print("bases: " + ", ".join(f"{h}: {r['base']['commit']}" for h, r in paired))
    raise SystemExit

# Scale factor per run: newest machine score over the run's own; runs without a reference stay raw (marked *).
target = next((r["machine"]["score"] for r in reversed(runs) if "machine" in r), None)
scale = [1.0 if args.raw or not gpuMetric or target is None or "machine" not in r else target / r["machine"]["score"] for r in runs]
unscaled = [not args.raw and gpuMetric and target is not None and "machine" not in r for r in runs]

print(f"{args.metric} median ms, {args.quality} quality, {runs[-1]['width']}x{runs[-1]['height']}"
      + ("" if args.raw or not gpuMetric or target is None else ", scaled to the newest run's machine speed"))
print(f"{'day':>4} " + " ".join(f"{h + ('*' if u else ''):>24}" for h, u in zip(heads, unscaled)) + f" {'Δ first→last':>13}")
for d in days:
    stats = [stat(r, d) for r in runs]
    stats = [{k: v * f for k, v in s.items() if k in ("med", "min", "max")} if s else None for s, f in zip(stats, scale)]
    cells = " ".join(f"{s['med']:>24.2f}" if s else f"{'–':>24}" for s in stats)
    seen = [s for s in stats if s]
    delta = ""
    if len(seen) > 1 and seen[0]["med"]:
        a, b = seen[0], seen[-1]
        # Runs with repeats keep the range of their per-run medians; overlapping ranges are within the noise.
        noise = "min" in a and "min" in b and a["min"] <= b["max"] and b["min"] <= a["max"]
        delta = f"{(b['med'] / a['med'] - 1) * 100:+.1f}%{' ~' if noise else '  '}"
    print(f"{d:>4} {cells} {delta:>13}")
print(f"{'mach':>4} " + " ".join(f"{r['machine']['score']:>24.3f}" if "machine" in r else f"{'–':>24}" for r in runs) + "  (reference score)")
print("~ = the first and last runs' ranges overlap (noise); ranges need -x ≥ 2")
if any(unscaled):
    print("* = no machine reference in that run: shown as measured")
print("dates: " + ", ".join(f"{h}={r['date'][:16]}" for h, r in zip(heads, runs)))
