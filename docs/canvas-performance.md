# Electron canvas performance

The performance branch keeps the existing node design, edges, previews, minimap, culling margins and trailing-controls animation. It reduces the React and store work done during dragging and panning.

## Changes

- The canvas reads the saved viewport once for initial placement. It subscribes only to whether a viewport exists for automatic fitting. React Flow handles live movement; viewport persistence and desktop recovery still receive navigation updates.
- The tab strip captures the incoming viewport when the active tab changes, before navigation effects can overwrite it. Saving each pan position no longer renders the strip.
- React Flow callbacks and configuration keep stable references. Its store updater broadcasts each changed callback separately, so recreating these during drag caused repeated rounds of subscriber calculations.
- Trailing controls subscribe directly to node position and write their animated transform without React commits. The easing, maximum trail, settling and cleanup remain covered by a regression test.
- Content-only consumers share a cached projection of node IDs, types and data. Position, dimensions and selection changes no longer invalidate readiness analysis, costs, onboarding checks or media-input calculations. Run controls subscribe to selection IDs; comment navigation retains its spatial ordering while avoiding renders when that order is unchanged.

## Reproduce

Build the production renderer first. Development builds have additional instrumentation and are not comparable.

```sh
npm run build
npm run electron:performance -- --media --nodes 240 --rounds 3 --output /tmp/canvas-after.json
```

The runner launches the source Electron shell against `.next` using a disposable profile and an unused port. It creates a synthetic workflow through the normal file-drop path, blocks API POST requests, and removes its profile afterward. It does not load or modify the normal desktop session.

Options:

- `--media`: populate generation/output nodes with deterministic 1024×1024 JPEG previews. Without it, nodes have empty previews.
- `--nodes N`: graph size; default 240, minimum 12.
- `--rounds N`: repetitions; default 3.
- `--app-root PATH`: use another checkout's production build for a baseline.
- `--profile`: also save a Chrome CPU profile. Use this for diagnosis, not the timing comparison.
- `--output PATH`: JSON metrics and an adjacent PNG of the initial canvas.

Each gesture sends 500 native input events from Electron's main process at a nominal 125 Hz over four seconds. Dragging moves back and forth six times horizontally and four times vertically. Panning reverses every 400 ms. Input production does **not** await the renderer after each event: doing that hides stalls by slowing down the test.

The runner waits for the final mouse move and an ordered wheel marker to arrive, then allows the final animation frames to commit. The measurement includes time spent processing queued input after the producer stops. This prevents the next gesture and the tab-restoration check from running while Chromium still has wheel input queued. The wheel marker adds a one-pixel vertical movement.

Metrics include animation-frame callback rate, median/p95/worst frame intervals, frames over 25 ms, gesture completion time and Chrome script/layout/style/task durations. Animation-frame callback rate is a renderer responsiveness measurement, not a GPU presentation counter. Compare the same display, zoom, fixture and machine with no concurrent builds or tests. Hardware, scheduling and workflow contents affect results; these are not universal FPS guarantees.

After the measured gestures, the runner checks node movement, viewport movement, node retention, undo/redo, tab viewport restoration, and renderer/node errors.

## Recorded result — 22 September 2026

Apple M5, arm64 macOS, Electron 44.2.0 / Chromium 152.0.7977.76. A 1440×900 CSS-pixel window, 240 nodes, 160 edges and 160 distinct 1024px previews, at approximately 52% zoom. Three repetitions per build; the table gives the median of each per-run metric. Baseline: `develop` at `e606636`; optimized application: `7f3b6ff`.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Rapid drag, frame callbacks/sec | 39.3 | 55.1 | +40% |
| Rapid pan, frame callbacks/sec | 32.8 | 50.3 | +53% |
| Drag p95 frame interval | 33.4 ms | 25.8 ms | −23% |
| Pan p95 frame interval | 41.7 ms | 25.8 ms | −38% |
| Full pan gesture including queued input | 15.78 s | 11.01 s | −30% |

Drag rates ranged from 30.9–41.6 before and 51.3–56.3 after. Pan rates ranged from 32.7–42.4 before and 49.2–52.8 after. Both builds passed the interaction assertions. Occasional long frames remain under this sustained input load; this is an improvement, not a steady-60-FPS guarantee. The four-second producer still creates input backlog, which is why completion time is recorded separately.

[Raw measurements](performance/electron-canvas-2026-09-22.json) include every repetition and the script/layout/style/task timings.

## Verification

- Production build passes.
- Full Vitest run: 182 files, 3,189 tests passed. Following the final tab-capture change, all 61 canvas/tab tests passed, including the added navigation-effect ordering regression.
- Electron native-process tests: 16 passed.
- Standalone `tsc --noEmit` reports 207 existing diagnostics on both `develop` and this branch, with identical counts per file and diagnostic code. These are predominantly test fixture typings; the production build's type check passes.
- Initial canvas screenshots match outside the transient minimap-button tooltip fade. No visual styling or GPU flags were changed.
