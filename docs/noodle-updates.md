# Noodle Updates

Work on the connections between nodes ("noodles"): how they look, how they
behave, hiding them, labelling them, and bundling them.

**Branch:** `feature/noodle-updates` (off `develop`)
**Started:** 2026-09-02
**Status:** all five items implemented on the branch (2026-09-03); not yet merged

## Goal

Make noodles something users can shape. Customise how they look, make them
behave predictably, hide them when they get in the way, label them, and bundle
parallel runs so a busy canvas reads cleanly without inserting a Router node
just to tidy wiring.

## Work items

### 1. Edge appearance settings — done

One place to customise noodles: line style (curved / angular / straight),
thickness, faded-connection opacity, and gradient and loading-pulse on/off.
Persisted as a user default in localStorage (`node-banana-edge-appearance`)
with a per-workflow override in the workflow file, mirroring how `edgeStyle`
and the generation defaults already split.

Decision (2026-09-03): noodle colours are not user-changeable. Colour always
follows the data type, so there is no single-colour mode and no per-noodle
colour override.

- [x] Single source of edge and handle colour tokens in `src/lib/edges/colors.ts` (replaces the four copies below)
- [x] `EdgeAppearance` settings type in the store, with save/load, dirty-check and undo parity with `edgeStyle`
- [x] Settings UI in its own Project Settings → Noodles tab (`ConnectionSettings`); the action-bar button cycles the three line styles
- [x] `EditableEdge`, `ReferenceEdge` and `SharedEdgeGradients` render from the settings

### 2. Noodle behaviour polish — done

- [x] Re-plug a connection by dragging its end (`reconnectEdge` in the store, `onReconnect` on the canvas), keeping pause and order data and re-checking the loop
- [x] The edge toolbar is rendered by the edge itself at the path midpoint (`EdgeLabelRenderer`), counter-scaled with the zoom
- [x] Selected edges render above nodes (`elevateEdgesOnSelect`); hover and selection use the edge's own active stroke via `--edge-stroke-active`
- [x] Offset handle stays angular-only. Decision: curved and straight lines have nothing to bend; offsets saved in angular mode are simply ignored in the other styles
- [x] Multi-select edges: the first selected edge carries the toolbar, which pauses or deletes the whole selection (`removeEdges`, `setEdgesPause`)

### 3. Hide connections — done

Hide without losing. Hidden edges still execute, validate, copy/paste and
save; they just leave selection and hit-testing.

- [x] `hidden` on edge data; the edge component draws stubs instead of a line, so React Flow, execution and persistence see an ordinary edge
- [x] Hide per edge or per selection from the toolbar; hide and show everything from the action-bar eye, which carries the hidden count. Decision: no per-node entry and no shortcut for now; the eye covers the global case and the toolbar the local one
- [x] Labelled stub at each handle ("Image 2", "Text"), stacked down the side of the node so pills never overlap. A handle with several hidden connections shows one plural pill ("Images") that expands into the full list on click; a click on the canvas collapses it again. Hovering a stub, or the handle itself, ghosts the noodle between the two label pills. Clicking a stub selects the connection and puts its toolbar above the label, where Show brings it back
- [x] Handle labels stay out of the way on any node side that has hidden stubs. While a noodle is being dragged the stubs disappear and the handle labels return, so the drop target is readable
- [x] Hidden edges lose their selection when hidden and can only be selected again through their stubs
- [x] Execution, validation, copy/paste and save/load are unaffected: the edge stays in the array with a data flag

### 4. Noodle labels — done

- [x] `label` on edge data, edited in the toolbar's label field (Enter commits, Escape reverts). Decision: no double-click editing; selecting the noodle already puts the field on it
- [x] One `EdgeLabel` component via `EdgeLabelRenderer`, replacing the `foreignObject` loop badge. The pause marker stays an SVG mark by the target, since its position is the information
- [x] Auto labels: "Image N" order or the data type; loop count in the same pill
- [x] Labels setting: always / on hover (hover, selection, or an attached selected node) / never. Typed labels always show
- [x] Placed at the path midpoint, offset for parallel connections between the same nodes; hidden stubs reuse the label

### 5. Noodle grouping and bundling — done

The noodles sharing one handle read as one. A fan-out is one output feeding
several nodes; a fan-in is several outputs arriving at one input handle. They
leave (or reach) the handle as a short shared stem with a count and split
further out into the individual noodles. Visual only: execution is unchanged
and the Router node stays for execution-time fan-out.

Correction (2026-09-03): the first cut bundled "parallel connections between
the same two nodes", which is not a real case; rebuilt around a shared handle.

- [x] Bundling is deliberate only. Decision (2026-09-03): the automatic modes went; a single click on a handle opens an icon bar centred above it (`HandleMenu`): the connection count, then Bundle (or Unbundle), Hide (or Show) and Remove all, for every connection on that handle. A drag on the handle still starts a connection; the pointer-down position tells the two apart, and React Flow's click-to-connect is off. An edge can be bundled at both ends
- [x] Bundles are stored as `bundleId` on the members; the edge toolbar can also bundle a multi-selection that shares a handle and unbundle
- [x] The first member draws a short shared stem at the handle; every member starts (or ends) past the stem. A glassy clamp (cable tie) sits at the split point and drags along the stem to move it, stored per handle on the node as `bundleClamps`; its tooltip carries the count. The clamp sits above elevated edges (z-index), since a selected node lifts the edge SVG over the label layer and the stem would otherwise take the press. Expands when a member is selected. Decision: no hover expansion, since members cannot share hover state without extra store traffic and selection already expands it
- [x] Toolbar acts on the whole bundle: pause, hide, delete. No label or colour on bundles (colours are not user-changeable; a bundle label would hide the members' own)
- [x] Bundle vs Router: a bundle is drawing only and keeps every connection as it is; a Router node is a real hub that fans one input out to many nodes at execution time. Use a bundle to tidy parallel wires, a Router to share one source

## Where the edge system stands today

| Concern | Where | Notes |
|---|---|---|
| Edge components | `src/components/edges/EditableEdge.tsx`, `ReferenceEdge.tsx` | Registered as `editable` / `reference` in `WorkflowCanvas.tsx`; `defaultEdgeOptions.type = "editable"` |
| Edge data | `WorkflowEdgeData` in `src/types/workflow.ts` | `hasPause`, `createdAt`, `isLoop`, `loopCount`. `EditableEdge` also stores untyped `offsetX`/`offsetY` |
| Style and appearance | `EdgeStyle` and `EdgeAppearance` in `src/types/workflow.ts`; `edgeStyle` and `edgeAppearance` in `workflowStore.ts` | Saved in the workflow file; user default in localStorage via `getEdgeDefaults`; load fallback for `edgeStyle` stays `angular` |
| Colours | `src/lib/edges/colors.ts` | One hue per type; `globals.css` `--handle-color-*` variables are kept in step by a test |
| Gradients | `SharedEdgeGradients.tsx` | 10 colours × active/dimmed rendered once; dimmed stops follow the faded-opacity setting |
| Loading pulse | `EditableEdge.tsx` + `flowPulse` in `globals.css` | Three overlay paths while the target generate node is loading |
| Hit area | transparent 15px path (10px on reference edges) | |
| Toolbar | `src/components/EdgeToolbar.tsx` | Rendered by the selected edge at its midpoint; pause, loop count, delete, "Image N" order; bulk pause/delete for a multi-selection |
| Store actions | `workflowStore.ts` | `onConnect`, `addEdgeWithType`, `removeEdge`, `toggleEdgePause`, `setLoopCount`, `onEdgesChange`, `setEdgeStyle` |
| Persistence | `workflowStore.ts` save/load/dirty-check, `undoHistory.ts` | `edgeStyle` is in all four. Any new persisted edge setting needs the same treatment |
| Hidden connections | `HiddenEdgeStub.tsx`, `src/lib/edges/labels.ts` | Stub labels and stacking; `setEdgesHidden` / `setAllEdgesHidden` in the store |
| Overview mode | `OVERVIEW_EDGES` in `WorkflowCanvas.tsx` | Already renders zero edges as a perf trick |
| Router node | `RouterNode.tsx`, `src/store/utils/connectedInputs.ts` | The only way to bundle wiring today. Passthrough hub with dynamic typed handles, resolved at execution via `passthroughCache` |
| Dimming | `src/store/utils/dimmingUtils.ts`, `dimmedNodeIds` | Node-level only (Switch outputs); edges just follow selection |
| React Flow features in use | `onReconnect`, `elevateEdgesOnSelect`, `EdgeLabelRenderer` | Wired up in item 2; item 4 builds labels on the same renderer |
| Tests | `src/components/__tests__/{EditableEdge,ReferenceEdge,EdgeToolbar,WorkflowCanvas}.test.tsx`, `src/store/utils/__tests__/loopEdge.test.ts`, `src/store/__tests__/loopEdge.integration.test.ts` | |

## Open questions


## Non-goals

- Changing execution semantics of edges (loops, pause, router passthrough).
- Auto-layout or routing edges around nodes. A separate, larger piece.
- Touching the agentic workflow proposal format beyond carrying the new edge fields.
