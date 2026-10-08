# Changelog

All notable changes to Node Banana will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed

- **fal.ai settings** — A fal.ai model's settings card could come up blank, with no message, after the model browser had just been opened: fal's model API rate-limits bursts, the app read a refusal as "no settings" and remembered it for two days. The settings and the generate path now share one schema lookup per model, a rate limit is waited out and retried, a refusal shows its reason on the node with a Retry, and nothing empty is remembered.

## [2.0.0] - 2026-10-04

The desktop release. Node Banana is now an installable app for Mac (Apple
Silicon) that keeps itself up to date (Windows coming soon), with an agent that
builds workflows on your own Claude Code or Codex subscription, a library that
keeps everything you generate, and every node rebuilt on one anatomy.

### Added

- **Desktop app** — A signed and notarised Mac app (Apple Silicon, macOS 13 or later; DMG and ZIP). The app runs its own local server, bound to 127.0.0.1 and answering only its own window; keeps provider keys encrypted in the OS profile, with an explicit import from `.env`; remembers its windows and tabs; recovers tabs and media after a crash; and restarts its backend without losing the graph. Releases are built from a `v<version>` tag into a draft release with SHA-256 checksums. A Windows x64 installer was part of this release for a few hours and was withdrawn: slow and buggy, it returns in a later release once it runs as well as the Mac app.
- **Automatic updates** — The app checks GitHub Releases 15 seconds after launch, every six hours and from Help → Check for Updates…, downloads on request, installs on **Restart to update** or at the next quit, and remembers a skipped version.
- **Agent** — A chat window in the canvas's top-right corner that creates workflows, edits the canvas and changes node settings through its own tools. Every turn runs on your Claude Code or Codex (ChatGPT) login through the vendor's CLI, never on API credits, and stops rather than spend extra usage. It works from the selection, keeps preferences stated earlier in the conversation, queues messages sent while it works, lines new nodes up with the cluster they join, shimmers the nodes it changed, keeps a history of conversations, and reads a prompting guide for the node's modality and model before writing a prompt; **Look up prompting tips** runs a web research turn and saves the notes for that model. **Start with Agent** replaces Prompt a workflow.
- **Asset library** — Everything generated or edited is saved as it is made into the Node Banana folder (Documents by default) and indexed for the Assets view (`A`): a grid with filters, favourites, tags, trash and restore, a full-screen detail with the run that made each asset, and a jump to its workflow or project. Projects saved by name live in that folder; existing project folders are found, offered and moved in. Settings → Library shows the location, storage and cleanup.
- **Batch runs** — A Runs stepper in the Run menu runs a workflow, or a group from its menu, up to 50 times in a row; every output says which run made it; Stop lets the current run finish and a second press stops now. The multi-select toolbar has its own Run, and several nodes can be run at once from their own buttons.
- **Saving** — Cmd/Ctrl+S saves (File › Save on the desktop) and works inside a node's text field. Autosave follows the edits: 3 s after the last change, at the latest 30 s after the first, never mid-run, and at once when the window loses focus; **Save automatically** turns it off.
- **Noodles** — Labels on connections; hide connections without losing them (hidden ones collapse into a pill at each end that can be renamed and jumped from, and a new one joins its handle's labelled stack); bundle parallel connections into one trunk with a clamp you can move; re-plug a connection by dragging its end; marquee-select noodles; and style, thickness, faded opacity, gradient and loading pulse in the Canvas tab. While a node runs, a comet travels along the noodles into it.
- **Canvas** — An arrange menu with a live spacing slider and grid, horizontal and vertical stacks; a navigator card holding the minimap and controls, with click-to-navigate; a floating menu in place of the header and browser-style tabs; groups in calmer Earth hues with a swatch menu; node search gestures; key caps in the shortcuts dialog; Shift+D adds a Generate 3D node and Shift+O an Output node. Loading a workflow frames its graph.
- **Model browser** — Loads every provider's list once and filters, searches and tabs it locally, with **Search Replicate and fal.ai** for a deeper search, provider notices you can dismiss, an on-disk catalog refreshed behind the request, Replicate built from its curated collections, and a model change applied to a whole selection of generators.
- **Models** — GPT Image 2.5 with OpenAI's image controls and multiple references; Gemini Omni video through the Interactions API; one catalogue for text models with the current lists (Sonnet 5.5 among them); and the Comfy Router catalog brought up to date: FLUX 3 Image (up to 10 reference images, with search grounding), Ideogram 4.5 (source images and a mask), Seedream 5.0 Flash, Eleven v4 and Eleven v4 Turbo, and Grok Imagine Video 1.5 Lite. FLUX.1 Canny and Depth, which the Router no longer serves, are gone.
- **Media** — A full-screen viewer for the recent-generations drop-down and the output gallery (stage, filmstrip, details rail, add to graph); video plays on hover; the output gallery resizes vertically; the Split Grid cell editor builds a per-cell pipeline from any node type, video included.
- **Landing page** — [nodebanana.app](https://nodebanana.app/) with the download buttons, a social preview image, a FAQ, `/download/mac` and `/download/windows` resolving to the latest installers, a sitemap, `llms.txt`, and a phone layout of its own.
- **Marquee** — A marquee takes a node once it holds the node's media card whole, controls card or not; a node without a media card is taken whole, as before.

### Changed

- **Node redesign** — Every node is now built from the same anatomy: a media card that shows images, video, audio and text at their native proportions with the sockets set into its border, a gap row for history navigation or a scrubber, and a detached controls card beneath with a summary row (provider, model, key values) that opens into a single column of tight fields. Selection, running and error outlines live on the media card only. Node height is derived from content; nodes are resized by width only, and double-clicking a resize edge restores the type's default width.
- **Sockets** — Handles are now swells in the media card's border at a fixed pitch, with a hole that fills in the type colour when connected. Handle ids are unchanged, so saved workflows keep their connections.
- **Settings in the node** — Every generation node carries its own settings, so the side settings rail and the "Show model settings on nodes" preference are gone. The ease-curve editor and presets moved into the Ease Curve node.
- **Logic nodes** — Router, Switch, Conditional Switch and Array are single cards with their rows laid out at the socket pitch.

- **One Comfy key** — The key in Settings → Providers is the one Comfy key: Comfy Cloud runs, partner nodes and Comfy Router all use it. A key an older build stored on the ComfyUI tab is moved there on start.
- **Local server boundary** — The web build listens on 127.0.0.1 unless `HOST` says otherwise, refuses cross-site requests to its API and a non-loopback `Host` while on loopback, and sends `COMFY_API_KEY` only to the engine the environment configures. The unused image optimizer is off. Next.js 16.3.8, sharp 0.35.5 and the flagged transitive dependencies are patched; `npm audit --omit=dev` is clean. The audit and what landed from it are in `docs/codebase-audit.md`.
- **Chrome** — Icons on Lucide; custom dropdowns replace every native select; dialogs share one split layout at a compact scale; the node header is quiet with a kebab menu; only user-typed labels sit on noodles; a missing input skips its node instead of blocking Run.
- **Lint** — `npm run lint` is ESLint with Next's rules again (Next 16 removed `next lint`), and `npm run typecheck` checks the app without its tests.

### Removed

- The `ControlPanel` rail, the inline-parameters preference, the aspect-fit resize gesture and per-node height writes.
- The labels setting (labels are the ones you type), the Source filter in Assets, and the header bar (the floating menu replaced it).

### Fixed

- **Agent** — A call that left an optional argument out was rejected with "expected nonoptional", so the agent could not read or tidy the canvas; "this style" with nodes selected built a new subject; preferences stated earlier in a conversation were forgotten.
- **Saving** — A save kept a ref to a file that was not in the folder and dropped the media; a failed write truncated the previous save; a slow load or save landed on the canvas that replaced it; media replaced during a save came back on reopen; saving into another folder lost live video and 3D.
- **Runs** — A stopped run could overwrite or end the run after it; a run started while a workflow loaded survived the load; two branches fed from one router lost the second's data; a connected negative prompt replaced the prompt.
- **Media** — An upload lands only on the node and canvas that started it; a re-run video edit no longer kills a copy of its output; media copied between tabs survives closing the source tab; the gallery's detail view matches the history viewer and its close button can be clicked.
- **Models** — A string setting like `video_size` is no longer offered as a video input (#135); a Comfy Router busy status is not a failed run; a sentinel-or-range setting keeps its range.
- **Noodles** — A newly hidden connection inherits the label its handle's other hidden connections share; hidden stubs stack down the node side instead of overlapping.
- **Canvas** — A workflow opened from a file starts at its first node instead of an empty corner of its bounding box; the multi-select bar lives on the canvas, pans with the nodes and is never hidden under the tab strip.

## [1.10.0] - 2026-09-24

The ComfyUI provider release. One Comfy key now runs the partner models Comfy
hosts, through Comfy Router, alongside the other providers.

### Added

- **ComfyUI as a model provider** — A `comfy` provider, shown as ComfyUI, backed by [Comfy Router](https://docs.comfy.org/development/comfy-router/quickstart). Enter a key from platform.comfy.org in Settings → Providers, or leave it empty and the Comfy Cloud key from the ComfyUI tab is used; `COMFY_API_KEY` works for `.env` setups too.
- **159 image, video, audio and 3D models under one key** — Every media model the Router publishes a schema for, across 72 partner request formats: Black Forest Labs (FLUX.2, Kontext, Fill, Expand, Canny, Depth, Erase, try-on, FLUX 3 video), OpenAI GPT Image, Gemini and Imagen on Vertex, Veo, xAI Grok Imagine, ByteDance Seedream and Seedance, Kling (text, omni, avatar, lip-sync), Wan and HappyHorse, Qwen Image, Recraft, Ideogram, Krea, Luma, Runway, LTX, MiniMax, Moonvalley, Bria image and video edits, Freepik enhancers, Meshy 3D, HeyGen and ByteDance voices, and more. The browser lists every one the Router currently serves.
- **Settings from the Router's own schemas** — Each model's controls (values, ranges, defaults, descriptions) come from the schema the Router validates requests against, fetched live and cached, so they cannot drift from what the Router accepts.
- **Every input a model takes** — Masks, last frames, reference and garment images, video and audio inputs get their own handles. Media a partner only accepts as a URL is uploaded to Comfy storage first.
- **Choose who serves a model** — Models the Router can also run through fal, Higgsfield, Runware or WaveSpeed get a Model Provider setting on the node, read from the model's schema. Media goes by URL to an alternate provider, and a provider that refuses a setting says which one.
- **Queued runs** — Every Comfy Router job goes through the Router queue with an idempotency key and is polled the way Kie jobs are, so long video generations survive connection limits. The Router's `Retry-After` hint now sets the poll interval, capped at 60 seconds.

### Changed

- **Poller honours server hints** — The client poller used by async providers waits as long as the server suggests before its own 3 to 8 second ramp, bounded by the overall timeout.
- **Large outputs stream to a bound** — Video and audio results above 20MB are returned as a URL without being buffered; images are always inlined; 3D models come back as their URL.

### Notes

Comfy Router returns each partner's native response, so each request format is
described once, as data (`src/lib/providers/comfyRouter/families.json`): a
request template, the media each handle carries and how it is encoded, and
where the output or the partner's error sits in the response. A schema check
validates every bound model's request against the published schema, and
`npm run comfy:router-sync` reports Router models that are new since the last
sync. Text models and provider-hosted aliases without a published schema are
not offered; some partners (ElevenLabs on some accounts) must be enabled for
the Comfy account before they run.

## [1.9.0] - 2026-08-06

The ComfyUI release. A ComfyUI workflow becomes a node on the canvas, wired to
the rest of a Node Banana pipeline.

> Note: 1.7.0 and 1.8.0 shipped without entries here. Their notes are on the
> [releases page](https://github.com/shrimbly/node-banana/releases).

### Added

- **Run a ComfyUI workflow as a node** — Drop a workflow onto the canvas and it becomes a `comfyApp` node. If it was set up in ComfyUI's **App Mode**, the author's chosen inputs become typed handles, their widgets become inline settings, and their output nodes become typed outputs. Otherwise Node Banana detects them and asks you to confirm. Both upload formats work: the normal editor save and the API export.
- **Three backends** — Comfy Cloud (the default, nothing to install), a ComfyUI on this machine, or one elsewhere on the network. Chosen in Settings → ComfyUI and sent per request, so no server configuration is needed.
- **Blueprints** — The ready-made pipelines your ComfyUI already ships, listed in their own tab. Importing one materialises a loader per media input and a sink per output, so there is nothing to upload at all.
- **Saved nodes** — Keep a configured Comfy node and it comes back set up, not merely attached: the workflow, the contract, and the values it was running. Saved nodes appear in the canvas double-click search, in the connection-drop menus for any handle type they match, and in the dialog's own tab.
- **Live previews** — While a run is going, the node shows the latent forming instead of a spinner, streamed from the engine's event channel.
- **Curve editor** — ComfyUI's `CURVE` widget renders as a draggable tone curve rather than raw JSON.
- **Revisit a node's picks** — Reopening the dialog on an attached workflow shows the same candidate list with that node's selections applied, so inputs, settings and outputs can be changed without starting over.

### Fixed

- **Annotation modal shortcuts** — Delete inside the modal no longer removes the node behind it, and undo works with the shortcut typed in either case.
- **Running outline** — A node that is running is outlined as one piece, settings panel included, instead of drawing a second line where the panel starts.

### Notes

Comfy Cloud reports job progress too thinly to draw — no node name, no step
counts, and a fraction computed against a node total that grows during the run,
so it reaches 100% several times before the job ends. Previews are shown
instead, and progress deliberately is not.

## [1.6.0] - 2026-04-21

### Added

- **Seedance 2 I2V: richer media inputs** — The ByteDance Seedance 2.0 and 2.0 Fast image-to-video nodes now expose Last Frame, Reference Images (up to 9), Reference Videos (up to 3), and Reference Audio (up to 3) handles alongside First Frame. Handle descriptions document the First/Last Frame vs Reference Images mutual-exclusivity rule.

### Fixed

- **Seedance 2 I2V: reference-only runs no longer rejected** — When connecting images only to Reference Images, the request no longer duplicates them into `first_frame_url`, which Kie was rejecting as a mutually-exclusive combination.

## [1.5.0] - 2026-04-20

### Added

- **Onboarding & setup flow** — New first-run setup experience to get users configured and started quickly
- **Interactive tutorial** — Guided onboarding tutorial that walks first-time users through the workflow editor with mock execution and step-by-step demonstration
- **Kie.ai model expansion** — Added 7 new image models, Kling 3.0 / 3.0 Motion Control, Wan 2.7 (text-to-video & image-to-video), and Seedance 2.0 / 2.0 Fast video models
- **Model fallback/redundancy** — Generation nodes now support a fallback model that automatically kicks in if the primary model fails, with a dedicated settings tab for configuring fallback parameters
- **Loop edges** — Connect a node's output back to an upstream input with magenta-styled loop edges and configurable iteration counts via an edge toolbar
- **Client-side polling** — Long-running Kie tasks now return immediately and poll for results on the client side, keeping the UI responsive during video/3D generation
- **Download buttons** — All media-displaying nodes (image, video, audio, 3D) now have download buttons
- **Output gallery extraction** — New "Extract" button on OutputGalleryNode to batch-create input nodes from gallery items
- **Handle labels** — Connection handles now show descriptive labels on hover/select/drag for easier wiring

### Fixed

- **Video handle and edge colors** — Unified video handles, labels, and edges to consistent pink styling
- **Loop execution reliability** — Fixed downstream observer collection during loop iterations, validated loop counts, and handled resume inside loops
- **Orphaned edge cleanup** — Edges referencing deleted nodes are now filtered out on workflow load
- **Audio stitching** — Embedded audio is preserved when stitching video segments
- **Kie API compatibility** — Fixed Seedance 2.0 model ID mapping, schema defaults pre-population, and video/audio upload handling

## [1.4.0] - 2026-04-02

### Added

- **Audio-to-video generation** — Video generation nodes now accept audio inputs, enabling audio-driven video workflows with handle rendering, connection validation, model discovery, and drop-menu wiring
- **Array batch mode** — New batch execution mode that sequentially generates from all items in an array, with shared helper logic across all execution entry points

### Fixed

- **Undo/redo memory bloat** — Eliminated excessive memory usage caused by deep-cloning base64 image blobs in history snapshots; clipboard and snapshot operations now use a string-preserving clone
- **Cancellable batch execution** — Wired AbortController into `regenerateNode` so batch runs can be properly cancelled
- **Output gallery correctness** — Output gallery now reads fresh node data to preserve all batch-generated images
- **Array batch behavior** — Batch mode is now derived dynamically from the source node rather than being statically configured
- **UI polish** — Normalized button sizes in array node headers and repositioned batch/auto-route controls inline with split rows

## [1.3.0] - 2026-03-31

### Added

- **Video Input node** — Upload, preview, and wire video files through workflows with drag-and-drop support, native playback controls, and full-bleed styling matching Image Input nodes
- **Undo/Redo** — Full undo/redo history with Cmd+Z / Cmd+Shift+Z, intelligently coalescing multi-node deletions into single undo steps
- **Veo model parameters** — Aspect ratio, quality, and duration controls now render in the Generate Video node UI
- **NB Pro Waitlist** — Added waitlist link to the welcome modal

### Fixed

- Selected-node execution now properly hydrates audio and video input nodes from upstream connections

## [1.2.0] - 2026-03-29

### Added

- **Workflow Browser** — browse, search, and open saved workflows from a new modal (supports nested subdirectories, directory picker, and last-used path memory)
- **Media Externalization** — videos and audio now save alongside images in the generations/ folder for portable workflows
- **Optional Inputs & Skip Propagation** — mark input nodes as optional; execution skips downstream nodes when optional inputs are empty
- **Group Context Menu** — redesigned as a vertical dropdown with color picker, lock toggle, and NBP Input flag

### Fixed

- Video/audio save-load roundtrip (3 compounding bugs)
- Lock icon now shown on locked groups
- Error state cleared when navigating generation carousel
- Various a11y, regex, and dialog semantics fixes

### Performance

- Faster workflow listing by reading only file headers

### Documentation

- Redesigned README with hero layout, all 23 node types, and updated screenshots

## [1.1.3] - 2026-03-22

### Fixed

- Clamp expand height to minHeight and resolve text through switch nodes
- Move ImageInputNode handles after visual content to prevent z-order clipping
- Add z-index to handles so they paint above positioned node content
- Move overflow-clip from contentClassName to inner visual wrappers to prevent handle clipping
- Move panel height correction from loadWorkflow into BaseNode render
- Prevent node height accumulation with inline parameters on reload
- Update WelcomeModal test to match bg-black/60 backdrop class
- Resolve prompt variables through router nodes for PromptConstructor
- Use overflow-visible on non-fullBleed nodes to prevent handle clipping

### Other

- Replace ArrayNode auto-route icon with Lucide split icon

## [1.1.2] - 2026-03-12

### Added

- Adaptive image resolution scaling — swaps full-res images for JPEG thumbnails when nodes are small on screen

### Fixed

- Router/switch passthrough losing data when multiple types (text + image) flow through the same router to one target
- SplitGrid node Split button permanently disabled — sourceImage now updates reactively when an edge is connected
- Node connection handles clipped at edges — removed paint containment that acted like overflow hidden
- Thumbnail cache key collisions causing wrong images on nodes
- Pending thumbnail map not cleaned up on rejection, causing stale entries
- Pointer-events on node images/content blocking pan and drag interactions
- Hover state updates firing during node drag, causing unnecessary re-renders
- Hover events not blocked during mouse-down drag
- backdrop-blur-sm causing poor rendering performance on Windows

## [1.1.1] - 2026-03-12

### Fixed

- Ensure auto-routed prompts retain correct individual item text
- Add rounded corners to ImageInput image and InlineParameterPanel settings

### Other

- Increase ArrayNode top padding to match side padding
- Add top padding and max-width to ArrayNode top fields
- Update ArrayNode layout to match new design language

## [1.1.0] - 2026-03-12

### Added

- **Router, Switch & ConditionalSwitch Nodes** - Three new flow-control node types with toggle UI, rule editing, dynamic handles, and dimming integration
- **Gemini Veo Video Generation** - Veo 3.1 video models with full parameter support and error handling
- **Anthropic Claude LLM Provider** - Claude models available in LLM node alongside Gemini and OpenAI
- **Floating Node Headers** - Headers rendered via ViewportPortal with drag-to-move, hover controls, and Browse button
- **ControlPanel** - Centralized parameter editing panel with node-type routing and Run/Apply buttons
- **Full-Bleed Node Layouts** - All major nodes converted to edge-to-edge content with overlay controls
- **Inline Parameters** - Toggle to show model parameters directly on nodes with reactive sync
- **Video Autoplay** - useVideoAutoplay hook integrated into all 5 video node types
- **Inline Variable Highlights** - PromptConstructor highlights template variables inline
- **Minimap Navigation** - Click-to-navigate and scroll-to-zoom on minimap
- **Node Dimming System** - CSS-based visual dimming for disabled Switch/ConditionalSwitch paths
- **Unsaved Changes Warning** - Browser warns before closing tab with unsaved workflow
- **All Nodes Menu** - Floating action bar with All Nodes dropdown and All Models button
- **Provider Filter Icons** - ModelSearchDialog filters by available providers

### Fixed

- Ease curve outputDuration passthrough through parent-child connections
- Canvas hover state suppressed during panning to prevent re-render cascading
- Node click-to-select failures caused by d3-drag dead zone
- Aspect-fit resize after manual resize aligns with React Flow dimension priority
- Settings panel seamless selection ring, background matching, and z-index layering
- ConditionalSwitch stale input, handle alignment, and text routing
- Veo negative prompt connectable as text handle, error handling, image validation
- API headers scoped to active provider, temperature falsy bug fixed
- Image flicker on settings toggle, presets popup dismiss, modal overlay click-through
- Node paste height compounding, group label anchoring, file input backdrop issues
- Handle visibility on full-bleed and OutputNode, clipped handle resolution
- FloatingNodeHeader width tracking, right-alignment, and Windows drag interception
- Smart cascade made type-aware so text inputs don't rescue dimmed image paths
- RouterNode auto-resize, handle colors, and placeholder styling

### Changed

- EaseCurveNode, SplitGridNode, Generate3DControls, GenerateVideoControls refactored to full-bleed patterns
- ConditionalSwitch execution logic deduplicated with shared evaluateRule utility
- ModelParameters collapsible toggle removed

### Performance

- Selective Zustand subscriptions replace bare useWorkflowStore() calls
- RAF-debounced setHoveredNodeId and BaseNode ResizeObserver
- Edge rendering optimized for large canvases
- FloatingNodeHeader, InlineParameterPanel, ModelParameters wrapped in React.memo
- useShallow for WorkflowCanvas store subscription
- Narrow selectors for ControlPanel and GroupControlsOverlay

### Tests

- Removed redundant and brittle component tests (-1,958 lines)
- Updated assertions for full-bleed nodes, floating action bar, and Gemini video

### Other

- Added MIT license
- Handle diameter increased from 10px to 14px
- Settings redesigned with pill tabs, segmented controls, and toggles
- Multi-layer box-shadow for smooth settings panel shadow

## [1.0.0] - Initial Release

### Added

- Visual node editor with drag-and-drop canvas
- Image Input node for loading images
- Prompt node for text input
- Annotation node with full-screen drawing tools (rectangles, circles, arrows, freehand, text)
- NanoBanana node for AI image generation using Gemini
- LLM Generate node for text generation (Gemini and OpenAI)
- Output node for displaying results
- Workflow save/load as JSON files
- Connection validation (image-to-image, text-to-text)
- Multi-image input support for generation nodes
