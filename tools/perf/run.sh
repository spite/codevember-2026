#!/bin/bash
# Performance tracking: benchmarks each day headlessly (GPU and CPU time per frame, animating and settled) and appends
# one entry to tools/perf/history.jsonl. `tools/perf/report.py` shows how the numbers evolve.
#
#   tools/perf/run.sh [-r REF] [-c BASE] [-q QUALITY] [-l LABEL] [-x REPEATS] [-n] [DAY...]
#
# REF (a git ref or a directory holding a copy of the tree) defaults to the working tree, DAY to every published day, QUALITY to high, REPEATS to 3 (each day is loaded that
# many times; the entry keeps the median and the range of the per-run medians). -n prints without saving.
# -c BASE also measures BASE (a git ref, or a directory holding a copy of the tree), alternating the two builds day by day so GPU clock drift hits both alike, and
# prints the paired difference; only REF's entry is saved. Use it to judge a change; the history is the long-term trend.
# Every run also measures the days in tools/perf/reference at its fixed commit, interleaved with the others: the
# machine's speed that session, which report.py uses to compare entries from different sessions.
# Each build is a copy in the scratch dir with common.js on a fixed 1/60 s step, so every run times the same frames.
# WSL + Windows Chrome.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REF=""
BASE=""
QUALITY=high
LABEL=""
SAVE=1
REPEATS=3
while getopts "r:c:q:l:x:n" opt; do
  case $opt in
    r) REF=$OPTARG ;;
    c) BASE=$OPTARG ;;
    q) QUALITY=$OPTARG ;;
    l) LABEL=$OPTARG ;;
    x) REPEATS=$OPTARG ;;
    n) SAVE=0 ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))
DAYS=("$@")
if [ ${#DAYS[@]} -eq 0 ]; then
  read -ra DAYS <<<"$(grep -oP 'const published = \[\K[^\]]*' "$REPO/modules/days.js" | tr -d ',')"
fi

CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="claude-perf-$$"
OUT="${TMPDIR:-/tmp}/codevember-perf-$$"
PORT=$((8790 + $$ % 40 * 3))
PATHS=(modules shaders third_party assets css "${DAYS[@]}")
mkdir -p "$OUT"
: >"$OUT/log.txt"

# build DIR REF [DAY...]: the tracked files at REF (empty: the working tree) plus untracked local assets, patched for
# timing. DAY defaults to the days being measured.
build() {
  local dir=$1 ref=$2
  shift 2
  local days=("$@")
  [ ${#days[@]} -eq 0 ] && days=("${DAYS[@]}")
  local PATHS=(modules shaders third_party assets css "${days[@]}")
  set -- "$dir" "$ref"
  mkdir -p "$1"
  if [ -n "$2" ] && [ -d "$2" ]; then
    (cd "$2" && tar -cf - "${PATHS[@]}") | tar -x -C "$1"
  elif [ -n "$2" ]; then
    git -C "$REPO" archive "$2" -- "${PATHS[@]}" | tar -x -C "$1"
    (cd "$REPO" && git ls-files -o --exclude-standard -- "${PATHS[@]}" | tar -cf - -T -) | tar -x -C "$1"
  else
    (cd "$REPO" && git ls-files -co --exclude-standard -- "${PATHS[@]}" | tar -cf - -T -) | tar -x -C "$1"
  fi
  cp "$REPO/tools/perf/harness.js" "$1/__harness.js"
  python3 "$REPO/tools/perf/patch.py" "$1" "${days[@]}"
}
build "$OUT/b" "$REF"
if [ -n "$REF" ] && [ -d "$REF" ]; then
  COMMIT=$(git -C "$REPO" rev-parse --short HEAD)+$(basename "$REF")
elif [ -n "$REF" ]; then
  COMMIT=$(git -C "$REPO" rev-parse --short "$REF")
else
  COMMIT=$(git -C "$REPO" rev-parse --short HEAD)
  git -C "$REPO" diff --quiet HEAD -- modules shaders "${DAYS[@]}" || COMMIT="$COMMIT+dirty"
fi
SITES=(b)
REF_COMMIT=$(awk '$1 == "commit" { print $2 }' "$REPO/tools/perf/reference")
read -ra REF_DAYS <<<"$(awk '$1 == "days" { $1 = ""; print }' "$REPO/tools/perf/reference")"
[ -z "${PERF_NO_REF:-}" ] && build "$OUT/r" "$REF_COMMIT" "${REF_DAYS[@]}"
BASE_COMMIT=""
if [ -n "$BASE" ]; then
  build "$OUT/a" "$BASE"
  if [ -d "$BASE" ]; then BASE_COMMIT=$(basename "$BASE"); else BASE_COMMIT=$(git -C "$REPO" rev-parse --short "$BASE"); fi
  SITES=(b a)
fi
# PERF_NO_REF=1 skips the machine reference (for throwaway experiment runs with -n).
[ -z "${PERF_NO_REF:-}" ] && SITES+=(r)

reap() {
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*user-data-dir=C:\\Temp\\$PROFILE*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
}
SRVS=()
for i in "${!SITES[@]}"; do
  python3 "$REPO/tools/regress/serve.py" "$OUT/${SITES[$i]}" $((PORT + i)) "$OUT" "$OUT/log.txt" &
  SRVS+=($!)
done
cleanup() {
  kill "${SRVS[@]}" 2>/dev/null || true
  reap
  rm -rf "/mnt/c/Temp/$PROFILE" "$OUT"
}
trap cleanup EXIT
sleep 1

# One page at a time: concurrent instances contend for the GPU. With -c the builds alternate, in swapped order on
# every other repeat.
# load SITE_INDEX DAY REP: one page load, waiting for its result.
load() {
  local i=$1 day=$2 rep=$3 tag=${SITES[$1]}
  reap
  "$CHROME" --headless=new --user-data-dir="C:\\Temp\\$PROFILE" --mute-audio --use-angle=d3d11 --window-size=1280,800 \
    --disable-gpu-vsync --disable-frame-rate-limit \
    "http://localhost:$((PORT + i))/$day/?seed=perf&quality=$QUALITY&dpr=1&auto=false&tag=$tag" >/dev/null 2>&1 &
  for _ in $(seq 1 600); do
    [ "$(grep -c "^$tag $day END" "$OUT/log.txt")" -ge "$rep" ] && break
    sleep 1
  done
  [ "$(grep -c "^$tag $day RESULT " "$OUT/log.txt")" -ge "$rep" ] || echo "day $day ($tag, run $rep): no result" >&2
}

# Each repeat starts with the reference days (the last site), then every day on the measured build(s).
R=$((${#SITES[@]} - 1))
[ -n "${PERF_NO_REF:-}" ] && R=${#SITES[@]}
for rep in $(seq 1 "$REPEATS"); do
  [ -z "${PERF_NO_REF:-}" ] && for day in "${REF_DAYS[@]}"; do load "$R" "$day" "$rep"; done
  for day in "${DAYS[@]}"; do
    order=($(seq 0 $((R - 1))))
    [ $((rep % 2)) -eq 0 ] && [ "$R" -eq 2 ] && order=(1 0)
    for i in "${order[@]}"; do load "$i" "$day" "$rep"; done
  done
done
grep -v " END$\| RESULT " "$OUT/log.txt" | sort -u || true
reap

python3 "$REPO/tools/perf/summarize.py" "$OUT/log.txt" "$REPO/tools/perf/history.jsonl" "$SAVE" "$COMMIT" "$QUALITY" "$LABEL" "$BASE_COMMIT" "$REF_COMMIT"
