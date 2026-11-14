# Turns run.sh's log into a history entry ("b", the build measured) and, with -c, a paired comparison against "a";
# "r" is the machine reference (tools/perf/reference).
import datetime, json, sys

log, history, save, commit, quality, label, base, ref = sys.argv[1:]
runs, meta = {"a": {}, "b": {}, "r": {}}, {}
for line in open(log):
    tag, day, kind, *rest = line.rstrip("\n").split(" ", 3)
    if kind != "RESULT":
        continue
    r = json.loads(rest[0])
    meta = {k: r.pop(k) for k in ("gpuName", "method", "width", "height")}
    runs[tag].setdefault(day, []).append(r)


def median(a):
    s = sorted(a)
    k = len(s) // 2
    return s[k] if len(s) % 2 else (s[k - 1] + s[k]) / 2


def summarize(rs):
    out = {"quality": rs[0]["quality"], "repeats": len(rs)}
    for m in ("gpu", "cpu", "stillGpu", "stillCpu"):
        meds = [r[m]["med"] for r in rs]
        out[m] = {"med": median(meds), "p90": median([r[m]["p90"] for r in rs]), "min": min(meds), "max": max(meds),
                  "n": sum(r[m]["n"] for r in rs), "runs": meds}
    for m in ("passes", "stillPasses"):
        labels = {k for r in rs for k in r.get(m, {})}
        out[m] = {k: median([r.get(m, {}).get(k, 0) for r in rs]) for k in labels}
    return out


PASSES = ["shadow", "prepass", "gi", "shadowMask", "main", "motion", "dof", "bloom", "post", "other"]


def breakdown(days, key="passes"):
    if not any(r.get(key) for r in days.values()):
        return
    print(f"GPU ms per pass ({'animating' if key == 'passes' else 'paused'}), median")
    print(f"{'day':>4} " + " ".join(f"{p:>10}" for p in PASSES) + f" {'sum':>7}")
    for d, r in days.items():
        ps = dict(r.get(key, {}))
        for k in [k for k in ps if "." in k]:
            ps[k.split(".")[0]] = ps.get(k.split(".")[0], 0) + ps.pop(k)
        print(f"{d:>4} " + " ".join(f"{ps[p]:>10.2f}" if ps.get(p) else f"{'·':>10}" for p in PASSES) + f" {sum(ps.values()):>7.2f}")
    stages = sorted({k for r in days.values() for k in r.get(key, {}) if "." in k})
    if stages:
        print("GPU ms per stage (included in the passes above)")
        print(f"{'day':>4} " + " ".join(f"{k:>18}" for k in stages))
        for d, r in days.items():
            ps = r.get(key, {})
            print(f"{d:>4} " + " ".join(f"{ps[k]:>18.2f}" if ps.get(k) else f"{'·':>18}" for k in stages))


days = {d: summarize(rs) for d, rs in runs["b"].items()}
baseDays = {d: summarize(rs) for d, rs in runs["a"].items()}
refDays = {d: summarize(rs)["gpu"]["med"] for d, rs in runs["r"].items()}

if baseDays:
    # Paired: each repeat of the new build against the base measured right next to it.
    print(f"{commit} vs {base}: GPU ms per frame, median over paired runs")
    print(f"{'day':>4} {'base':>7} {'new':>7} {'Δ live':>9} {'per pair':>18} {'still base':>11} {'still new':>10} {'Δ still':>9}")
    for d, b in days.items():
        a = baseDays.get(d)
        if not a:
            continue
        pairs = [y / x - 1 for x, y in zip(a["gpu"]["runs"], b["gpu"]["runs"]) if x]
        noise = not pairs or min(pairs) < 0 < max(pairs)
        per = "/".join(f"{p * 100:+.0f}" for p in pairs) + "%"
        sa, sb = a["stillGpu"]["med"], b["stillGpu"]["med"]
        print(f"{d:>4} {a['gpu']['med']:>7.2f} {b['gpu']['med']:>7.2f} {median(pairs) * 100:>+8.1f}%{'~' if noise else ' '}"
              f"{per:>18} {sa:>11.2f} {sb:>10.2f} {(sb / sa - 1) * 100 if sa else 0:>+8.1f}%")
    print("~ = the pairs disagree on the direction (noise)")
else:
    print(f"{'day':>4} {'gpu ms':>8} {'range':>13} {'p90':>7} {'cpu ms':>7} {'still gpu':>10}")
    for d, r in days.items():
        g = r["gpu"]
        print(f"{d:>4} {g['med']:>8.2f} {g['min']:>6.2f}–{g['max']:<6.2f} {g['p90']:>7.2f} {r['cpu']['med']:>7.2f} {r['stillGpu']['med']:>10.2f}")
breakdown(days)
print(f"{meta.get('gpuName')} · {meta.get('method')} · {meta.get('width')}x{meta.get('height')} · {quality} · {commit}")

entry = {"date": datetime.datetime.now().isoformat(timespec="seconds"), "commit": commit, "label": label,
         "quality": quality, "repeats": max((len(r) for r in runs["b"].values()), default=0), **meta, "days": days}
if baseDays:
    entry["base"] = {"commit": base, "days": baseDays}
if refDays:
    # The machine's speed this session: the reference days' mean GPU ms at the reference commit.
    entry["machine"] = {"commit": ref, "days": refDays, "score": sum(refDays.values()) / len(refDays)}
    print(f"machine reference ({ref}): " + ", ".join(f"day {d} {v:.2f}" for d, v in refDays.items()) + f" · score {entry['machine']['score']:.3f}")
if save == "1" and days:
    with open(history, "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"saved to {history}")
