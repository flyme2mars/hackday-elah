Pulled `origin/main` before the audit. Baseline: `8fdf4ad`, after #25.

Prioritized findings:

| Priority | Symptom / likely cause | Fix and rough effort | Disposition |
| --- | --- | --- | --- |
| P0 with large video catalogs | Off-screen media loads compete with visible clips. A 300-card admission check had 6 visible cards, 600 created video elements and 600 held requests. Both thumbnail metadata and eager SDK imports run across the whole list. | Visible-card preparation, bounded import concurrency and shared in-flight imports. Half to one day including drag/upload checks. | Won't do for this hackathon change. Keep normal search limits and avoid bulk imports in the demo. |
| P1 | Command typing rerenders all media cards because the shell recreates callback props. | Memoized MediaPanel with stable callbacks. Roughly one hour including verification. | Implemented on `perf/26-editor-audit`. |
| P1, Mac check needed | A headless Linux export exceeded the 30-second audit deadline. Software rendering/throttling may contribute; the cause is not isolated. | Profile worker and encoder progress on the M2. One to two hours. | Won't change export for the hackathon without Mac confirmation. |
| P2 | Motion sampling reparses/sorts keys across all clips; Preview bounds observation may trigger unnecessary layout reads. Neither was a demonstrated bottleneck in this short edit. | Profile a large real timeline before caching motion or narrowing observation. Two hours to one day. | Deferred. |
| P2 | Session caches and unwindowed media lists can retain substantial media. No leak demonstrated here. | Measure browser/GPU memory with distinct files before adding eviction. Roughly one day. | Deferred. |

Measured result: a 52-character typing sequence with 300 rendered cards fell
from median **1,770.8 ms** (range 1,751.1–2,291.7) to **1,178.8 ms**
(1,110.4–1,347.1). Five alternating production-build trials per side, 4x CPU
throttle, Chrome 155 on Linux. This includes automation and paint waits, not
INP. With 12 cards, medians were 1,192.3 and 1,114.9 ms. Separate CPU profiles
support the React reconciliation diagnosis. All timing trials had zero page
errors and HTTP failures.

The 300-card case is a synthetic UI stress test, beyond normal `k <= 12`
searches. It uses a shared, prewarmed sample URL to isolate React work. The
admission check deliberately holds responses and does not time successful
imports. Search/edit/scrub ranges overlap; no speed claim for those paths or
for export or memory. These are not M2 measurements.

Full methods, caveats, raw results and rerunnable scripts are in
`docs/performance-audit-26.md`, `docs/performance/`,
`tests/performance-audit.mjs`, and `tests/media-admission-audit.mjs` on the audit
branch. Planner, embeddings and paid APIs are unchanged.
