# GPU canvas

The GPU canvas draws the workflow as a three.js scene instead of one page
element per node. Each node is a picture of the real node component, painted
off screen with HTML-in-Canvas; the nodes being worked in are the real
components, laid over the scene. It is the desktop app's canvas. The
classic React Flow canvas stays one switch away for one release, and the
browser build keeps it.

## Turning it on and off

Settings › Canvas › "GPU canvas" (`node-banana-gpu-canvas` in localStorage,
`on` or `off`; absent means on in the desktop app, off in the browser). It
needs HTML-in-Canvas, which Chromium 152 ships behind the
`CanvasDrawElement` Blink feature:

- **Desktop app**: every launch appends
  `--enable-blink-features=CanvasDrawElement` unless the classic canvas was
  chosen (`electron/lib/gpu-canvas.cjs`, which keeps the choice in
  `gpu-canvas-v1.json` under user data). Turning the setting off switches to
  the classic canvas at once and leaves the feature off from the next
  launch; turning it back on takes a restart, and the setting says so.
  `NODE_BANANA_GPU_CANVAS=1` or `=0` turns the feature on or off for one run
  (the runners use it).
- **Browser**: the classic canvas, unless Chromium was started with the same
  switch and the setting is turned on.

The canvas is active when the setting is on, `texElementImage2D` exists and
the GPU canvas has not failed this session (`useGpuCanvasActive`,
`src/lib/gpuCanvas/setting.ts`). Otherwise the classic canvas runs,
unchanged.

**Falling back.** If the scene cannot start (no WebGL2) or one of its
shaders does not compile, the page hands over to the classic canvas for the
rest of the session and says so in a notice; the setting is left as it was.
When the GPU resets (`webglcontextlost`), the GPU canvas is built afresh once
WebGL is back (or after 3 s), repainting from the disk cache; a second reset
in the same session falls back to the classic canvas.

**Removing React Flow.** With the GPU canvas on, React Flow no longer draws
the workflow: the scene does, and React Flow only hosts the live nodes and
the painter's sheets (`LiveLayer.tsx`, `PainterSheet.tsx`), which reuse the
node components as they are. The classic canvas, and its `WorkflowCanvas`
branch, are removed once the release that keeps it behind the setting is
out.

## How it fits together

| Part | File | What it does |
|------|------|--------------|
| Scene graph | `src/lib/gpuCanvas/graph.ts` | Nodes, edges and groups as flat arrays plus a grid index, kept in step with the store; positions move in place, an add or remove rebuilds |
| Scene | `src/lib/gpuCanvas/scene.ts` | WebGL2: dot grid, groups, instanced node quads reading the atlas, instanced edge segments, selection and hover outlines. Owns pan, zoom and the pointer, handing presses to the editor |
| Edge routes | `src/lib/edges/route.ts`, `src/lib/gpuCanvas/edgeRoutes.ts` | The route today's edges draw (curved, angular, straight, hooks, loops), shared with `EditableEdge`, read into cubic segments for the scene, with bundles' stems, reference dashes and loading state |
| Editor | `src/components/gpuCanvas/editor.ts`, `src/lib/gpuCanvas/gestures.ts` | Drag, connect, the marquee, edge clicks, Delete and the context menus, against painted handles and media cards; what a drag on the pane does follows the navigation settings as WorkflowCanvas's React Flow props do |
| Paint keys | `src/lib/gpuCanvas/paintKey.ts` | A hash of what a node's picture shows: type, width, data, socket connections and the keys of what feeds it, so a change anywhere upstream reaches it. Position and selection are not in it |
| Queue | `src/lib/gpuCanvas/paintQueue.ts` | Paint requests by priority (urgent changes, the view, background) and tier |
| Atlas | `src/lib/gpuCanvas/atlasLayout.ts`, `atlas.ts` | A 2048² texture array: 1/8 images shelf-packed for good, larger tiers in freeable cells |
| Budget | `src/lib/gpuCanvas/budget.ts` | 16 layers (256 MB); 8 on an integrated GPU or under 8 GB of memory |
| Painter | `src/components/gpuCanvas/painter.ts`, `PainterSheet.tsx` | Renders batches of real nodes on a sheet inside `<canvas layoutsubtree>`, paints the sheet into a texture, copies each node into its atlas slot |
| Disk cache | `src/lib/gpuCanvas/paintCache.ts` | Painted images in IndexedDB (`node-banana-paint-cache`), by paint key and tier |
| Live layer | `src/components/gpuCanvas/LiveLayer.tsx` | A real `<ReactFlow>` over the scene holding the live nodes and the connections that show more than a line. It renders under the page's `ReactFlowProvider`, so it is the page's React Flow: `screenToFlowPosition`, `setCenter`, the viewport portal and the selection toolbar answer for the GPU canvas, its viewport kept equal to the scene's both ways |
| Bridge | `src/components/gpuCanvas/bridge.ts`, `GpuMinimap.tsx` | The whole scene graph and view for chrome that needs every node (the minimap, Fit view), since React Flow holds only the live ones |
| Shell | `src/components/gpuCanvas/GpuCanvas.tsx` | Builds the rest, follows the store, shows the loading screen |

## Tiers

A node is painted at a tier: 1/8, 1/4, 1/2, 1 or 2 texels per css pixel at
100%, up to the display's scale. The view wants the tier matching zoom ×
scale; a node shows the smallest tier it holds that is that sharp, else its
sharpest. Every node keeps a 1/8 image, so once a workflow has been painted
a zoomed-out view never falls back to stand-in cards. Larger tiers are painted for the view and its margin and are
evicted, longest unseen first, when the atlas needs room; the view's own
tier near the view is never evicted.

After the 1/8 pass, every node is also painted at the tier a 25% view needs
(1/4 on a standard display, 1/2 on a Retina one), in batches of 8 below
everything else. Those images go to the disk cache and stay in the atlas
only near the view, and they never evict anything: a jump to a far part of
the graph at 25% then uploads a couple of hundred images from the cache
instead of painting them. Nodes the cache already holds are skipped.
Batches are 48 nodes, 96 at the 1/4 tier.

## Painting

- **Sizes settle first.** A batch renders its nodes on the sheet, waits for
  React Flow to measure them and for their images to load and decode (again
  whenever an image's source changes, until the sizes hold), then places
  them again at their measured heights and waits until React Flow has moved
  them (it applies positions a render after ours). Only then is the sheet
  painted. The measured height and handle positions go to the scene, so
  edges meet the painted sockets.
- **Painting gives way to input.** A batch starts only 120 ms after the last
  input, and a batch whose sheet became ready after input arrived goes back
  to the queue unpainted. Sheets are 2048×1536 texels; disk cache uploads
  are spread to 2 M texels a frame.
- **Changes come first.** A store change marks the node and everything
  downstream of it stale a frame later (keys are not computed on the typing path). Their
  images at the view's tier and at 1/8 are queued urgent; an urgent batch
  holds only urgent requests, and a background batch still being prepared
  gives way to it.
- **Painted copies are read-only.** The sheet's nodes read the real store
  inside `<PaintedNodes>`, where `useUpdateNodeData()` drops writes. A node
  that derives what it shows by saving it (Split Grid and Image Resize copy
  their upstream image) shows the derived value directly when
  `useIsPaintedNode()` is true.

- **Navigating holds `canvas-interacting`** on the document, as today's
  canvas does, so work that waits for a still canvas (the desktop recovery
  checkpoint) does not land mid-pan.

## Opening a workflow

A workflow opened from a file is framed as today's canvas frames it
(`frameLoadedGraph`), or the tab's saved view is restored. Painting starts
over from that view. A workflow of 150 nodes or more that is not painted
within 300 ms shows the loading screen ("Opening workflow", N of M), which
stays until the view is sharp and every node has its 1/8 image. Behind it
the sheets are 4096×3072 and nothing waits for quiet, since nobody can pan.

Reopening reads the disk cache: each entry is the image's raw RGBA,
deflated, with the node's height and handle anchors. Images are read back
from the GPU without stalling (a pixel buffer and a fence) and stored once
the GPU is done; the cache is trimmed to 512 MB, least recently used first.
The key includes the app version and display scale, so an update or a
different screen paints afresh. A node's file refs (`imageRef`, `inputImageRefs`, …) are left out of
its key: they name the file its media was saved as, so a save that records
them repaints nothing.

## Live nodes

A node is live (a real component on the live layer) while it is hovered,
selected, holds focus, is opened, or is visible above 100% zoom. Its scene
image stays until the live component is measured and decoded, then is
hidden, so the swap shows no gap. When it stops being live it waits up to
1.5 s for a current painted image (it may have been edited while live)
before the scene shows it again.

The layer hands React Flow new node objects on each render, carrying the
size React Flow measured: without it React Flow hides the node until it
measures it again, which blurs a field being typed in.

Live nodes take the pointer: React Flow sets `pointer-events: none` inline
on nodes it cannot select or drag, which is every node of the live flow, so
the live layer's style overrides it. Hover follows the live node the pointer
is on (its floating header included) as well as the scene's hit test.

## Live content

Today's canvas keeps some nodes mounted whatever the view (`nodeCulling`'s
always-mounted types) because their component holds what the store does
not. On the GPU canvas a node stays live for as long as it holds something
(`liveContent.ts`, `useHoldLive`):

- **held**: the node shows something of its own: a model browser, a
  lightbox, a variables or presets dialog, the grid editor, an open
  dropdown. The component holds itself live with `useHoldLive(open)`.
- **playing**: its video or audio plays (play pressed, or a hover preview),
  so playback and its sound go on when the pointer leaves. Videos are not
  textures in the scene: a playing one is a real `<video>` on the live
  layer, and a still one is painted at its first frame (painting waits for
  it, as for images).
- **resident**: the 3D viewer, always: it holds a WebGL view the user orbits.
  Its blob URL outlives an unmount unless the node or its model went.
- **pending**: a ComfyUI node with a workflow to import or a "Replace
  workflow…" to answer, or a run streaming previews.
- **running**: a node loading its output, so its spinner turns. Its
  connections show the comet at any zoom (other decorated connections go
  live from 30%).

Zoomed out past the low-detail zoom (Settings › Canvas), running nodes stay
pictures and the scene draws today's low-detail running halo over every node
the run is on, pulsing (static under reduced motion). A run's outline shows
in a node's picture: the run is marked on its paint key apart from its data
(`runMark`), so a run starting repaints the nodes near the view at once and
the rest as the view reaches them, and the nodes they feed are not touched.

A painted copy writes nothing, with one exception: effects that keep
values derived from upstream in a node's data (a Switch's input type, a
Prompt Constructor's text, an Array's items, a resize's source image, clip
order) write through `useDerivedNodeData`. A node is painted again whenever
something upstream changes, so that is where it derives. Output nodes run on
a new connection through a store watcher (`outputAutoRun.ts`) instead of
their component. Annotation opens its editor from the live node, as today.

## Editing

The scene takes every press and asks the editor what it starts:

- **A handle** (a live node's, or a painted one within 9 px): a click opens
  the handle menu; a drag draws the connection line and snaps to an
  opposite handle within 20 px. A valid drop connects; anything else goes to
  `handleConnectEnd` with the node under the pointer, which opens the
  connection drop menu as today.
- **A node**: a click selects it (Shift adds or removes it); a drag moves the
  selection. The first move records the undo step, the moves in between go
  only to the scene graph and the live layer, and the drop goes to the store
  and to `onNodeDragStop` (group membership).
- **A connection** (within 7 px): selects it, as React Flow would.
- **The pane**: a click clears the selection; a drag pans or draws the
  marquee as the navigation settings say (`paneDragAction`). The marquee
  takes a node only when it holds its media card, or the whole node without
  one; with no nodes taken it selects the connections it crosses.
- **Delete / Backspace** removes the selected connections, then nodes;
  right-click opens the pane or connection menu; a double-click on the pane
  opens the add-node menu.

Strokes are always the scene's. A connection with more than a line (a label,
a hidden stub, a bundle, pause, loop, the loading pulse, an array item) and
every selected one is also rendered as a real `EditableEdge` on the live
layer, with its path hidden, for its decorations and toolbar; the painted
nodes it ends at are stood in for by invisible nodes with the painted
handles. That happens on screen at 30% zoom and above, for up to 250.

## What phase 3 leaves out

- Sweeping connections with the hook key (H), and dragging a connection's
  end to reconnect it.
- Hidden connections' stubs below 30% zoom.
- A live connection's decorations draw over painted nodes they pass under.
- A node whose look depends on state outside its data and its inputs (a
  file loading elsewhere, a timer) may paint stale until its key changes.

## What phase 4 leaves out

- Videos are never textures in the scene: a playing video is a live
  `<video>`, so many playing at once cost what they cost on today's canvas.
- Spinners outside a loading node (a thumbnail resolving, a button waiting)
  are painted still.

## Measuring

`scripts/gpu-canvas.cjs` opens the production Electron app with the GPU canvas
on, drops the stress workflow tiled to about 5,000 nodes (media by
reference), and checks:

| Check | Pass |
|-------|------|
| `open` | in the scene, then the view sharp and every node at 1/8 (loading screen timings) |
| `reopen` | the same over the disk cache |
| `pan` | pans while painting hold refresh rate (traced) |
| `change` | a change to a node not being edited is shown within 100 ms (what it feeds is timed alongside) |
| `fidelity` | each node type painted against live: 99.5% of pixels within 2 levels, or (photos resample a little differently) no more than 0.5% over 10 levels and a mean difference of 1 level at most |
| `tiers` | zoom steps and jumps sharp within 500 ms, atlas within budget |
| `scene` | pan and zoom gestures at refresh rate |
| `latency` | input latency of a pan on the GPU canvas against today's canvas |

The trace's `latencyMs` counts an input as shown by the first presented frame
with a main-thread commit after it; a WebGL canvas's frames need none, so for
the GPU canvas read `chromeLatencyMs` (Chromium's own input-to-presentation
figure) and the page's `input.latencyMs` instead.

```bash
npm run build
node scripts/gpu-canvas.cjs --output gpu-canvas-mac.json
```

`--checks` picks checks, `--copies` sizes the workflow, `--fresh-paint`
also compares each node painted alone (bypassing the cache). Without a GPU
(a Linux container) run it under `xvfb-run` with
`--input synthetic --chromium-flags "--no-sandbox --use-angle=swiftshader"`;
frame-rate checks are meaningless there, the rest still run.

The desktop smoke test (`npm run electron:smoke`) runs on whichever canvas
the app opens with, the GPU canvas by default (`NODE_BANANA_GPU_CANVAS=0`
for the classic one): it adds a Prompt, makes it live and types into it. In a
Linux container pass `NODE_BANANA_SMOKE_CHROMIUM_FLAGS="--no-sandbox
--use-angle=swiftshader"` and run it under `xvfb-run`. The acceptance and
large-workflow runs check recovery through the classic canvas, so they pin
it unless `NODE_BANANA_GPU_CANVAS` says otherwise, and
`electron:performance` measures the classic canvas.

`window.__gpuCanvas` (stats, painter status, sharpness, view, node rects,
live nodes, `paintNow`, `repaint`) is what the runner drives.

The stats also keep frames over 250 ms with the painter phase they ended in,
and the browser's long animation frames with their slowest scripts; the
`tiers` check prints both. That is how a stall outside the painter (an
autosave settling every node's media in one task) was found.
