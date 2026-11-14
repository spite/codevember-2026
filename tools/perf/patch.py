# Patches a build copy for run.sh: common.js on a fixed 1/60 s step with timing hooks, and the harness in each day.
import re, sys

root, days = sys.argv[1], sys.argv[2:]


def rep(path, old, new):
    s = open(path, encoding="utf8").read()
    if s.count(old) != 1:
        sys.exit(f"perf: can't patch {path}: {old.strip()[:60]!r}")
    open(path, "w", encoding="utf8").write(s.replace(old, new))


common = f"{root}/modules/common.js"
rep(common, "const dt = running ? Maf.clamp(timer.getDelta(), 0, 0.1) : 0;", "timer.getDelta();\n    const dt = running ? 1 / 60 : 0;\n    __clock.base ??= __clock.now();\n    if (running) __clock.frames += 1;")
rep(common, "    fn({ time, dt, frame });\n", "    window.__perf?.before?.();\n    fn({ time, dt, frame });\n    window.__perf?.after?.();\n")
s = open(common, encoding="utf8").read()
s = "const __clock = { now: performance.now.bind(performance), base: null, frames: 0 };\nperformance.now = () => (__clock.base === null ? __clock.now() : __clock.base + (__clock.frames * 1000) / 60);\n" + s
s += "\nwindow.__perf = { setRunning, frame: () => frame, before: null, after: null };\n"
open(common, "w", encoding="utf8").write(s)
for day in days:
    page = f"{root}/{day}/index.html"
    s = open(page, encoding="utf8").read()
    s2 = re.sub(r'(<script type="module" src="main\.js"></script>)', r'<script src="/__harness.js"></script>\1', s, count=1)
    if s2 == s:
        sys.exit(f"perf: no main.js script in {page}")
    open(page, "w", encoding="utf8").write(s2)
