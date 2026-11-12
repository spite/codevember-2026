#!/bin/bash
# Visual regression check for shared-module changes: renders each day from a git ref ("old") and from the working
# tree ("new"), then old again ("old2") to measure the day's own run-to-run noise, and diffs them (diff.py).
#
#   tools/regress/run.sh [-r REF] [-o OUTDIR] [-q QUALITY] [DAY...]
#
# REF defaults to HEAD, DAY to every published day, QUALITY to high. Both builds are copies in OUTDIR, so the
# working tree is never touched. In each copy common.js runs on a fixed 1/60 s step (performance.now() too) and pauses
# itself on frame 600; the harness then captures the default view and one at half the camera distance. WSL + Windows Chrome.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REF=HEAD
OUT="${TMPDIR:-/tmp}/codevember-regress"
QUALITY=high
while getopts "r:o:q:" opt; do
  case $opt in
    r) REF=$OPTARG ;;
    o) OUT=$OPTARG ;;
    q) QUALITY=$OPTARG ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))
DAYS=("$@")
if [ ${#DAYS[@]} -eq 0 ]; then
  read -ra DAYS <<<"$(grep -oP 'const published = \[\K[^\]]*' "$REPO/modules/days.js" | tr -d ',')"
fi

CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="claude-regress-$$"
PATHS=(modules shaders third_party assets css "${DAYS[@]}")

case "$OUT" in /|/tmp|"$HOME"|"$REPO"*) echo "refusing OUTDIR $OUT" >&2; exit 1 ;; esac
rm -rf "${OUT:?}/old" "${OUT:?}/new" "${OUT:?}/shots"
mkdir -p "$OUT/old" "$OUT/new" "$OUT/shots"
: >"$OUT/log.txt"

echo "old: $REF"
git -C "$REPO" archive "$REF" -- "${PATHS[@]}" | tar -x -C "$OUT/old"
# Untracked files (local assets) go in both, so only tracked changes since REF differ.
(cd "$REPO" && git ls-files -o --exclude-standard -- "${PATHS[@]}" | tar -cf - -T -) | tar -x -C "$OUT/old"
echo "new: working tree"
(cd "$REPO" && git ls-files -co --exclude-standard -- "${PATHS[@]}" | tar -cf - -T -) | tar -x -C "$OUT/new"

python3 - "$OUT/old" "$OUT/new" "${DAYS[@]}" <<'EOF'
import re, sys
roots, days = sys.argv[1:3], sys.argv[3:]
def rep(path, old, new):
    s = open(path, encoding="utf8").read()
    if s.count(old) != 1:
        sys.exit(f"regress: can't patch {path}: {old.strip()[:60]!r}")
    open(path, "w", encoding="utf8").write(s.replace(old, new))
for root in roots:
    common = f"{root}/modules/common.js"
    rep(common, "const dt = running ? Maf.clamp(timer.getDelta(), 0, 0.1) : 0;", "timer.getDelta();\n    const dt = running ? 1 / 60 : 0;\n    __clock.base ??= __clock.now();\n    if (running) __clock.frames += 1;")
    rep(common, "    fn({ time, dt, frame });\n", "    fn({ time, dt, frame });\n    window.__afterRender?.();\n    if (frame === 600) setRunning(false);\n")
    # From the first frame on, performance.now() follows the fixed step too, so wall-clock animation repeats.
    s = open(common, encoding="utf8").read()
    s = "const __clock = { now: performance.now.bind(performance), base: null, frames: 0 };\nperformance.now = () => (__clock.base === null ? __clock.now() : __clock.base + (__clock.frames * 1000) / 60);\n" + s
    open(common, "w", encoding="utf8").write(s)
    with open(common, "a", encoding="utf8") as f:
        f.write("\nwindow.__regress = { setRunning, isRunning, camera, controls, frame: () => frame };\n")
    for day in days:
        page = f"{root}/{day}/index.html"
        s = open(page, encoding="utf8").read()
        s2 = re.sub(r'(<script type="module" src="main\.js"></script>)', r'<script src="/__harness.js"></script>\1', s, count=1)
        if s2 == s:
            sys.exit(f"regress: no main.js script in {page}")
        open(page, "w", encoding="utf8").write(s2)
EOF
cp "$REPO/tools/regress/harness.js" "$OUT/old/__harness.js"
cp "$REPO/tools/regress/harness.js" "$OUT/new/__harness.js"

reap() {
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*user-data-dir=C:\\Temp\\$PROFILE*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
}
python3 "$REPO/tools/regress/serve.py" "$OUT/old" 8781 "$OUT/shots" "$OUT/log.txt" &
OLD_SRV=$!
python3 "$REPO/tools/regress/serve.py" "$OUT/new" 8782 "$OUT/shots" "$OUT/log.txt" &
NEW_SRV=$!
cleanup() {
  kill "$OLD_SRV" "$NEW_SRV" 2>/dev/null || true
  reap
  rm -rf "/mnt/c/Temp/$PROFILE"
}
trap cleanup EXIT
sleep 1

# One headless run at a time, so the builds never contend for the GPU.
for day in "${DAYS[@]}"; do
  for run in old:8781 new:8782 old2:8781; do
    tag=${run%%:*}
    port=${run##*:}
    reap
    "$CHROME" --headless=new --user-data-dir="C:\\Temp\\$PROFILE" --mute-audio --use-angle=d3d11 --window-size=1280,800 \
      "http://localhost:$port/$day/?seed=regress&quality=$QUALITY&dpr=1&auto=false&tag=$tag" >/dev/null 2>&1 &
    for _ in $(seq 1 900); do
      grep -q "^$tag $day END" "$OUT/log.txt" && break
      sleep 1
    done
    grep "^$tag $day " "$OUT/log.txt" | grep -v " END$" || true
    echo "day $day: $tag done"
  done
done

python3 "$REPO/tools/regress/diff.py" "$OUT/shots"
echo "side-by-sides: $OUT/shots/*-cmp.jpg"
