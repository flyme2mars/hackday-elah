# Frame Flow performance audit, issue #26

The small media-panel change makes scripted command typing faster in this
controlled test. It does not establish faster search, editing, scrubbing, export,
or lower memory use. The main remaining scaling risk is unbounded media loading.

`git pull --ff-only origin main` completed before work began. The baseline is
`8fdf4ad`, which includes the split-selection and microphone changes from #25.
The candidate changes only `src/App.tsx` and `src/MediaPanel.tsx`: stable import,
placement and preparation callbacks let `React.memo` skip the media panel when
only command text, status or selection changes. No planner or operation code
changes.

## Findings ranked by impact

| Priority | Symptom and evidence | Likely cause | Suggested fix, effort and disposition |
| --- | --- | --- | --- |
| P0 at large catalogs | Off-screen videos compete with visible media for loading and decoder resources. A controlled 300-card admission probe had 6 cards visible, 300 thumbnail videos, 600 created video elements and 600 held media requests. | `MediaPanel` mounts every thumbnail with `preload="metadata"`. `EditorShell` also calls `ensureImported` for the whole result list. Concurrent imports can probe the same URL before the SDK registers it. | Prepare visible or nearby cards, bound background imports, and share in-flight imports. Then consider windowing the list. Rough effort: half to one day plus drag/upload regression checks. **Won't do for this hackathon change**: this needs a separate loading-policy change. Keep normal search limits and avoid bulk video imports in the demo. |
| P1, fixed here | Typing rerenders the media tree even when its assets have not changed. With 300 cards, a 52-character sequence took a median 1,770.8 ms before and 1,178.8 ms after. | The shell owns command text. Fresh callback props previously forced `MediaPanel` and every card through React reconciliation. Separate CPU samples showed media-panel work in the baseline and none sampled in the candidate. | Memoize the panel and stabilize its callbacks. Implemented on `perf/26-editor-audit`. Small change, roughly one hour including verification. |
| P1, requires Mac confirmation | A 4.5-second export did not report completion within the audit's 30-second deadline. This is a failed probe, not an export speed measurement. | The run uses headless Linux with software WebGL and CPU throttling. The cause is not isolated. `lazyExportVideo` already uses a worker, so a timeout alone does not prove a main-thread block. | Repeat on the M2 with desktop Chromium, inspect worker/encoder progress, and separate render from encode time. Rough effort: one to two hours for diagnosis. **Won't change export for the hackathon based on this Linux result.** |
| P2, profile before changing | Large animated timelines may allocate and repeat validation every frame. No demonstrated bottleneck in the short scene tested here. | `projectAtFrame` visits all clips. `readHostMotion` reads and sorts keys on each sample, including motion on inactive clips. | Profile a large real project on the Mac. Consider caching parsed motion by immutable clip identity and preserving source-frame behavior. Rough effort: one day with the cloud owner and export tests. Deferred. |
| P2, profile before changing | Crop/resize bounds checks can add layout work during preview updates. No demonstrated jank from this hook in the typing profile. | `usePreviewOverlayBounds` observes style changes throughout Preview and reads container geometry even when there is no toolbar. | Check for a toolbar before reading geometry, then narrow observation only if a scrub trace identifies this work as material. Rough effort: two hours with viewport-edge tests. Deferred. |
| P2, memory follow-up | Search and upload can retain asset entries and thumbnails for the session. This audit does not demonstrate a leak. | The host and SDK keep library, URL and media caches. The media panel has no list windowing. | Measure browser-process and GPU memory with many distinct local files, then define eviction for unused results without evicting timeline assets. Rough effort: one day. Deferred until a real memory problem is reproduced. |

The P0 classification is conditional on large video catalogs. Normal worker
searches cap `k` at 12. The 300-result fixture deliberately stresses the UI's
larger-list behavior; it is not a normal search response or a prediction of a
Downloads vault's performance.

## Measurements and limits

Both sides use Vite production builds with source maps, Chrome 155.0.8059.79,
1440 by 900 viewports and CDP CPU throttling at 4x on this 8-core Linux machine.
They run in fresh browser contexts, alternating baseline and candidate five
times each. Load averages observed during the audit ranged from about 1 to 6.
The runs share that background load. These are **not M2 measurements**.

| Rendered search cards | Baseline typing median, range | Candidate typing median, range |
| --- | --- | --- |
| 300, stress case | 1,770.8 ms, 1,751.1–2,291.7 | 1,178.8 ms, 1,110.4–1,347.1 |
| 12, typical result limit | 1,192.3 ms, 1,155.8–1,208.2 | 1,114.9 ms, 1,067.3–1,134.7 |

The primary result is about 33% less elapsed time for the 300-card scripted
typing sequence. This duration includes Playwright key dispatch and a final
two-frame paint wait. It is not INP or individual keystroke latency. The script
checks that all 52 characters appear in the command field. Neither side
recorded a task longer than 50 ms during the typing phases.

Separate diagnostic CPU profiles identify React reconciliation as the removable
work. Source-mapped sampled self-time in `react-dom-client.production.js` was
about 672 ms in the baseline and 195 ms in the candidate. The baseline also
sampled about 50 ms in `MediaPanel.tsx`; the candidate had no samples there.
Those profiles are diagnostic runs with profiler overhead, not the reported
five-run timing comparison. Browser input dispatch, the remaining editor tree
and automation overhead limit further gains from this particular change.

All catalog entries share one prewarmed real sample URL and a small SVG thumbnail
in the timing comparison. This isolates card reconciliation from distinct-file
I/O and decoder pressure. The script makes a real initial import, waits until
every card is drag-ready, and forces GC before the typing phase to capture a
comparable JS heap snapshot. It verifies command request counts, resulting clip
counts, the two selected split halves, final typed text, page errors and HTTP
failures. All 20 timing trials recorded zero page errors and HTTP failures.
Planner responses are local fixtures; no cloud latency is measured.

Search, placement, split, transform, motion and scrub timings include browser
automation, the mocked command round trip where applicable, and paint waits.
Their before/after ranges overlap. There is no justified speed claim for them.
The three-clip scene does not establish long-timeline throughput. Trim was not
separately timed. RAF averages under software WebGL are not reported as native
preview FPS.

The 300-card post-GC JS heaps were approximately 7.53–7.60 MiB before and 7.55 MiB
after. These are main-page JS heap snapshots, not browser-process, decoded-media
or GPU memory. The change does not claim memory savings.

The media-admission check deliberately holds media responses. Its 600 requests
demonstrate admitted work, not 600 completed imports or a latency result. The
separate export probe records its deadline failure explicitly. It is excluded
from successful-operation timings and from the typing comparison.

## Reproduce the checks

Build baseline `8fdf4ad` in a separate checkout with
`npm run build -- --sourcemap`, and serve its `dist` on port 43124. Build this
branch the same way and serve its `dist` on port 43125. Python's
`python3 -m http.server PORT --bind 127.0.0.1 --directory DIST` is sufficient.

```bash
CHROME_PATH=/path/to/chrome \
AUDIT_URLS=http://127.0.0.1:43124,http://127.0.0.1:43125 \
AUDIT_RUNS=5 AUDIT_ASSETS=300 AUDIT_OUTPUT=/tmp/large.json \
node tests/performance-audit.mjs
```

Repeat with `AUDIT_ASSETS=12`. Set `AUDIT_PROFILE_DIR` and `AUDIT_SOURCE_MAP` to
capture a separate typing CPU profile and its source-mapped sample groups.
Run profiling separately from the timing comparison. `AUDIT_EXPORT=1` enables
the optional export probe and records a failed deadline without calling it a
successful export. `tests/media-admission-audit.mjs` counts large-list loading
admission with responses held. Omit `CHROME_PATH` if Playwright Chromium is
installed.

Raw evidence is in [performance](performance/):

- [300-card trials](performance/26-large-library.json)
- [12-card trials](performance/26-typical-search.json)
- [Baseline CPU sample groups](performance/26-baseline-cpu-samples.json)
- [Candidate CPU sample groups](performance/26-candidate-cpu-samples.json)
- [Media-admission counts](performance/26-media-admission.json)
- [Export attempt](performance/26-export-attempt.json)
