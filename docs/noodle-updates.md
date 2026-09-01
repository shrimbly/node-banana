# Noodle Updates

Work on the connections between nodes ("noodles"): how they look, how they
behave, hiding them, labelling them, and bundling them.

**Branch:** `feature/noodle-updates` (off `develop`)
**Started:** 2026-09-02
**Status:** in progress — item 1 is next; nothing coded yet

## Goal

Make noodles something users can shape. Customise how they look, make them
behave predictably, hide them when they get in the way, label them, and bundle
parallel runs so a busy canvas reads cleanly without inserting a Router node
just to tidy wiring.

## Work items

### 1. Edge appearance settings — in progress

One place to customise noodles: line style (curved / angular / straight),
thickness, colour mode (by data type / single colour / per-edge override),
dimmed-edge opacity, and gradient and loading-pulse on/off. Persist as a user
default in localStorage (`node-banana-edge-appearance`) with a per-workflow
override in the workflow file, mirroring how `edgeStyle` and the generation
defaults already split.

- [ ] Single source of edge and handle colour tokens (replaces the four copies below)
- [ ] `EdgeAppearance` settings type in the store, with save/load, dirty-check and undo parity with `edgeStyle`
- [ ] Settings UI (the curved/angular toggle in the floating action bar stays as a shortcut)
- [ ] `EditableEdge`, `ReferenceEdge` and `SharedEdgeGradients` render from the settings
- [ ] Per-edge colour override from the edge toolbar

### 2. Noodle behaviour polish

- [ ] Re-plug a connection by dragging its end (`onReconnect`), keeping pause, loop and label data
- [ ] Anchor the edge toolbar to the edge midpoint instead of the last mousedown position
- [ ] Selected edges render above nodes (`elevateEdgesOnSelect`); hover highlight agrees with the gradient stroke
- [ ] Curved mode gets the same offset/curvature handle angular has, or stale offsets are dropped on style change
- [ ] Multi-select edges and act on the set

### 3. Hide connections

Hide without losing. Hidden edges still execute, validate, copy/paste and
save; they just leave selection and hit-testing.

- [ ] `hidden` on edge data, honoured by React Flow
- [ ] Hide per edge, all edges of a node, or globally, with a keyboard shortcut
- [ ] Stub or count badge on affected handles; hovering a handle reveals its hidden noodles
- [ ] Entries in the edge toolbar and the node context menu
- [ ] Execution, validation, copy/paste and save/load verified unaffected

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
| Style toggle | `EdgeStyle = "angular" \| "curved"` in `workflowStore.ts` | The only customisation today. Toggled in `FloatingActionBar.tsx`; saved in the workflow file; store default `curved`, load fallback `angular` |
| Colours | `EDGE_COLORS` in `EditableEdge.tsx` and again in `SharedEdgeGradients.tsx`, handle rules in `globals.css`, `HANDLE_COLORS` in `RouterNode.tsx` | Four copies and they disagree (image `#0d9668` on edges vs `#10b981` on handles) |
| Gradients | `SharedEdgeGradients.tsx` | 11 colours × active/dimmed rendered once; edges touching a selected node get the bright variant |
| Loading pulse | `EditableEdge.tsx` + `flowPulse` in `globals.css` | Three overlay paths while the target generate node is loading |
| Hit area | transparent 15px path (10px on reference edges) | |
| Toolbar | `src/components/EdgeToolbar.tsx` | Pause toggle, loop count, delete, "Image N" sequence. Positioned from a global `mousedown` listener |
| Store actions | `workflowStore.ts` | `onConnect`, `addEdgeWithType`, `removeEdge`, `toggleEdgePause`, `setLoopCount`, `onEdgesChange`, `setEdgeStyle` |
| Persistence | `workflowStore.ts` save/load/dirty-check, `undoHistory.ts` | `edgeStyle` is in all four. Any new persisted edge setting needs the same treatment |
| Overview mode | `OVERVIEW_EDGES` in `WorkflowCanvas.tsx` | Already renders zero edges as a perf trick |
| Router node | `RouterNode.tsx`, `src/store/utils/connectedInputs.ts` | The only way to bundle wiring today. Passthrough hub with dynamic typed handles, resolved at execution via `passthroughCache` |
| Dimming | `src/store/utils/dimmingUtils.ts`, `dimmedNodeIds` | Node-level only (Switch outputs); edges just follow selection |
| Unused React Flow features | `onReconnect` / `reconnectable`, `elevateEdgesOnSelect`, `EdgeLabelRenderer` | Items 2 and 4 mostly wire these up |
| Tests | `src/components/__tests__/{EditableEdge,ReferenceEdge,EdgeToolbar,WorkflowCanvas}.test.tsx`, `src/store/utils/__tests__/loopEdge.test.ts`, `src/store/__tests__/loopEdge.integration.test.ts` | |

## Open questions

- Appearance settings: user default plus workflow override is the recommendation. The alternative is workflow-only, like `edgeStyle` today.
- Add a `straight` line style in item 1, or keep to curved/angular?
- Bundling default: opt-in via the appearance settings first, automatic later once the rendering is proven.
- Labels on hidden edges: show the label as the stub, or hide both?

## Non-goals

- Changing execution semantics of edges (loops, pause, router passthrough).
- Auto-layout or routing edges around nodes. A separate, larger piece.
- Touching the agentic workflow proposal format beyond carrying the new edge fields.
