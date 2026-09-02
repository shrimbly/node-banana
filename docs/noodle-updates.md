# Noodle Updates

Work on the connections between nodes ("noodles"): how they look, how they
behave, hiding them, labelling them, and bundling them.

**Branch:** `feature/noodle-updates` (off `develop`)
**Started:** 2026-09-02
**Status:** in progress — items 1 to 3 done, item 4 next

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
- [x] Settings UI in Project Settings → Canvas (`ConnectionSettings`); the action-bar button cycles the three line styles
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
- [x] Labelled stub at each handle ("Image 2", "Text"), stacking in creation order when a handle has several hidden; hovering a stub ghosts the noodle, clicking it shows the connection
- [x] Hidden edges are not selectable and lose their selection when hidden
- [x] Execution, validation, copy/paste and save/load are unaffected: the edge stays in the array with a data flag

### 4. Noodle labels

- [ ] `label` on edge data, edited inline from the toolbar or by double-clicking the edge
- [ ] One `EdgeLabel` component via `EdgeLabelRenderer`, replacing the `foreignObject` loop badge and the SVG pause marker
- [ ] Auto labels: data type, "Image N" sequence (today only shown in the toolbar), loop count, pause
- [ ] Visibility setting: always / on hover or select / never
- [ ] Placement along the path, offset when parallel edges stack

### 5. Noodle grouping and bundling

Parallel connections read as one. Visual only: execution is unchanged and
the Router node stays for execution-time fan-out.

- [ ] Automatic bundling of edges that share a source and target node (off / on / auto above N)
- [ ] Manual bundles from a selection, stored as `bundleId` on edge data
- [ ] Bundle draws as one trunk fanning out at the handles, with a count badge; expands on hover or select
- [ ] Toolbar acts on the whole bundle: pause, hide, delete, label, colour
- [ ] Document when to use a bundle and when to use a Router node

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

- Bundling default: opt-in via the appearance settings first, automatic later once the rendering is proven.
- Labels on hidden edges: show the label as the stub, or hide both?

## Non-goals

- Changing execution semantics of edges (loops, pause, router passthrough).
- Auto-layout or routing edges around nodes. A separate, larger piece.
- Touching the agentic workflow proposal format beyond carrying the new edge fields.
