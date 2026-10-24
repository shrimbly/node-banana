# GPU canvas

The GPU canvas draws the workflow as a three.js scene instead of one page
element per node. Each node is a picture of the real node component, painted
off screen with HTML-in-Canvas; the nodes being worked in are the real
components, laid over the scene. It is the only canvas: the classic React
Flow canvas was removed in 3.0. React Flow is still used, only to host the
live nodes and the painter's sheets (`LiveLayer.tsx`, `PainterSheet.tsx`),
which reuse the node components as they are. Below, "classic" names the
React Flow canvas it replaced, whose behaviour it was built to match.

## Where it runs

It needs WebGL2. Painting nodes also needs HTML-in-Canvas, which Chromium
152 ships behind the `CanvasDrawElement` Blink feature
(`detectHtmlInCanvas`, `src/lib/gpuCanvas/htmlInCanvas.ts`). Chromium 155
renamed it (`texElementSubImage2D` into storage made first, the canvas's
`content="drawable"` and the painted element's `drawable` in place of
`layoutsubtree`); the adapter uses whichever names the page has, and was
checked on Electron 46 (Chromium 158), where it is on by default, with the
same paint, reopen and fidelity results as Electron 44:

- **Desktop app**: every launch appends
  `--enable-blink-features=CanvasDrawElement` and
  `--enable-unsafe-swiftshader` (`electron/lib/gpu-canvas.cjs`). The second
  lets WebGL fall back to SwiftShader, Chromium's CPU renderer, where the GPU
  is missing or blocklisted; Chromium no longer does that by itself, and
  without it such a machine gets no WebGL2 at all (checked on Electron 44
  with `--disable-gpu`). A real GPU is used whenever there is one; on
  software, the canvas says once a session that it may be slow.
  `NODE_BANANA_HTML_IN_CANVAS=0` turns HTML-in-Canvas off for one launch
  (`--disable-blink-features`, since Chromium 158 has it on by default).
- **Browser**, or any page without HTML-in-Canvas (an Electron whose API
  changed again): the same canvas and the same painter, which copies each
  sheet into an image instead (`src/lib/gpuCanvas/domSnapshot.ts`): the sheet
  is laid out in a hidden element on the page, cloned into an SVG
  `<foreignObject>` with the page's style rules (`:root`, `html` and `body`
  pointed at wrappers carrying those elements' attributes; fonts and other
  files they name as data URLs), each image, canvas and video frame as a data
  URL, and form fields' values, then decoded and uploaded. It must be a data
  URL: Chromium taints an SVG with a foreignObject loaded from a blob URL.
  The page is zoomed, not the SVG scaled, so text and boxes snap to device
  pixels as on the page. A picture goes in as its file unless it is more than
  four times the size it shows; then it is drawn at twice that size (JPEG when
  opaque). Drawing every large picture smaller instead blurred fine detail and,
  on a Mac, cost more main-thread time than carrying the files. Runner
  `--media png --unique-media N` measures with a generator's 2048 px PNGs.
  Painted images are cached on disk as on the desktop (the cache salt names the
  backend). Run the perf runner with `--live` to measure this path.
- **Live nodes alone**: `node-banana-live-nodes` = `on` in localStorage keeps a
  page without HTML-in-Canvas on no painter, to compare against (runner
  `--live-nodes`). The nodes in view are live components, up to
  `LIVE_MODE_MAX_NODES` (750), at any zoom; with more in view, nodes are the
  scene's stand-in cards (`showViewLive` in `GpuCanvas.tsx`). Once the view is
  still, the nodes up to half a view outside it turn live too
  (`LIVE_MODE_AHEAD`). While the view moves, nothing new turns live, and live
  nodes go back only once well out of view (`LIVE_MODE_MOVING_MARGIN`). Nodes
  turn live a few a frame, nearest the middle first: the number grows while
  frames keep up and halves after a slow one (`LIVE_MODE_ADDED_PER_FRAME`), and
  the sizes React Flow measures for them reach the store in one write once the
  mounting stops (`LiveFlow`). Live nodes are not snapped to whole pixels here.

**When it cannot draw.** If the scene cannot start (no WebGL2) or one of its
shaders does not compile, the canvas's place shows why, with Try again
(`CanvasUnavailable.tsx`, `src/lib/gpuCanvas/failure.ts`); the workflow,
saving, Assets and the chat are unaffected. When the GPU resets
(`webglcontextlost`), the canvas is built afresh once WebGL is back (or
after 3 s), repainting from the disk cache; a second reset shows the same
screen.

## How it fits together

| Part | File | What it does |
|------|------|--------------|
| Scene graph | `src/lib/gpuCanvas/graph.ts` | Nodes, edges and groups as flat arrays plus a grid index, kept in step with the store; positions move in place, an add or remove rebuilds |
| Scene | `src/lib/gpuCanvas/scene.ts` | WebGL2: dot grid, groups, instanced node quads reading the atlas, instanced edge segments, the selection outline of a node still swapping in (classic's card border, ring and shadow). Owns pan, zoom and the pointer, handing presses to the editor |
| Edge routes | `src/lib/edges/route.ts`, `src/lib/gpuCanvas/edgeRoutes.ts` | The route today's edges draw (curved, angular, straight, hooks, loops), shared with `EditableEdge`, read into cubic segments for the scene, with bundles' stems, reference dashes and loading state |
| Editor | `src/components/gpuCanvas/editor.ts`, `src/lib/gpuCanvas/gestures.ts` | Drag, connect, the marquee, edge clicks, Delete and the context menus, against painted handles and media cards; what a drag on the pane does follows the navigation settings as WorkflowCanvas's React Flow props do |
| Paint keys | `src/lib/gpuCanvas/paintKey.ts` | A hash of what a node's picture shows: type, width, data, socket connections and the keys of what feeds it, so a change anywhere upstream reaches it. Its header's readiness hint, its view state (`nodeUiStore`) and a run's mark are added apart, reaching nothing downstream. Position, selection and hover are not in it |
| Queue | `src/lib/gpuCanvas/paintQueue.ts` | Paint requests by priority (urgent changes, the view, background) and tier |
| Atlas | `src/lib/gpuCanvas/atlasLayout.ts`, `atlas.ts` | A 2048² texture array: 1/8 images shelf-packed for good, larger tiers in freeable cells |
| Budget | `src/lib/gpuCanvas/budget.ts` | 16 layers (256 MB); 8 on an integrated GPU or under 8 GB of memory |
| Painter | `src/components/gpuCanvas/painter.ts`, `PainterSheet.tsx` | Renders batches of real nodes on a sheet inside `<canvas layoutsubtree>`, paints the sheet into a texture, copies each node into its atlas slot |
| Disk cache | `src/lib/gpuCanvas/paintCache.ts` | Painted images in IndexedDB (`node-banana-paint-cache`), by paint key and tier |
| Live layer | `src/components/gpuCanvas/LiveLayer.tsx` | A real `<ReactFlow>` over the scene holding the live nodes and the connections that show more than a line. It renders under the page's `ReactFlowProvider`, so it is the page's React Flow: `screenToFlowPosition`, `setCenter`, the viewport portal and the selection toolbar answer for the GPU canvas, its viewport kept equal to the scene's both ways |
| Bridge | `src/components/gpuCanvas/bridge.ts`, `GpuMinimap.tsx` | The whole scene graph and view for chrome that needs every node (the minimap, Fit view, the agent bringing its edits into view), since React Flow holds only the live ones |
| Shell | `src/components/gpuCanvas/GpuCanvas.tsx` | Builds the rest, follows the store, shows the loading screen |

## Tiers

A node is painted at a tier: 1/8, 1/4, 1/2, 1 or 2 texels per css pixel at
100%, up to the display's scale. The view wants the tier matching zoom ×
scale; a node shows the smallest tier it holds that is that sharp, else its
sharpest. Every node keeps a 1/8 image, so once a workflow has been painted
a zoomed-out view never falls back to stand-in cards. Larger tiers are painted for the view and its margin and are
evicted, longest unseen first, when the atlas needs room; the view's own
tier near the view is never evicted.

A shown tier sharper than the view is minified by up to 2×, so the node
shader samples it with four bilinear taps spread over each pixel's footprint
(kept inside the node's atlas slot) rather than one, which would skip 1 px
borders and text stems by sub-pixel phase and shimmer while zooming. At the
tier's own scale it is one pixel-snapped tap.

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
  edges meet the painted sockets, and the size goes to the store as React
  Flow's "dimensions" change (as do a live node's), so `getNodeSize` and the
  arrange commands see real heights as on the classic canvas. A width change
  moves the measured handles at once (right-hand ones with the right side,
  `refitMeasured`) until the node is measured again, as React Flow measures
  its handles on the frame a node's size changes.
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
  checkpoint) does not land mid-pan. Only view moves (pans, wheels) and drags
  set it, with classic's 120 ms tail; a bare press (a click) does not. A node
  or wire drag holds it for its whole length: a pause mid-drag does not let
  the pan tracker drop it.

## Opening a workflow

A workflow opened from a file is framed as today's canvas frames it
(`frameLoadedGraph`), or the tab's saved view is restored. Painting starts
over from that view. The first frame uses the default node heights; once
every node has its painted height (or after 2 s, on what is known then) it
is framed again on those, as classic frames on measured sizes, unless the
view has moved since. A workflow of 150 nodes or more that is not painted
within 300 ms shows the loading screen ("Opening workflow", N of M), which
stays until the view is sharp and every node has its 1/8 image. Behind it
the sheets are 4096×3072 and nothing waits for quiet, since nobody can pan.

Reopening reads the disk cache: each entry is the image's raw RGBA,
deflated, with the node's height and handle anchors (with each handle's
box and whether a connection may start or end on it). Images are read back
from the GPU without stalling (a pixel buffer and a fence) and stored once
the GPU is done; the cache is trimmed to 512 MB, least recently used first.
A hit marks its entry used only when its last use is a day old: marking
rewrites the entry, and doing it on every hit held up the next batch's
reads (a reopen ran slower than the first open). A batch's hits are
inflated together.
The key includes the app version and display scale, so an update or a
different screen paints afresh. A node's file refs (`imageRef`, `inputImageRefs`, …) are left out of
its key: they name the file its media was saved as, so a save that records
them repaints nothing.

## Live nodes

A node is live (a real component on the live layer) while it is hovered
(its painted sockets, a little outside its box, hover it too, as classic's
handles sit in the node's element), selected, holds focus, is opened, or is visible above 100% zoom. A node just
added (dropped, pasted, from a menu or a key; up to 8 on screen) is live
until its first picture shows ("added"), as classic renders it whole at once; further
added nodes on screen (a large agent batch, grid cells) are drawn as nothing rather than as
the stand-in card until their picture lands (`Scene.holdStandIn`, 3 s at most). A node a
file, a node type from the action bar or a history image is dragged over
is live ("drop"), so the drop lands on its own drop zone (an empty input
loads a file and swallows the rest, as on classic) rather than the
canvas's, which adds a node: browsers send no pointer events during a drag. Its scene
image stays until the live component is measured and decoded, then is
hidden, so the swap shows no gap; until then the live component and its
floating header are laid out but invisible (`gpu-entering`), so nothing
shows doubled over the picture (a node with no picture yet shows at once).
Only the entering nodes' own images and videos (and their headers') hold
the swap, never media elsewhere on the layer. The scene starts a painted
image on a whole css pixel; a live node and its floating header are moved
(an inline `translate` on each element, written only where it changed, so a
pan or zoom frame restyles no more than those elements) by the same offset,
so the swap does not shift them.
A pressed node stays live until the press ends, a press its fields keep (a
slider, a Split Grid line) included, and a hover holds while a
button is down (as NodeShell ignores a leave then). Focus survives the
window losing it, so the field has it back on return. When it stops being live
it stays on the layer until its painted image is current (it may have been
edited while live), however long the painter holds that paint back (a pan, a
wheel); only a paint that is not coming is given up on after 1.5 s.

The layer hands React Flow new node objects on each render, carrying the
size React Flow measured: without it React Flow hides the node until it
measures it again, which blurs a field being typed in. What React Flow
measures of a live node (its height, its handles) also goes to the scene, so
presses, the marquee and its connections follow a node that grew or shrank
since it was painted, and sockets that moved or were renamed at the same
size (React Flow re-measures them with no "dimensions" change then, so
`LiveFlow` watches each live node's `handleBounds` itself). A paint of a live node (its painted copy hidden) is
only held by the painter: it changes neither the scene's box nor the store's
measured size, which stay React Flow's, and a rebuilt graph takes the live
sizes again. Once the node leaves the layer the scene and the store take
the painted measure back (`Painter.restoreMeasured`).

A controls card widened past its node (its grips, `data.controlsWidth`)
overflows both sides, as on classic: the node's picture is widened by the
overhang (`controlsOverhang`), and the card's measured box
(`SceneNode.overhang`, kept in the disk cache) takes presses and hover.

A node's controls card trails it while it moves, as classic's
(`useTrailingOffset` in NodeShell). A live node does that itself; painted
copies turn the hook off. A painted node the store moves (a group's header
drag, arrange, undo) trails in the scene instead (`src/lib/gpuCanvas/trail.ts`,
`Scene.nodesMoved(…, true)`). The scene keeps a smoothed position per node,
and the node shader draws the part of the picture below the media card offset
by it. A node turning live or painted, and a rebuilt graph, start still.

What marks a node's element from outside goes to its live copy: the
agent's edit shimmer and the tutorial's ring hold the nodes in view live
(the bridge's `holdLive`) and mark them there, never the painter's sheet
(which never paints a shimmer).

A node's own view state (a collapsed controls card, the Primary/Fallback
tab, an Array's opened sections and item, a trim's source/output toggle,
an OpenAI size field's "Custom…", an Image Compare divider) lives in
`nodeUiStore` on the GPU canvas (`useNodeUiState`; plain local state on
classic), so the live component and its painted copies show the same, and a
change repaints the node. The divider is written once it rests, not per
drag frame. It is forgotten when the node goes or another
workflow opens, as classic's remount forgets it. State classic resets by
remounting the component holding it is reset here too: the size field's
"Custom…" is kept per model block and model (`useNodeUiState`'s `scope`;
ModelParameters' `slot`), and the divider goes back to the centre when an
input disconnects. Painted copies never show
hover: their headers' hover-only controls and hover video previews read no
hovered node.

Neither flow holds every connection (the sheet holds none, the live layer
only those it decorates), so sockets read whether they are connected from the
store's edges (`StoreSocketConnections`) rather than React Flow's lookup. A
painted image takes in the node's sockets' full swell and ring at its sides
(`PAD_X`). A selected node's width grips work as classic's: React Flow's
resize and NodeShell's widths for the other selected nodes (and the
double-click reset) reach the store (`resizeChanges`). Nodes classic dims
(downstream of a disabled Switch output, skipped) take its classes when live
and fade to the same opacity in the scene, over the same 250 ms, their
floating header left as it is.

Live nodes take the pointer: React Flow sets `pointer-events: none` inline
on nodes it cannot select or drag, which is every node of the live flow, so
the live layer's style overrides it. Its connectable sockets take the
pointer again (React Flow's `connectionindicator`, lost to
`isConnectableStart={false}`), for their tooltip, crosshair and hover. It
also gives back classic's draggable
cursors (grab, grabbing while dragged, the arrow when locked or under a
dialog) and its selectable nodes' missing focus ring. Hover follows the live
node the pointer is on (its floating header included) as well as the scene's
hit test.

Nodes stack as classic's: in store order, a selected one raised. The live
flow holds its nodes in store order, and since the live layer draws over the
scene, a node later in the store that overlaps an unselected live node (a
hovered or dragged one) goes live with it ("cover"), so it stays on top.
Floating headers sit over every node: the scene draws painted nodes'
headers in a pass of their own after the nodes, and where a live node would
cover a painted node's header, the live flow shows that header and the scene
leaves it out (`setHeadersLive`). A header band answers presses before any
node's box, as classic's headers take them. Classic's headers sit above the
group labels and menus too, which are DOM in the live flow: a node whose
header a group's label or open menu overlaps goes live ("groupChrome", the
chrome measured once it settles), so its header shows above them again.
Groups are classic's faint wash (`groupFill`) with no outline. A group's
title and resize grips sit in classic's zoom pane without `nopan` and listen
only for mousedown, which d3-zoom swallows when it pans: wherever the pane
would pan with that button (off the Mac by default, "always", the right
button in "middleMouse", Space held in "space"; never with Control or the
selection key), a press on them pans on the GPU canvas too and the live
layer stops their mousedown (`Editor.groupChromePans`).

## Live content

Today's canvas keeps some nodes mounted whatever the view (`nodeCulling`'s
always-mounted types) because their component holds what the store does
not. On the GPU canvas a node stays live for as long as it holds something
(`liveContent.ts`, `useHoldLive`):

- **held**: the node shows something of its own: a model browser, a
  lightbox, a variables or presets dialog, the grid editor, an open
  dropdown, its floating header's title rename, comment editor or menu.
  The component holds itself live with `useHoldLive(open)`; focus in the
  floating header counts as focus in the node.
- **playing**: its video or audio plays (play pressed, or a hover preview),
  so playback and its sound go on when the pointer leaves (the audio
  nodes, whose clip is a detached `Audio`, hold themselves while it plays). Videos are not
  textures in the scene: a playing one is a real `<video>` on the live
  layer, and a still one is painted at its first frame (painting waits for
  it, as for images).
- **animated**: a GIF Encoder holding its GIF, so the GIF plays as it does
  on today's canvas (a picture would hold one frame). Other animated
  images (a GIF or animated WebP shown by another node) are painted still.
- **resident**: the 3D viewer, always: it holds a WebGL view the user orbits.
  Its blob URL outlives an unmount unless the node or its model went.
- **pending**: a ComfyUI node with a workflow to import or a "Replace
  workflow…" to answer, or a run streaming previews.
- **running**: a node loading its output, so its spinner turns. Its
  connections show the comet at any zoom (other decorated connections go
  live from 15%, where classic stops drawing connections). Decorated
  connections new to the view wait while it moves, then turn live
  `LIVE_EDGES_ADDED_PER_FRAME` (24) a frame, nearest the middle first, so a
  zoom past 15% with every connection hidden does not mount all their pills in
  one frame. A hidden connection is masked under painted nodes only where
  another node lies over its handle strokes (`paintedCover`).

Zoomed out past the low-detail zoom (Settings › Canvas), running nodes stay
pictures and the scene draws today's low-detail running halo over every node
the run is on, pulsing (static under reduced motion). A run's outline shows
in a node's picture: the run is marked on its paint key apart from its data
(`runMark`), so a run starting repaints the nodes near the view at once and
the rest as the view reaches them, and the nodes they feed are not touched.

A painted copy writes nothing, with one exception: effects that keep
values derived from upstream in a node's data (a Switch's input type, a
Prompt Constructor's text, an Array's items, a resize's source image, clip
order, a generate node's model inputs and schema defaults, and the encoder
check of Video Stitch, Video Trim and Ease Curve) write through
`useDerivedNodeData`; the schema writes check the stored node, since a copy
can be a batch behind it. A copy still fetching its model's settings,
decoding an audio waveform or extracting video posters (Output Gallery,
Video Stitch) marks itself pending (`PaintPending`, `data-paint-pending`),
and painting waits for it as for images, or paints it provisionally and
again later. Waveforms are cached by their source and posters by their
video (`videoPosterCache`), so a node mounted again shows them at once. A node is painted again whenever
something upstream changes, so that is where it derives. Output nodes run on
a new connection through a store watcher (`outputAutoRun.ts`) instead of
their component, and a failed generation's toast comes from one too
(`errorToasts.ts`), once, whichever copies are mounted. Two more watchers
stand in for effects that run once per mount on today's canvas, where every
node stays mounted: a Prompt node copies its connected text when the canvas
opens, when it appears and when the connection arrives
(`promptConnectedText.ts`), so a hand edit survives hovering it; and a Video
Trim node learns its source video's length when that source changes
(`videoTrimDuration.ts`), though it is a picture. A video player's
sound icon follows the shared setting: it is part of the node's key. Annotation opens its editor from the live node, as today.

## Editing

The scene takes every press and asks the editor what it starts:

- **A handle** (a live node's, or a painted one where its socket reaches:
  its box and the 30×34 ellipse round it, or 9 px from its centre at small
  zooms; never a hidden legacy socket, which takes no pointer): a click
  selects its node as a node click does and opens the handle menu at the
  socket, and so does a release within 4 px of the press after the line
  showed; a node over a socket covers it, as its element takes the pointer
  on classic. A drag (from the first pixel, React Flow's
  `connectionDragThreshold`) draws React Flow's default connection line (1 px of
  `#b1b1b7` in flow units) and finds a handle as React Flow does: the one
  under the pointer, else the nearest centre within 20 flow units. The line
  ends on it only if the connection would be made. While it is drawn, the
  connectDragStore tells nodes so: the node it starts from, the node under
  the pointer, a valid target and up to twelve other nodes on screen (those
  with a socket that could take it first, then the nearest;
  `connectCandidates`, worked out again as the view moves) turn live, show
  their socket labels, and the target's socket fills. A valid drop connects; anything else goes to
  `handleConnectEnd` with the node under the pointer (its sockets' reach
  counts, as their elements do on classic), which connects to a compatible
  handle there or opens the connection drop menu as today. Within 40 px of
  the canvas's edge the view pans while the line is drawn, faster nearer
  the edge (React Flow's `autoPanOnConnect`, speed 15). A live node's
  sockets start no React Flow connection of their own (Socket's
  `isConnectableStart` is off in the live layer): the editor's is the only
  one. Hidden connections' stubs give way to the socket labels meanwhile
  (EditableEdge reads the connectDragStore too). The line is drawn in the
  live flow's viewport at React Flow's z-index (1001), so it passes under
  the multi-select toolbar; the marquee and the selection frame sit in the
  flow after its renderer, under its panels (the navigator), as classic's
  do. The selection frame is sized in flow units and scaled by the zoom, as
  React Flow's nodesselection rect, so its dotted border scales too. On a locked canvas a socket still connects, with no line drawn, as
  classic's sockets do (React Flow hides the line while nodes are not
  connectable). The line is held in flow units: a wheel, pinch or auto-pan
  mid-drag keeps it on its socket and finds what is under the pointer again.
  Connections and drags hold their nodes by id, so nodes added or removed
  meanwhile (which rebuild the scene graph) do not change what they act on.
- **A connection's end** (React Flow's reconnect anchors: a circle of 10
  flow units round each end, shifted 10 outward, under nodes and handles;
  the `move` cursor): a drag hides the connection and draws the line from
  its other end; a valid drop is WorkflowCanvas's `handleReconnect`, any
  other goes to `handleConnectEnd` and the connection stays. A press that
  does not move is a click on the connection. A locked canvas still
  reconnects, with no line drawn, as classic's anchors check no lock.
- **A node**, its floating header included (the 30 flow units above it,
  painted or live): a click selects it (Shift adds or removes it), and
  leaves a selection it is already part of as it is; a click on a live
  node's field selects it too (the live flow's `onNodeClick`).
  Where nodes overlap, a live node answers before a painted one and a
  selected one before the others (React Flow raises selected nodes). A drag
  (from where the pointer is once past 5 px, so nothing jumps) moves the
  selection when the node is part of it; an unselected node clears the
  selection and moves alone, or with the selection while Shift is held and
  is not the selection key (React Flow's `selectNodesOnDrag` off). The
  first move records the undo step, the moves in between go only to the
  scene graph and the live layer, and the drop goes to the store and to
  `onNodeDragStop` (group membership). Dragged nodes are held by id where
  the drag puts them (`SceneGraph.hold`), so a store write to one mid-drag
  (a run's status, an edit elsewhere) does not move it back. Near the
  canvas's edge the view pans every frame and the nodes move with it
  (React Flow's `autoPanOnNodeDrag`); a floating header's drag has no
  auto-pan, as FloatingNodeHeader's own drag. Space held (the "space" pan mode)
  pans only from empty canvas: a node still drags and a handle still
  connects, as they are React Flow's `nopan`. A connection is `nopan` too:
  a left drag from it moves nothing in any pan mode, and a release still on
  it clicks it, however far the pointer went; that click is the release's
  (its point places the toolbar, its Shift selects). A press on a floating header
  is FloatingNodeHeader's drag whatever the pan mode and the lock (and the keys, but the
  selection key: see below): it makes
  an unselected node the only selection at once, moves past 5 px on either
  axis (the selection too only if the node was already selected, following
  the pointer from the press) and regroups every moved node on release.
  On the Mac a Control+click is a secondary click, which fires no click: it
  starts nothing (not a selection, a drag or a marquee), only the menu. A press on a
  live node takes the pointer only once it becomes a drag, so a click still
  reaches what it lands on (an Output image's lightbox, a waveform's seek).
  A live node's buttons and links drag it too, as React Flow's do (only
  fields and `.nodrag` keep their presses); a drag from one swallows the
  click its release makes, as d3-drag's does. A still press on one selects
  through the node's own click (React Flow's `onNodeClick`, `liveButtonPress`),
  not the scene's, so a button that stops its click (Annotation's Download)
  leaves the selection as classic does. Dragged live nodes re-render
  synchronously with each move (`LiveLayer.refresh(true)`), so their bodies,
  headers and sockets move in the frame that draws their connections. While
  any gesture runs, no text selection or native drag starts (d3-drag's
  `nodrag`).
- **A connection** (within 10 flow units of its centre line, React Flow's
  interaction path, and never less than 7 px past its stroke; a bundle's
  shared stem counting for the connection that draws it, as BundleStem's
  hit path): selects it, as React Flow would; Shift
  adds it, unless nodes are selected (WorkflowCanvas drops connections from
  a selection with nodes in it). On a locked canvas it selects nothing but
  still moves the connection toolbar there.
- With the selection key held (Shift, or Alt in "altDrag"), a press on a
  handle, node or connection is a click that toggles the node or
  connection, and any movement turns it into a marquee: no connection
  starts, as React Flow's pane takes the press first. A socket, its half
  outside the node's box too, counts as its node, as the click bubbles from
  the handle to the node's wrapper. As React Flow's pane captures every such
  press inside it (save on `.nokey`), the live layer hands the scene presses
  on a live node's fields, `.nodrag` controls and buttons, on floating headers,
  group chrome and connection labels too, before they get them
  (`selectionKeyTakesPress`): no focus, no control moves, a drag draws the
  marquee. A still press clicks only what classic's click reaches: a node's
  own click (LiveFlow's `onNodeClick`) from inside a live node, nothing from a
  header, group chrome or label.
- **The pane**: a click clears the selection (not on a locked canvas) and
  is WorkflowCanvas's pane click, whatever a drag would do; a drag pans or draws the marquee as the
  navigation settings say (`paneDragAction`); drawing on drag (the Mac
  default) starts only from empty canvas, once the press moves (at once with
  the selection key), and clears the selection as it starts. The marquee
  takes a node only when it holds its media card (a live node's as it shows
  when the marquee starts, a painted one's as painted), or the whole node
  without one; with no nodes taken it selects the connections it crosses,
  a bundle's shared stem counting for the connection that draws it. Nodes
  it took are framed (React Flow's dotted `NodesSelection`) until a click or
  until none is selected. A press on empty canvas that neither pans nor
  draws (the tutorial, Control held, the right-button pan mode, a locked
  canvas where a drag would draw the marquee) is a pane click however far it travels, if released over the
  canvas, as the browser's click there. Its start is held in flow coordinates, so a
  wheel pan or pinch mid-marquee keeps it on the same canvas spot. Empty
  canvas shows the pointer cursor while a drag there would draw a marquee
  (the selection key held, or the Mac default), changing as the key goes
  down or up, as React Flow's pane with its `selection` class, and grab where
  a left drag would pan (its `draggable` class: Space held in the "space"
  mode, the "always" mode, off a Mac); a pan shows grabbing from the press,
  and so does a node drag.
- On a locked canvas nodes take no pointer, as React Flow gives them
  `pointer-events: none`: a press on one is the pane's (a drag pans as the
  pan mode says, a click is a pane click), and live nodes' controls are
  inert. Sockets still connect and connection ends still reconnect (a wire
  released on a node's body, off its sockets, names no node, so it offers
  the add-node menu), and a floating header still selects and drags its node.
- Every change in the selected nodes or connections, a press's or the
  store's own (paste, undo, the agent), reaches WorkflowCanvas's
  `handleSelectionChange` once it is through, as React Flow's
  `onSelectionChange`: it closes a connection toolbar whose connection is
  no longer selected and drops connections from a selection with nodes.
- **Hold H** and drag across connections (classic's `EdgeHookSelection`,
  mounted over the GPU canvas too): the sweep crosses the scene's routes
  (`routePolylines`, through the bridge's `edgePaths`) instead of SVG paths,
  and the caught connections route through the fork as they are carried
  (`RouteContext.hookDrag`); the release bundles them there.
- **Delete / Backspace** (alone, outside a field or `.nokey`, with no
  modal open; a non-modal dialog such as the recent-generations drop-down
  does not stop it, as on classic) removes the selected connections, then nodes. The arrow keys
  move the selection 5 px (20 px with Shift) while focus is on nothing or on
  a selected live node; Enter, Space or Escape selects a focused node (a
  live one holding focus, or the painted node last pressed while focus is
  on nothing) that is not selected, and Escape (or Shift with Enter or
  Space) unselects a selected one and drops its focus, as React Flow's
  `handleNodeClick`; a Shift click that unselects a node drops it too. Escape leaves a gesture going, as React Flow does.
- **Tab / Shift+Tab** step through the connections, then the nodes, in the
  store's order as on classic (`keyboardFocus.ts`): a node is made live,
  centred at the same zoom when off screen (React Flow's
  `autoPanOnNodeFocus`) and focused, its own fields in turn; a connection's
  focus is held by a sentry at the head of the canvas named after it, its
  stroke unchanged as classic's (only the pointer hovers a connection), and
  Enter or Space selects it, Escape unselects it. A click on a connection focuses it the same way (classic's click
  focuses its EdgeWrapper), so those keys act on it, not on a node pressed
  earlier. Past either end focus goes to the page around the canvas.
  Right-click opens the pane or connection menu (on a node, its header or a
  handle the browser's own, as on classic). The connection menu opens in
  every pan mode; on the pane the browser's menu never shows, and the
  add-node menu does not open under a dialog or in the tutorial. In the
  "middleMouse" mode the right button pans, and a right press that did not
  move opens the add-node menu at its release, as React Flow's d3-zoom end
  does (`Editor.rightPan`); a right drag pans with no menu. A double-click on the pane
  opens the add-node menu (not on a connection or a handle), and one on a
  node is the node's own: the view stays put.
- The wheel is decided as classic's two handlers decide it (`wheel.ts`):
  a pinch, or a wheel with React Flow's zoom key (Meta on macOS), zooms
  about the pointer by d3-zoom's delta; otherwise `useWheelPanZoom`'s rules
  apply: an inner area that can still scroll keeps the wheel, the zoom
  modifier steps 1.2x about the centre, a macOS trackpad pans, and any
  other wheel does nothing. With Space held (the "space" pan mode) a wheel
  pans at half speed (React Flow's `panOnScroll`) and only a pinch zooms.
  Over chrome beside the canvas (the agent pill, the history drop-down,
  anything else in the canvas's wrapper) only the wrapper's rules apply,
  through a listener on the wrapper (`wheelRoot`). A wheel on the canvas
  hovers the node under the pointer, and hover is tested again as the view
  moves under a still pointer, so a node brought under it turns live and its
  inner areas take the wheels that follow. Until then, a wheel over a
  painted textarea or `.nowheel` area that held more than it showed when
  painted (`scrollAreaBoxes`, kept with the paint and in the disk cache) is
  held rather than panning or stepping the zoom (`holdOverScrollArea`); a
  pinch still zooms over a textarea, not over `.nowheel`. As classic's `onMoveStart`, a
  moving view clears the store's hovered node (header controls, video hover
  previews) and sets `isPanningRef` until it has been still 150 ms.
- Two fingers pinch about their midpoint and pan with it, as d3-zoom's touch
  zoom (off in the tutorial and under a dialog); the second finger drops what
  the first began, one left pans, and a gesture follows only the pointer that
  started it.
- A middle press on a node's body or a connection pans in any pan mode, as
  React Flow's zoom filter allows (not on a floating header, which sits
  outside the node, nor on a locked canvas, whose nodes let the pointer
  through: those follow the pan mode); a right press (the "middleMouse" mode) pans only
  from empty canvas or a floating header (live or painted, its buttons
  included, not its `nopan` elements), as nodes, handles and connections are
  React Flow's `nopan` and the header sits outside the node (a left drag from a
  connection pans in no mode). No drag pans with Control or the selection key held.
- The view keeps classic's limits, 10% to 400% (`src/lib/canvasZoom.ts`,
  the live flow's too). Fit view frames every node as React Flow's
  `fitView` (10% padding); a minimap click glides the view there over 250
  ms. The minimap pans from the first move and zooms by React Flow's
  minimap step (line and pixel deltas, a Mac pinch ten times over). While
  the tutorial locks the navigator it takes no gestures, as classic's. Its
  nodes sit on a canvas of their own, drawn again (one fill per colour) only
  when the layout, its size or its fit changes; a pan redraws only the mask
  over them. Drawing every node per frame held a 5,000-node pan to 37 fps.
- The dot grid is React Flow's `<Background gap={20} size={1}>`: the same
  offset, one dot every 20 flow units at every zoom, dots of half a flow unit's radius that grow and shrink with the
  zoom, at 30% while the tutorial locks the canvas. A move the page asks of the flow (`setCenter` or `fitView` with a
  duration) runs to its end: the scene follows the flow's transition
  without handing the view back, which would interrupt it.
- On empty canvas a drag that pans moves the view from the first pixel
  (React Flow's `paneClickDistance`, 1 px); only a press that stays put is
  a pane click.
- While the tutorial runs no drag pans (React Flow's `panOnDrag` and
  `panActivationKeyCode` off): a press that would pan selects, drags and
  connects as a plain one. Nodes still move, connect and select.

The live flow and the painter's sheets are React Flows too, so they take no
keys (`deleteKeyCode`, `panActivationKeyCode` and the others null): React
Flow's default handlers preventDefault Backspace and Space on the document,
which would stop Backspace deleting.

Strokes are always the scene's. A connection with more than a line (a label,
a hidden stub, a bundle, pause, loop, the loading pulse, an array item) and
every selected one is also rendered as a real `EditableEdge` on the live
layer, with its path hidden, for its decorations and toolbar; the painted
nodes it ends at are stood in for by invisible nodes with the painted
handles. That happens near the view (a quarter screen round it, checked
every frame while the view moves) from 15% zoom, where classic stops
drawing connections: every one on screen, however many, and those in the
margin while fewer than 250 are live, the nearest the view's centre first.
The live layer draws over the scene, so a live connection's SVG
decorations (the comet, pause badge, hidden stubs and ghost) are masked
where a painted node lies over them (`paintedCover`, `EdgeMask`), as
classic's nodes cover its edge layer; its pills (`EdgeLabel`) are clipped
by the same boxes through `EdgeLabelCoverContext` (null on classic). A selected angular connection's
segment handle takes the pointer and drags as on classic, and the scene's
hovered connection brightens its live label (`edgeHoverStore`). A hovered
connection (and its bundle stem) is drawn at full strength, as classic's
`:hover` stroke, and the gradient spans the noodle's own extent (from a
bundle's split point, not the handle behind its stem), as classic's
`objectBoundingBox` gradient. A stroke thinner than a css pixel is drawn a
pixel wide and as faint as its share of it, as the SVG antialiases a hairline,
and a long curve is cut into pieces of at most 96 flow units so it stays smooth
at 400%. Strokes are antialiased over a device pixel, as the browser
rasterises an SVG stroke, so they stay crisp on HiDPI screens. Only a route's
two ends take round caps (antialiased, on their own rows of the instance
strip so the distance past the end is exact), so a faded connection's bends
are not darker where its segments meet. Where hit
bands overlap, the later connection (drawn on top) takes the press, as the
browser gives classic's topmost interaction path. A connection whose measured
end has no such handle (a removed input, a stale id) is not drawn or taken, as
React Flow renders none; one naming no handle meets its node's first. A reference
link's dashes are laid out by arc length (its curve is cut into short pieces)
with round ends, as the SVG's "6 4" round-capped dashes, and it stays grey when
paused, as `ReferenceEdge` reads no pause. Hover over connections and painted handles
ends when the pointer leaves the canvas, a gesture moves or a wheel moves the
view (classic's edges and nodes take no pointer events while the canvas is
interacting), until the pointer moves again.

## What phase 3 leaves out

- While a connection is drawn, on-screen nodes past the twelve made live
  keep their pictures without socket labels (classic shows every node's).
- A live connection's SVG decorations and pills are masked by a painted
  node's whole box, gaps between its cards included (the pills by its
  square corners). Hidden stubs' chips and a bundle's clamp sit over every
  node on classic too, and are left unmasked.
- A node whose look depends on state outside its data and its inputs (a
  file loading elsewhere, a timer) may paint stale until its key changes.
- A wheel over a painted node's scrolling text is held, not passed to the
  text, until the node is live a few frames after it comes under the
  pointer; past the text's end it is held too, where classic would pan.
- A painted node shows its scrolling areas at the top and a paused video at
  its first frame, wherever they were left while it was live.

## What phase 4 leaves out

- Videos are never textures in the scene: a playing video is a live
  `<video>`, so many playing at once cost what they cost on today's canvas.
- Animated images other than a GIF Encoder's output (a GIF loaded into an
  image node, say) are painted at one frame until the node is live.
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

The desktop smoke test (`npm run electron:smoke`) adds a Prompt, makes it
live and types into it. In a Linux container pass
`NODE_BANANA_SMOKE_CHROMIUM_FLAGS="--no-sandbox --use-angle=swiftshader"`
and run it under `xvfb-run`. The acceptance and large-workflow runs check
recovery through the same `window.__gpuCanvas` calls.

`window.__gpuCanvas` (stats, painter status, sharpness, view, node rects,
live nodes, `paintNow`, `repaint`) is what the runner drives.

The stats also keep frames over 250 ms with the painter phase they ended in,
and the browser's long animation frames with their slowest scripts; the
`tiers` check prints both. That is how a stall outside the painter (an
autosave settling every node's media in one task) was found.
