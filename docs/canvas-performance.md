# Electron canvas performance

How smooth panning the canvas and dragging nodes are, how to measure it the way it is felt, and what has been done about it. Two passes so far: the September 2026 pass on the Mac (React and store work) and the October 2026 pass on Windows (measurement that matches real use, then the main thread and Chromium's own work).

None of the changes alters the canvas at rest. Two alter it mid-gesture, both on edges: an edge under the cursor does not highlight while the canvas pans or a node drags, and edges cannot be clicked mid-gesture (they could not before either).

## Measuring

The runner is `scripts/electron-canvas-performance.cjs`. Always measure a production build: development builds run React in development mode with StrictMode's double renders and are several times slower.

```sh
npm run build
npm run electron:performance -- --input os --fixture realistic --output <dir>/after.json
```

### What it reports, and why

Each gesture is traced with Chromium's own tracing (`electron/lib/perf-trace.cjs`) and judged by what reached the screen (`scripts/lib/trace-analysis.cjs`):

| Column | Meaning |
| --- | --- |
| `pres/s` | How often the screen showed the canvas move: frames presented with the main thread's update (`STATE_PRESENTED_ALL`), counted once per display frame |
| `drop%` | Of the vsyncs that should have shown a move while input arrived, the share that did not |
| `vsync%` | Presented updates as a share of all vsyncs in the gesture |
| `p95 ms`, `max ms` | Gaps between presented updates |
| `lat p50`, `lat p95` | From the OS input event to the first presented frame committed after the main thread handled it |
| `render`, `browser`, `gpu` | Busy time of the renderer's main thread, Electron's main process (which routes input) and the GPU process's main thread |
| `LoAF` | Long animation frames (50 ms or more), each named after its slowest script in the report |

The report keeps the older figures (animation-frame callback rate and Chrome's script/layout/style totals) for comparison, but they do not decide anything: a run could show 88 callbacks a second while 71% of the frames that had something to show missed their vsync.

Two details of Chromium's frame reports matter for anyone reading traces directly. While the main thread is busy, Chromium forks a vsync's report to record what the compositor showed without it; those partial reports do not move a dragged node and are not counted. Forked reports nest inside their parent under the same id; spans pair last-in-first-out per id.

### Making the run match real use

The September runner looked smooth while real use was not. It sent events from Electron's main process (`sendInputEvent`), which bypasses the window system and Electron's input routing, and on Windows its 8 ms timer fired every ~15.6 ms, so "125 Hz" arrived as bursts at ~64 Hz. It ran a 1440×900 window over a grid of identical nodes, with Playwright's DevTools session attached. The attached session alone cost a node drag 113 → 85 presented frames a second, and on a canvas carrying ~300 MB of media its network events overflowed Chromium's 256 MB DevTools buffer and dropped the page.

The runner now:

- **Drives the real cursor** with `--input os`: `SendInput` on Windows from a helper on a 1 ms timer (never more than ~0.5 ms late at 1000 Hz), `CGEventPost` from JXA on the Mac. Default 1000 Hz (`--hz`), a maximised window (`--window WxH` to override). Do not touch the mouse while it runs. `--input synthetic` (the default) keeps the earlier behaviour for quick runs.
- **Runs without DevTools.** A hook in Electron's main process (`scripts/lib/electron-driver*.cjs`) runs the runner's requests; page code goes through `executeJavaScript`. `--cdp-metrics` (Chrome's script/layout totals) and `--profile` (a CPU profile) attach Electron's own debugger only when asked for, and observe the page while they do.
- **Uses real canvases.** `--fixture realistic` is `examples/stress-workflow.json` (about 300 nodes, 400 edges, groups, hidden and bundled links) carrying photo references, PNG outputs with and without alpha, a 4K output, video, long prompts and comments. `--workflow <file>` loads a saved workflow. `--restore-tab <name>` copies one tab of the installed app's last session (read only) into the disposable profile and lets the app restore it, as it loads your own canvas.
- **Keeps the window on top** (Chromium stops producing frames for a covered window), refuses to start while Electron from a checkout is still running, and takes down the whole process tree when it ends.

Gestures: `drag-sweep` and `drag-circle` (node drags: long fast sweeps, continuous loops), `pan-sweep` (a drag on the empty canvas, how Windows pans), `pan-wheel` (trackpad-style wheel pan, how the Mac pans), and the earlier `rapid-drag` and `rapid-pan` paths. Pick with `--gestures`.

Other options: `--app-root <checkout>` measures another checkout's build (keep a baseline worktree built), `--executable <path>` an installed app, `--rounds`, `--seconds`, `--zoom`, `--tabs N`, `--agent-open`, `--media`/`--nodes` for the generated grid, `--keep-traces`, `--detail` (adds the categories that break each thread's time down; traces grow by hundreds of MB a second, so keep `--seconds` short), `--categories` (more trace categories) and `--chromium-flags` (try a Chromium switch without changing the app).

### Measuring real use

Set `NODE_BANANA_PERF_TRACE` to a folder, use the app normally, make it stutter, then quit. The app traces from launch into a ring buffer holding about the last minute and a half and writes it to the folder as it quits. Then:

```sh
npm run perf:analyze -- <folder>/node-banana-<date>.json
```

reports every drag and pan in it, named by what each began on (`pan`, `node-drag`, `wheel-pan`, `zoom`). Nothing is recorded unless the variable is set.

### On the Mac

The same commands work. `--input os` posts events through `CGEventPost` from JXA, which needs Accessibility permission for the terminal running it (System Settings → Privacy & Security → Accessibility); without it macOS drops the events and the runner times out waiting for them. Pans default to `pan-wheel` on the Mac. To compare, keep a second checkout of the baseline built and pass it with `--app-root`, alternating baseline and branch runs.

## Windows pass — 11 October 2026

Windows 11, Intel i9-14900KF, NVIDIA RTX 4090, 2560×1440 at 180 Hz and 100% scaling, Electron 44.2.0 / Chromium 152. Real mouse input at 1000 Hz, maximised, no DevTools attached, two rounds per gesture, baseline and branch alternated. Baseline: `develop` at `b65cabfd` with the measurement commits only. A 180 Hz display leaves 5.5 ms a frame.

Canvases: **Cars**, a working canvas of 67 nodes with nine video generations restored from a real session; **realistic**, the 300-node fixture; **grid**, 240 generated nodes with 1024px images.

How often the screen showed the canvas move, per second:

| Canvas | Gesture | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| Cars | node drag, sweep | 102 | 131 | +28% |
| Cars | node drag, circle | 104 | 153 | +47% |
| Cars | pan | 70 | 72 | +3% |
| Realistic | node drag, sweep | 31.7 | 54.2 | +71% |
| Realistic | node drag, circle | 33.3 | 54.9 | +65% |
| Realistic | pan | 20.7 | 45.0 | +117% |
| Grid | node drag, sweep | 56 | 109 | +93% |
| Grid | node drag, circle | 57 | 92 | +61% |
| Grid | pan | 44.6 | 63.8 | +43% |

The 95th-percentile gap between updates on the realistic canvas's pan fell from 145 ms to 39 ms and its long animation frames from 27 to 6. Input latency (p50) fell or held everywhere; its p95 on Cars drags varies between runs from about 60 to 210 ms (baseline 70–78 ms), with short spikes mid-gesture and around the drop, and is worth watching. [Raw measurements](performance/electron-canvas-windows-2026-10-11.json).

### What changed

In order of effect:

- **Culled nodes stay mounted while the canvas moves.** Nodes more than a viewport from the view are replaced by placeholders, and were the moment they left that area, so a pan back and forth unmounted and remounted the same bands of nodes on every pass. Nodes rendered during a move now keep their component until the canvas has been still for 400 ms, and are released in a transition (`nodeCulling.tsx`).
- **A press that becomes a pan or a node drag captures the pointer, and the empty canvas is not text-selectable.** Each move was hit-tested against the whole canvas up to three times a frame: to deliver it, as the frame began, and to extend a possible text selection. A 2-second pan now runs about 8 hit tests instead of about 100.
- **A node drag's moves reach the store on the drop.** Each frame wrote the moved node into the workflow store and every subscriber's selector re-ran, thousands on a large canvas. The canvas keeps the moves after the first (which records the undo point) and writes the final positions on the drop; the selection bar follows React Flow's positions.
- **Interaction rules restyle only what they change.** Rules keyed on the interaction classes ended in `*`, so toggling them at the start and end of every gesture restyled the whole page (25,000 elements, ~90 ms each time).
- **Edges ignore the pointer mid-gesture.** Every move hit-tested each edge's 15 px invisible stroke.
- **Portal containers are found once.** React Flow's `ViewportPortal` and `EdgeLabelRenderer` search the canvas for their container on every store update; the viewport portal is its last child, so each search visited every node and edge. Local versions (`flowPortals.tsx`) find it once.
- **Smaller selector work per frame:** an edge's store slices are rebuilt only when what they read changes (`lastResult`), node shells look sizes up in the shared index instead of scanning the nodes, and sockets read their connected state with one lookup.
- **React Flow 12.11.2**, pinned exactly: 12.11.3 moves the dot grid's offset, a visible change. Neutral on its own here.

### Tried and not kept

- **The viewport, or the dragged node, on its own GPU layer** (`will-change: transform` while moving). Panning moved pixels already drawn, but Chromium then re-ran layer assignment over every layer under it each frame: layer updates rose from 374 to 1,190 ms in a 2-second pan, and the realistic canvas fell from 31 to 8 updates a second.
- **Skia Graphite** (`--enable-features=SkiaGraphite`, off by default on Windows in this Chromium). Cars pan rose from 72 to 93 updates a second, but drag latency got worse (p50 30 → 45 ms) and Graphite antialiases differently, so the canvas would not be pixel-identical.
- **Dropping shadows while panning**: no measurable gain.

### Where the time goes now

- **Cars pan is GPU-bound.** Each frame re-rasterises the visible canvas: about 440 path draws and 155 offscreen layers per frame, from 335 squircle-cornered elements (`corner-shape: squircle` draws as a path, and a squircle that clips needs an offscreen layer). Drawing round corners while a pan is in progress measured +19% (72 → 85 updates a second); it changes the corner shape mid-pan, so it is not applied.
- **Large canvases are bound by the renderer's main thread.** What remains is React Flow's own store fan-out on every viewport change, and Chromium's layer assignment and painting, which scale with how much is mounted.

## Mac pass — 22 September 2026

The performance branch kept the existing node design, edges, previews, minimap, culling margins and trailing-controls animation, and reduced the React and store work done during dragging and panning:

- The canvas reads the saved viewport once for initial placement. It subscribes only to whether a viewport exists for automatic fitting. React Flow handles live movement; viewport persistence and desktop recovery still receive navigation updates.
- The tab strip captures the incoming viewport when the active tab changes, before navigation effects can overwrite it. Saving each pan position no longer renders the strip.
- React Flow callbacks and configuration keep stable references. Its store updater broadcasts each changed callback separately, so recreating these during drag caused repeated rounds of subscriber calculations.
- Trailing controls subscribe directly to node position and write their animated transform without React commits.
- Content-only consumers share a cached projection of node IDs, types and data. Position, dimensions and selection changes no longer invalidate readiness analysis, costs, onboarding checks or media-input calculations.

Recorded with the runner of the time (synthetic 125 Hz input, a 1440×900 window, 240 nodes, 160 distinct 1024px previews, ~52% zoom, animation-frame callbacks as the metric). Apple M5, arm64 macOS, Electron 44.2.0 / Chromium 152.0.7977.76. Medians of three repetitions; baseline `develop` at `e606636`, optimized `7f3b6ff`.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Rapid drag, frame callbacks/sec | 39.3 | 55.1 | +40% |
| Rapid pan, frame callbacks/sec | 32.8 | 50.3 | +53% |
| Drag p95 frame interval | 33.4 ms | 25.8 ms | −23% |
| Pan p95 frame interval | 41.7 ms | 25.8 ms | −38% |
| Full pan gesture including queued input | 15.78 s | 11.01 s | −30% |

[Raw measurements](performance/electron-canvas-2026-09-22.json).
