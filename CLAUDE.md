# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run dev      # Start Next.js dev server at http://localhost:3000
npm run build    # Build for production
npm run start    # Start production server (node server.js --production)
npm run lint     # ESLint with Next.js's rules (React Compiler rules and no-explicit-any are warnings)
npm run typecheck # Type-check the app without its tests (tsconfig.build.json)
npm run test     # Run all tests with Vitest (watch mode)
npm run test:run # Run all tests once (CI mode)
```

## Environment Setup

Create `.env.local` in the root directory:
```
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key  # Optional, for OpenAI LLM provider
KIE_API_KEY=your_kie_api_key        # Optional, for Kie.ai models (Sora, Veo, Kling, etc.)
COMFY_API_KEY=your_comfy_api_key    # Optional, for ComfyUI-hosted models via Comfy Router (Flux, GPT Image, Nano Banana, Kling, Veo, etc.)
```

## Architecture Overview

Node Banana is a node-based visual workflow editor for AI image generation. Users drag nodes onto a React Flow canvas, connect them via typed handles, and execute pipelines that call AI APIs.

### Core Stack
- **Next.js 16** (App Router) with TypeScript
- **@xyflow/react** (React Flow) for the node editor canvas
- **Konva.js / react-konva** for canvas annotation drawing
- **Zustand** for state management (single store pattern)
- **lucide-react** for icons (20px, 1.5 stroke in chrome; hand-drawn SVG only for diagram-like glyphs such as the connector style toggle)

### Key Files

| Purpose | Location |
|---------|----------|
| Central workflow state & execution logic | `src/store/workflowStore.ts` |
| All TypeScript type definitions | `src/types/index.ts` |
| Main canvas component & connection validation | `src/components/WorkflowCanvas.tsx` |
| Node shell (media card, sockets, gap row, controls card — used by every node) | `src/components/nodes/NodeShell.tsx` |
| Node UI primitives (fields, controls card, sockets, carousel, scrub row) | `src/components/nodes/ui/` |
| Node anatomy and tokens | `docs/node-redesign.md`, `src/app/globals.css` (`@theme`) |
| Image generation API route | `src/app/api/generate/route.ts` |
| LLM text generation API route | `src/app/api/llm/route.ts` |
| Cost calculations | `src/utils/costCalculator.ts` |
| Grid splitting utility | `src/utils/gridSplitter.ts` |
| Asset library (always-on saving, Assets view) | `src/lib/assets/`, `src/components/assets/`, `docs/asset-library.md` |
| Full-screen media viewer (stage, dock-scaled filmstrip, details rail; the recent-generations drop-down and the output gallery node both mount it with their own actions) | `src/components/MediaViewer.tsx`, `src/hooks/useAddMediaNode.ts` |

### State Management

All application state lives in `workflowStore.ts` using Zustand. Key patterns:
- `useWorkflowStore()` hook provides access to nodes, edges, and all actions
- `executeWorkflow(startFromNodeId?)` runs the pipeline via topological sort
- `getConnectedInputs(nodeId)` retrieves upstream data for a node
- `updateNodeData(nodeId, partialData)` updates node state
- Autosave (`src/store/utils/autoSave.ts`) follows the edits: a saved workflow is written 3 s after the last change, at the latest 30 s after the first, never mid-run or while media is still being written, and at once when the window loses focus; a failure is retried once, then backed off with one notice. "Save automatically" in Settings → Project turns it off (`node-banana-autosave`)

### Execution Flow

1. User clicks Run or presses `Cmd/Ctrl+Enter`
2. `runBatch(scope)` runs it `runCount` times (the Run menu's "Runs" stepper, saved with the workflow, 1–50), one run after another
3. `executeWorkflow()` performs topological sort on node graph
4. Nodes execute in dependency order, calling APIs as needed
5. `getConnectedInputs()` provides upstream images/text to each node
6. Locked groups are skipped; pause edges halt execution

**Batch runs** (`src/store/utils/runBatch.ts`): every Run entry point (the
button and its menu, ⌘↵, ⌥↵, the multi-select toolbar, a group's "Run group")
goes through `runBatch`. A batch stops early on a failed run, a pause edge or
a replaced canvas. The button's Stop is `requestStop`: mid-batch the first
press lets the current run finish, the second stops now (`stopWorkflow`).
`batch` (`id`, `index`, `count`) rides on each run's outputs: carousel
entries, recent generations and asset records.

## AI Models

Image generation models (these exist and are recently released):
- `gemini-2.5-flash-image` → internal name: `nano-banana`
- `gemini-3-pro-image-preview` → internal name: `nano-banana-pro`

LLM models are defined once in `src/lib/llm/catalog.ts`: the current list per provider, legacy ids saved workflows may carry, their replacements, and the defaults. Add or retire a model there; every dropdown, `/api/llm` and the assistant read it.

## Model catalog

`GET /api/models` lists every provider with a key. Gemini, Kie and OpenAI
are static catalogs in `src/lib/providers/registry.ts`; Comfy Router offers
its bound models that the Router's own list says it serves (see "Adding
Comfy Router Models"); Replicate, fal.ai and WaveSpeed come from the model catalog
(`src/lib/providers/catalog.ts`): each list is fetched in parallel under its
own deadline, kept under `~/.node-banana/catalog/<provider>.json`
(`NODE_BANANA_CATALOG_DIR` moves it; tests must set it), served straight away,
and refreshed behind the request once older than six hours. A refresh that
fails keeps the previous list and reports the error in that provider's entry
(`fetchedAt`, `stale`, `refreshing`, `error`), which the browse dialog shows
as a notice. Replicate's list is built from its curated collections
(`REPLICATE_COLLECTIONS`, one capability each, merged by model, ranked by
runs), not from paging its newest uploads. `search` filters the stored lists;
`deep=true` also asks Replicate's and fal.ai's own search, which the dialog
offers as an explicit "Search Replicate and fal.ai" and the agent's model
search always uses. The dialog fetches the whole list once and filters,
searches and tabs it locally, polling while a provider is still refreshing.

## Node Types

| Type | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `imageInput` | Load/upload images | reference | image |
| `annotation` | Draw on images (Konva) | image | image |
| `prompt` | Text prompt input | none | text |
| `nanoBanana` | AI image generation | image, text | image |
| `llmGenerate` | AI text generation | text, image | text |
| `splitGrid` | Split image into grid cells | image | reference |
| `generateAudio` | AI audio/TTS generation | text | audio |
| `audioInput` | Load/upload audio files | audio | audio |
| `glbViewer` | Load/display 3D GLB models | none | image |
| `comfyApp` | Run a ComfyUI workflow as a node | schema-driven | schema-driven |
| `output` | Display final result | image | none |

## Node Connection System

### Handle Types

| Handle Type | Data Format | Description |
|-------------|-------------|-------------|
| `image` | Base64 data URL | Visual content |
| `text` | String | Text content |
| `audio` | Base64 data URL | Audio content |

### Connection Rules

1. **Type Matching**: Handles only connect to matching types (`image`→`image`, `text`→`text`)
2. **Direction**: Connections flow from source (output) to target (input)
3. **Multiplicity**: Image inputs accept multiple connections; text inputs accept one

### Data Flow in `getConnectedInputs`

Returns `{ images: string[], text: string | null }`.

**Image data extracted from:**
- `imageInput` → `data.image`
- `annotation` → `data.outputImage`
- `nanoBanana` → `data.outputImage`

**Text data extracted from:**
- `prompt` → `data.prompt`
- `llmGenerate` → `data.outputText`

**Audio data extracted from:**
- `audioInput` → `data.audioFile`
- `generateAudio` → `data.outputAudio`

## Keyboard Shortcuts

- `Cmd/Ctrl + Enter` - Run workflow (as many times as the Run menu's Runs count)
- `Cmd/Ctrl + S` - Save workflow (works inside a node's text field; the first save asks for a name and location). The desktop app's File › Save is the same request (`src/store/saveRequestStore.ts`, answered by `FloatingMenu`)
- `Cmd/Ctrl + C/V` - Copy/paste nodes
- `Shift + P` - Add prompt node at center
- `Shift + I` - Add image input node
- `Shift + G` - Add generate (nanoBanana) node
- `Shift + V` - Add video (generateVideo) node
- `Shift + L` - Add LLM node
- `Shift + A` - Add annotation node
- `Shift + T` - Add audio (generateAudio) node
- `Shift + C` - Add ComfyUI app node
- `Shift + D` - Add 3D (generate3d) node
- `Shift + O` - Add output node
- `H` - Stack selected nodes horizontally
- `V` - Stack selected nodes vertically
- `G` - Arrange selected nodes in grid
- `C` - Show or hide the full-page agent chat (bare C, outside a text field)
- `A` - Show or hide the Assets view (bare A; Shift+letters add nodes). In Assets: arrows, Enter, Space, `Cmd/Ctrl + A`, Delete (Trash), `Cmd/Ctrl + Z` (undo the last asset action), `F` (fullscreen detail), Esc
- `?` - Show keyboard shortcuts

## Adding New Node Types

1. Define the data interface in `src/types/index.ts`
2. Add to `NodeType` union in `src/types/index.ts`
3. Create default data in `createDefaultNodeData()` in `workflowStore.ts`
4. Add dimensions to `defaultDimensions` in `workflowStore.ts`
5. Create the component in `src/components/nodes/`
6. Export from `src/components/nodes/index.ts`
7. Register in `nodeTypes` in `WorkflowCanvas.tsx`
8. Add minimap color to `getMiniMapNodeColor()` in `src/components/CanvasMinimap.tsx`
9. Update `getConnectedInputs()` if the node produces consumable output
10. Add execution logic in `executeWorkflow()` if the node requires processing
11. Update `ConnectionDropMenu.tsx` to include the node in source/target lists

### Handle Naming Convention

Use descriptive handle IDs matching the data type:
- `id="image"` for image data
- `id="text"` for text data

### Validation

- Connection validation: `isValidConnection()` in `WorkflowCanvas.tsx`
- Workflow validation: `validateWorkflow()` in `workflowStore.ts`

## Adding New Kie.ai Models (SOP)

Reference docs: https://docs.kie.ai/llms.txt lists all available model API pages.

### Step 1: Gather API Details
Visit the model's doc page on https://docs.kie.ai/ and collect:
- Model ID(s) (the `model` param sent to the API)
- Capabilities: text-to-image, image-to-image, text-to-video, image-to-video
- API endpoint (standard: `/api/v1/jobs/createTask`, or model-specific like Veo's `/api/v1/veo/generate`)
- All input parameters: name, type, enum values, defaults, required status
- Image/video input parameter name (e.g., `image_urls`, `imageUrls`, `input_urls`)
- Polling endpoint (standard: `/api/v1/jobs/recordInfo`, or model-specific)
- Response format and status field names
- Pricing (per-run cost if available)

### Step 2: Add Model Registry Entry
**File:** `src/app/api/models/route.ts` — Add to `KIE_MODELS` array.
Each model entry needs: `id`, `name`, `description`, `provider: "kie"`, `capabilities`, `pricing`, `pageUrl`.
Use separate entries for each capability variant (e.g., `model/text-to-video` and `model/image-to-video`).

### Step 3: Add Parameter Schema
**File:** `src/app/api/models/[modelId]/route.ts` — Add to `getKieSchema()`.
Define `parameters` (user-configurable settings) and `inputs` (connectable handles like prompt, images).

### Step 4: Add Default Parameters
**File:** `src/app/api/generate/providers/kie.ts` — Add case to `getKieModelDefaults()`.
Provide required defaults that must be present even if the user doesn't set them.

### Step 5: Add Image Input Key Mapping
**File:** `src/app/api/generate/providers/kie.ts` — Add to `getKieImageInputKey()`.
Map the model to its correct image parameter name if it differs from the default `image_urls`.

### Step 6: Handle Non-Standard API (if applicable)
If the model uses different endpoints than `/api/v1/jobs/createTask` and `/api/v1/jobs/recordInfo`:
- Add a detection function (e.g., `isVeoModel()`)
- Add a model-ID-to-API-model mapping function
- Add a custom polling function for the model's status endpoint
- Add a branch in the Kie request-building logic (see `src/app/api/generate/providers/kie.ts`) for the custom request format

## Adding Comfy Router Models

Comfy Router (`https://api.comfy.org/v2/models/{provider}/{model}`, header `X-API-Key`) fronts ~240 partner models behind one Comfy key and forwards each partner's native request and response. Provider id is `comfy`, shown as "ComfyUI". Its key on the Providers page is the one Comfy key: Comfy Cloud runs and partner nodes use it too (`comfyAccountKey()` in `src/lib/comfy/settings.ts`; a Cloud key an older build stored on the ComfyUI tab is moved there on start by `migrateLegacyComfyCloudKey`).

Discovery and settings are live; wire formats are data:

- **Which models exist:** `GET /v2/models` (paginated, needs the key), cached ten minutes. The browser offers every *bound* model the Router currently serves.
- **Settings:** each model's published schema — `GET /v2/models/{id}/openapi.json` with the key, or `https://docs.comfy.org/router-schemas/{id}.json` without — cached six hours. `schema.ts` turns the request schema into the node's parameters (types, enums, ranges, defaults, descriptions); nothing about a setting is typed by hand unless the schema is looser than the partner.
- **Wire formats:** `src/lib/providers/comfyRouter/families.json` — one *family* per partner request format: a request template (`body`), the media handles it fills and how each is encoded (`base64`, `dataUrl`, or `url` = uploaded to Comfy storage first), where its settings live in the schema (`params.at`/`exclude`), per-setting `paramOverrides` (enum, default, value), and where the output or the partner's error sits in the response (`result.media`/`errors`). The binding language is documented at the top of `template.ts`. Models the app cannot drive are listed under `excluded` with the reason.
- **New model of a known format:** add it to that family's `models` (id, name, description, capabilities, any per-model overrides). **New format:** add a family.
- **Checks:** `npm run comfy:router-sync` downloads every schema into `.scratch/comfy-router-schemas` and lists Router models that are neither bound nor excluded. Then `npx vitest run src/lib/providers/comfyRouter/__tests__/routerSchemas.test.ts` validates the smallest and fullest request of every bound model against its schema (Ajv) and checks each result path exists in the response schema. `src/app/api/generate/providers/__tests__/comfy.test.ts` pins bodies and result readings for the main formats.
- **Transport:** always the queue (`POST …/requests` → poll `…/requests/{id}/status` respecting `Retry-After` → `GET …/requests/{id}`), with an `Idempotency-Key` per submit — synchronous partners (OpenAI, Qwen) work through it too. The generate route returns the polling envelope with `pollProvider: "comfy"` and `/api/generate/poll` finishes the run. Binary answers (ElevenLabs) become audio; 3D models return as their URL.
- **Masks:** partners disagree. OpenAI edits where the mask is transparent; FLUX Fill and Bria edit where it is white; Ideogram 4.5 edits where it is black.

## ComfyUI Integration

Node Banana can run a ComfyUI workflow as a node (`comfyApp`). The workflow's
**App Mode** (linear mode) configuration defines the node's surface: the
author's chosen inputs become typed handles, their widgets become inline
settings, and their output nodes become typed output handles.

### Backends

Chosen in Settings → ComfyUI, stored in `node-banana-comfy-settings` and
forwarded per request as `X-Comfy-*` headers (so no server config is needed):

| Mode | Transport | Notes |
|------|-----------|-------|
| `cloud` (default) | `@comfyorg/sdk` (Comfy API v2) | Uses the Comfy key from Settings → Providers (`comfyui-…`, from platform.comfy.org) |
| `local` | legacy `/api/prompt` | A stock ComfyUI; no sidecar needed |
| `remote` | legacy `/api/prompt` | Same, elsewhere on the network |

Local/remote endpoints fronted by `comfy-api-proxy` can opt into the SDK path
with the "Behind comfy-api-proxy" toggle. A stock ComfyUI has no `/api/v2/*`
routes, which is why the legacy engine is the default there.

### Key files

| Purpose | Location |
|---------|----------|
| Graph parsing, patching, pruning | `src/lib/comfy/graph.ts` |
| Editor→API conversion, App Mode, Blueprints | `src/lib/comfy/editor.ts` |
| Workflow → node contract | `src/lib/comfy/inspect.ts` |
| Backend settings + request headers | `src/lib/comfy/settings.ts` |
| Engine interface + both transports | `src/lib/comfy/server/` |
| Node component | `src/components/nodes/ComfyAppNode.tsx` |
| Import/confirm dialog | `src/components/modals/ComfyWorkflowImportModal.tsx` |
| Settings tab | `src/components/settings/ComfySettingsTab.tsx` |
| Executor | `src/store/execution/comfyAppExecutor.ts` |
| Saved-node library | `src/lib/comfy/library.ts` |

### Saved nodes

A confirmed node can be kept — "Save as node" in the confirm step of the import
and edit dialog. An entry holds the workflow, the contract *and* the values the
node was running (seeds excluded, since they are re-randomised per run), so it
comes back set up rather than merely attached.

Saved nodes then appear as ordinary nodes: in the canvas double-click search
under "Saved nodes", in the connection-drop menus for any handle type their
contract matches, and in the dialog's own "Saved nodes" tab. All three create a
plain `comfyApp` node seeded via `seedFromSavedComfyNode`; there is no new node
type.

Saving is a **snapshot**. A node created from an entry records `savedNodeId`, so
the dialog can offer "Update saved node" as well as "Save as new"; attaching a
different workflow clears it.

### Formats

Dropping either format onto the canvas creates a `comfyApp` node at the drop
point and opens the confirm step on it; our own workflow saves still replace the
canvas, told apart by shape in `src/lib/comfy/detect.ts`.

Both upload formats are accepted. An **editor save** (the normal ComfyUI Save)
is the one that carries App Mode, but it is not executable — widget values are
positional — so converting it needs `/api/object_info` from a reachable engine.
An **API export** runs as-is but carries no App Mode, so inputs and outputs are
detected heuristically and confirmed in the dialog.

**Blueprints** are saved subgraphs, listed from `/api/global_subgraphs` (public,
on Cloud and local alike). Their data enters and leaves through boundary slots,
so importing one materialises a loader per media input and a sink per output.

### Live previews

While a run is going, a v2 engine streams partial images over
`GET /api/v2/jobs/{id}/events`. `/api/comfy/preview` relays those to the node,
which shows the latent forming instead of a spinner. Two things to know:

- The payload is **not** the bare JPEG the SDK's types describe. ComfyUI wraps
  it: `[uint32 kind][uint32 jsonLength][JSON metadata][image bytes]`, and the
  frame's own `node_id` arrives empty — the real one is in the metadata. See
  `previewImage` in `src/lib/comfy/server/sdkEngine.ts`.
- The same stream carries `progress`, and it is deliberately **not** used.
  Measured against a live Cloud render it reports no node name, no step counts,
  and a fraction computed against a node total that grows as the graph expands
  — so it reaches 100% several times before the job ends. The job record's
  `progress` field is `null` on Cloud throughout, despite the spec.

Previews live in component state (`useComfyPreview`), never in the workflow
store: they are 50–80KB JPEGs belonging to a run, and node data gets written
into saved workflow files.

### Smoke tests

The Blueprint corpus is the regression net for this integration — every entry
is a real published Blueprint that once broke it in a different way.

| Command | Cost | What it covers |
|---------|------|----------------|
| `npx vitest run src/lib/comfy/__tests__/catalog.test.ts` | none | Hermetic. Runs the real conversion over recorded workflows and a recorded node catalog. Runs in CI. |
| `npm run comfy:smoke` | credits | Real renders end to end, through Node Banana's own routes. Needs a dev server and `COMFY_SMOKE_KEY`. |
| `npm run comfy:record` | none | Re-record the corpus when Comfy Cloud's catalog moves. |

Point the live tier at a local ComfyUI with
`node scripts/comfy-smoke.mjs run --mode local --url http://127.0.0.1:8188`.

## Agent

The agent is a chat window opened from the labelled pill in the canvas's
top-right corner, beside the recent-generations button; the window takes the
pill's place (the pill is hidden while it is open) and runs down to the
navigator. The recent-generations drop-down and the
notification stack hang from the window's right edge while the agent window
is closed, and move left of it while it is open (`anchorRight` on
`GlobalImageHistory`, published as `--nb-history-right`). The pill shows the mark of the harness that
will answer (both marks until the agent has been opened once), says "Working…"
while a turn runs, and carries an amber dot when the harness needs sign-in. It
creates workflows, edits the canvas and changes node settings.
Every turn runs on the user's own **Claude Code** or **Codex (ChatGPT)** login
through the vendor's official CLI, never on API credits:

- Both CLIs ship as pinned npm packages (`@anthropic-ai/claude-agent-sdk`,
  `@openai/codex`, in `serverExternalPackages` in `next.config.shared.cjs`).
  `NB_CLAUDE_BIN` / `NB_CODEX_BIN` point at another binary.
- The child environment is stripped of API keys. Before and during a turn the
  harness checks that the login is a subscription and that the plan has room,
  and stops rather than use extra usage or credits.
- Sign-in only starts the vendor's own flow (`claude auth login`, Codex's
  app-server login). Node Banana never reads or relays tokens, and never
  relays Claude's manual-code URL.
- The agent can only call our tools: Claude has every built-in tool off,
  Codex runs with shell/patch disabled in a read-only sandbox.

Flow: the panel sends a media-free canvas snapshot with each message →
`/api/agent/chat` runs the turn on the chosen harness → tools edit a
server-side draft and emit resolved graph ops → the browser applies them with
`applyAgentGraphOps` (one undo step per tool call). Edits from a turn are
dropped if the canvas is replaced mid-turn (`canvasGeneration`: load, clear,
tab switch).

Runs: when the user asks, `run_workflow` starts one (scope `nodes`, `all` or
`from`, and a run count), checked against the draft: refused while the
snapshot says `running`, or when a node the run reads from holds nothing. Its
`run` op starts through `runBatch` after the call's edits, outside undo; the
model reports the outcome from the next message's node `status` and `error`.
A turn that builds or changes runnable nodes without running them ends with a
persisted `data-run-offer` part (`runtime.runOffer()`): the chat's Run card,
scoped to the whole workflow, a group, or the changed nodes and what they feed.

Chat view: the Chat toggle at the head of the tab strip (bare `C`) shows the
full-page chat (`appView === "chat"`, `AgentChatView`). It and the floating
window are two surfaces of one session (`AgentSessionProvider` in page.tsx;
`useAgentSession`, and `useAgentPresence` for chrome that must not re-render
per token; `useAgentSurface` sizes the transcript). Runs the chat starts (the
Run card, or the agent's `run_workflow`) are followed as `AgentRunRecord`s in
`src/lib/agent/client/runs.ts`: progress, then outputs as asset ids and text,
never media bytes, shown as results cards with the full-screen viewer. A
`create_workflow` call's output carries its tab's graph in miniature (`graph`:
node types and boxes, connections; the turn's later edits to that tab carry it
too), which the full-page chat alone draws as a minimap under the call
(`AgentWorkflowPreview`), with Open in canvas.

Reviewing results: `view_outputs` shows the model what the nodes generated.
The snapshot names each node's results by asset library id (`outputs`: the
one it shows, then up to three newer, never bytes); the tool reads them from
the library (`libraryOutputs.ts`: images downsized to 1024px webp, a video's
captured frame) and returns them as images after their captions, MCP image
blocks for Claude and `inputImage` data URLs for Codex. Uploads, audio and 3D
cannot be viewed, and a run started in the same turn is not in it yet. Codex's
models run tools from code-mode `exec` cells, where a tool's reply arrives as
one string (images as `data:` URLs on their own lines) and the model sees a
picture only when the cell passes it to `image()`: the harness's developer
instructions show it how. Without them it describes images it never saw.

Tabs: each request carries every open tab (`tabs`, `parkedWorkflows`); the
runtime keeps a draft per tab and `switch_workflow`, `new_workflow` and
`save_workflow` emit workspace steps (`AgentWorkspaceOp`) that `useAgentChat`
applies in stream order with the graph batches (each batch names its
`tabId`). The turn's own tab changes never stop it; a user's still do. A first
save goes into the Node Banana folder by name (`saveLiveWorkflow`). A workflow
the agent builds from scratch (on an empty canvas that was never saved, or in a
tab it opened) it names and saves in the same turn, unless told not to: the
prompt says so, and that `create_workflow` result reminds it. Other work it
saves only when asked.

| Purpose | Location |
|---------|----------|
| Shared contracts | `src/lib/agent/types.ts` |
| Node catalog, handle rules, draft, layout, snapshot | `src/lib/agent/graph/` |
| Tools and the system prompt | `src/lib/agent/tools/`, `src/lib/agent/prompt.ts` |
| Prompting guides by modality, model notes, research turn | `src/lib/agent/prompting/` |
| Harnesses (Claude Agent SDK, codex app-server), env, billing checks | `src/lib/agent/server/` |
| UI message stream bridge | `src/lib/agent/server/chatStream.ts` |
| Panel, button, sign-in card | `src/components/agent/`, `src/lib/agent/client/` |
| Shared session, full-page chat, Run and results cards | `src/components/agent/AgentSession.tsx`, `AgentChatView.tsx`, `AgentRunCard.tsx`, `AgentRunResults.tsx` |
| Chat-started runs, saves, request | `src/lib/agent/client/runs.ts`, `save.ts`, `request.ts` |
| Chat UI kit (Vercel AI Elements + radix-nova primitives, scoped theme) | `src/components/ai-elements/`, `src/components/agent/ui/`, `src/app/agent-theme.css` |

The agent routes only answer requests the server vouches for: `server.js`
stamps sockets that really are loopback and `electron/server.cjs` stamps every
request it has authorised, with a per-process secret `sameOrigin.ts` requires.
Run the app with `npm run dev` / `npm start` / Electron (plain `next dev` /
`next start` refuse agent requests). `NB_AGENT_ALLOWED_HOSTS` opts other hosts
in. `NB_CODEX_EFFORT` overrides Codex's reasoning effort (default `medium`).
When the canvas rules in `WorkflowCanvas.tsx` or a node's sockets change,
update `src/lib/agent/graph/catalog.ts` / `handles.ts` too (the server's copy).

Prompts: the agent calls `get_prompt_guide` before writing a prompt. It
renders the guide for the node's modality and task (image, video, audio, 3D,
LLM instruction), notes read from the model's own schema and description,
and any prompting tips saved for that model. A new prompt-taking node type
needs an entry in `PROMPT_NODE_MODALITY`. Tips are looked up only when the
user asks ("Look up prompting tips" chip, with one generator selected): a
research turn with the harness's own web search on, no canvas tools, no
chat history and no session part, whose one tool saves the tips under
`~/.node-banana/prompt-notes/<provider>/<model>.json`
(`NODE_BANANA_PROMPT_NOTES_DIR` moves it; tests must set it or pass a
store).

## Desktop releases and updates

Pushing a tag `v<version>` runs `.github/workflows/release.yml`: tests, a
draft release, then a signed and notarised Mac build on a macOS runner and an
unsigned Windows build on a Windows runner, both uploaded into the draft
(secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`,
`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). A manual run
builds without publishing unless asked.
`npm run electron:package` is the same build by hand
(`scripts/package-electron.cjs`); `--sign` signs and notarises the Mac build
(Developer ID from the keychain, notarisation from `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER` or the Apple ID trio; entitlements in
`electron/entitlements.mac.plist`), `--publish` uploads the artifacts and the
updater manifests to a **draft** GitHub release `v<version>` (`GH_TOKEN`).
Windows builds are unsigned. Artifact names carry no spaces
(`Node-Banana-<version>-<arch>.<ext>`): GitHub renames assets with spaces and
the updater would miss them.

The packaged app updates itself with electron-updater, loaded from the bundled
runtime's `node_modules` (the app package has no dependencies of its own) and
driven by `electron/lib/updates.cjs`: a check 15 s after launch and every six
hours, download only on request, install on **Restart to update** or at the
next quit, a skipped version remembered in `updates-v1.json` under user data.
The renderer sees it through `window.nodeBananaDesktop.updates`
(`src/types/desktop.d.ts`) and shows `DesktopUpdateNotice` in the notification
stack. Squirrel.Mac installs signed builds only, so a Mac release for existing
users must be built with `--sign`; an install failure falls back to a link to
the release. Test profiles (`NODE_BANANA_ELECTRON_USER_DATA`) and `electron:dev`
never check by themselves; `NODE_BANANA_ELECTRON_PREVIEW_UPDATES=1` (or `fail`)
gives a dev run a pretend updater so the notice can be seen. The release steps
are in `docs/desktop-preview.md`.

## Asset Library

Every generated and edited asset is saved to disk as it is made, with or
without a project, and indexed for the Assets view (bare `A`). The library
root is the "Node Banana folder": it defaults to `~/Documents/Node Banana`
(Windows: `Documents\Node Banana`, or `%USERPROFILE%\Node Banana` when
Documents syncs to OneDrive; Linux: `XDG_DOCUMENTS_DIR`) and holds projects
saved by name (`<root>/<Project>/`), `Generations/` for unsaved workflows
and the hidden `.nodebanana/` metadata. Project workflows still write into
`<project>/generations/` and are indexed in place. See
`docs/asset-library.md` for the layout, recording, snapshots, deletion and
projects.

- Known projects (the root's own, the project registry
  `~/.node-banana/projects.json`, workflow rows) are listed by
  `GET /api/assets/projects`. Each page load reports its localStorage's
  project folders once (`reportProjects`), which may adopt the old workflows
  folder as the root; known projects' generations are auto-indexed by a quiet
  import job; the `projects` job moves folders into the root and rewrites
  every path that pointed at them.

- Executors record through `ctx.recordAsset` (present only while the library
  is available); a new media-producing node should call it from its success
  path with the model that actually ran and the resolved prompt, and put the
  returned `assetId` into its carousel entry. Without it, project workflows
  fall back to `/api/save-generation`.
- `/api/assets/*` answer only Node Banana's own page on this computer
  (`src/lib/assets/server/guard.ts`, same stamp as the agent routes);
  `NB_LIBRARY_ALLOWED_HOSTS` opts other hosts in. The older routes that
  read, write, list or reveal files by path (`/api/workflow`,
  `/api/workflow-images`, `/api/list-workflows`, `/api/save-generation`,
  `/api/load-generation`, `/api/list-generations`, `/api/open-file`,
  `/api/open-directory`, `/api/browse-directory`) sit behind the same guard,
  so a new route that takes a path should too.
- `NODE_BANANA_ASSET_LIBRARY` pins the library root (tests must set it, or use
  the server test hooks; scripted Electron runs get one under their temp
  profile automatically).

## API Routes

All routes in `src/app/api/`:

| Route | Timeout | Purpose |
|-------|---------|---------|
| `/api/generate` | 10 min | Image/video generation, dispatched by `selectedModel.provider`; async providers (Kie, Comfy) return a polling envelope |
| `/api/generate/poll` | 2 min | Finish an async run (Kie, Comfy Router) |
| `/api/models` | default | Model registry across providers (`?provider=`, `?search=`) |
| `/api/models/[modelId]` | default | Per-model parameters and inputs |
| `/api/env-status` | default | Which provider keys the server has from `.env` |
| `/api/llm` | 1 min | Text generation (Google/OpenAI) |
| `/api/workflow` | default | Save/load workflow files |
| `/api/save-generation` | default | Auto-save generated images |
| `/api/logs` | default | Session logging |
| `/api/comfy/status` | 1 min | Probe the configured ComfyUI engine |
| `/api/comfy/inspect` | 2 min | Workflow upload → node contract |
| `/api/comfy/blueprints` | 2 min | List/import ComfyUI Blueprints |
| `/api/comfy/run` | 5 min | Submit a Comfy app run |
| `/api/comfy/poll` | 5 min | Poll a run and collect its outputs |
| `/api/comfy/preview` | 5 min | Stream a running job's preview images (NDJSON) |
| `/api/agent/chat` | 10 min | Run one agent turn (AI SDK UI message stream) |
| `/api/agent/status` | 1 min | Each harness: installed, signed in, subscription billing, models |
| `/api/agent/sign-in` | 1 min | Start a harness's own sign-in flow |
| `/api/agent/prompt-notes` | default | Read (GET) or forget (DELETE) the prompting tips saved for a model |
| `/api/assets` | 10 min | List assets (GET, keyset pages) / start recording one (POST → upload ticket, or a server download for URLs) |
| `/api/assets/uploads/[id]` | 10 min | Stream an asset's bytes (PUT) |
| `/api/assets/[id]` (`/file`, `/poster`, `/workflow`) | default | Read/patch an asset, stream its file (Range), store a video poster, get its run snapshot |
| `/api/assets/thumb/[sha256]` | default | 320/640 px webp thumbnails (204 when none) |
| `/api/assets/facets`, `/bulk`, `/exists`, `/reveal` | default | Filter counts, bulk tag/favourite/trash/restore/delete, carousel existence, Show in Finder/Explorer |
| `/api/assets/media`, `/runs/[id]`, `/workflows/[id]` | default | Snapshot media, run snapshots, workflow classification |
| `/api/assets/library`, `/jobs/[id]`, `/import`, `/import/scan`, `/cleanup`, `/export` | default | Library status/location, background jobs (move, import projects, clean up, export), finding the projects under a folder to import |
| `/api/assets/projects` (`/report`, `/bring-in`, `/offer`, `/folder-name`) | default | Known projects and the "live elsewhere" offer, the page load's project report, bringing projects in (use, move, leave), a new project's folder name |

## localStorage Keys

- `node-banana-workflow-configs` - Project metadata (paths)
- `node-banana-autosave` - "Save automatically" (absent or `on` means on)
- `node-banana-provider-settings` - Provider API keys and enabled flags (the `comfy` entry is the one Comfy key; `node-banana-comfy-settings` no longer stores one)
- `node-banana-workflow-costs` - Cost tracking per workflow
- `node-banana-nanoBanana-defaults` - Sticky generation settings
- `node-banana-comfy-settings` - ComfyUI backend (cloud/local/remote), keys, job timeout
- `node-banana-edge-appearance` - User default for connection line style and appearance (thickness, faded opacity, gradient, loading pulse)
- `node-banana-comfy-apps` - Saved Comfy nodes (workflow + contract + settings)
- `node-banana-agent-settings` - Agent harness, and model and thinking-effort choice per harness
- `node-banana-agent-conversations` - Agent chat history (messages, the agent's summary, workflow name, tab and id; newest 50, size-capped)
- `node-banana-agent-runs` - Runs the agent chat started and their outputs (asset ids and text; newest 100)
- `node-banana-agent-chat-sidebar` - The chat view's sidebar collapsed or open
- `node-banana-assets-tile-size` - Assets view tile size (S/M/L)
- `node-banana-assets-rail-open` - Which filter groups in the Assets rail are open
- `node-banana-assets-first-run-shown` - The one-time "Saved to …" hint after the first recorded asset has been shown
- `node-banana-models-cache` - The browse dialog's model list, one entry per set of configured providers
- `node-banana-models-notices-dismissed` - Provider failure notices the user closed in the browse dialog (by provider, the error text); cleared by Refresh catalog

The asset library's location and index live on disk, not in localStorage
(the desktop and web origins do not share it): `~/.node-banana/library.json`
and `<library>/.nodebanana/`, and the project registry in
`~/.node-banana/projects.json`.

## Git Workflow

- The primary development branch is `develop`, NOT `main` or `master`
- Always checkout `develop` before creating feature branches: `git checkout develop`
- Create feature branches from `develop` using: `feature/<short-description>` or `fix/<short-description>`
- All PRs MUST target `develop`: use `gh pr create --base develop`
- Never push directly to `main`, `master`, or `develop`

## Commits
- Commit after each logical task or unit of work is complete. When implementing a multi-task plan, commit after finishing each task — do NOT batch all tasks into a single commit at the end.
- Each commit should be atomic and self-contained: one task = one commit.
- The .planning directory is untracked, do not attempt to commit any changes to the files in this directory.

