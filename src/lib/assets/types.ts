/**
 * Asset library contracts.
 *
 * Every generated or edited asset is written to disk and indexed here,
 * whether or not its workflow has a project folder. Three layers share
 * these types: the server library (`src/lib/assets/server`), the API routes
 * (`src/app/api/assets`) and the client (`src/lib/assets/client`, the
 * workflow store, `src/components/assets`). Design notes live in
 * `docs/asset-library.md`.
 *
 * On disk, under the library root — the "Node Banana folder" (default
 * `~/Documents/Node Banana`), which also holds projects (`<root>/<Project>/`):
 *
 *   Generations/YYYY-MM-DD/HHMMSS_<snippet>_<sha8>.<ext>   assets of workflows with no project
 *   .nodebanana/assets/<assetId>.json                      one sidecar per asset (AssetRecord)
 *   .nodebanana/runs/<runId>.json.gz                       StoredRun: workflow snapshots of one run
 *   .nodebanana/media/<sha256>.<ext>                       snapshot media not held by any asset
 *   .nodebanana/media/<sha256>.ref                         checked pointer to a kept project file a snapshot uses
 *   .nodebanana/posters/<sha256>.webp                      browser-made posters for video/3D
 *   .nodebanana/workflows.json                             LibraryWorkflowEntry table
 *   .nodebanana/journal.ndjson                             mutation log (cross-process freshness, tombstones)
 *   .nodebanana/writers/<pid>-<instance>.json              in-flight writes of each server (a move waits for them)
 *   .nodebanana/pending-release/<uuid>.json                files a delete kept while a record couldn't be read; released later
 *   .nodebanana/lock, move.json, move-copied.ndjson        a running move, and what to undo if it stops part-way
 *
 * Assets of project-bound workflows are written to `<project>/generations/`
 * with the legacy `<snippet>_<md5>.<ext>` name and indexed in place. The
 * projects the app knows about, wherever they are, are listed in
 * `~/.node-banana/projects.json` (the project registry).
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** `a` + base36 timestamp + base36 random. Minted by the client so it can be stored before the upload finishes. */
export const ASSET_ID_PATTERN = /^a[0-9a-z]{12,24}$/;
/** `r` + base36 timestamp + base36 random. */
export const RUN_ID_PATTERN = /^r[0-9a-z]{12,24}$/;
/** Lowercase hex SHA-256 of the file's bytes. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Workflow ids come from several generators (`wf_<ts>_<rand>`, templates, community files). Never used in a path. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export type AssetKind = "image" | "video" | "audio" | "3d";
/**
 * `uploaded`: a video or audio file the user added from their computer, through Add media (in the Edit video view,
 * and in an Edit Video node's editor, where it goes under "Uploads") or a drop on the view's media pane
 * (`src/lib/assets/client/upload.ts`). Node Banana 2.2.0 and earlier can't read records of this origin.
 */
export type AssetOrigin = "generated" | "edited" | "uploaded";

export const ASSET_KINDS: readonly AssetKind[] = ["image", "video", "audio", "3d"];
export const ASSET_ORIGINS: readonly AssetOrigin[] = ["generated", "edited", "uploaded"];

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

/** Library files are relative to the root with "/" separators; project files are absolute native paths. */
export type AssetFileLocation =
  | { root: "library"; rel: string }
  | { root: "external"; path: string };

export interface AssetModelRef {
  provider: string;
  modelId: string;
  displayName?: string;
}

export interface AssetCost {
  amount: number;
  currency: "USD";
  estimated: boolean;
}

/** Which run of a batch ("Run 10×") made an asset: the batch's id, the run (1-based) and the batch's size. */
export interface AssetBatch {
  id: string;
  index: number;
  count: number;
}

export interface AssetProducer {
  nodeId: string;
  nodeType: string;
  /** The node's custom title, if the user gave it one. */
  nodeTitle?: string;
  /**
   * What an edited asset did, e.g. "annotate", "removeBackground", "resize",
   * "gif", "stitch", "trim", "easeCurve", "frameGrab", "splitGrid", "splitToNodes".
   */
  operation?: string;
  /** Output handle for multi-output nodes (comfyApp). */
  outputHandle?: string;
  /** Index of this output within a batch run (array prompt input). */
  batchIndex?: number;
}

/** The sidecar written to `.nodebanana/assets/<id>.json`. Capped at 64 KB; no data:/blob: strings. */
export interface AssetRecord {
  v: 1;
  id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  mime: string;
  ext: string;
  bytes: number;
  sha256: string;
  md5: string;
  file: AssetFileLocation;
  /** Basename of the file on disk. */
  filename: string;
  /** The name the user gave it; absent = `filename`. One line, at most 120 characters (`src/lib/assets/name.ts`). */
  name?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** When the asset was produced (ms since epoch). Sort key together with `id`. */
  createdAt: number;
  /** The resolved prompt the executor actually sent (not the prompt node's raw text). */
  prompt?: string;
  model?: AssetModelRef;
  /** Parameters that ran. Scrubbed of media strings; long strings truncated. */
  parameters?: Record<string, unknown>;
  aspectRatio?: string;
  resolution?: string;
  cost?: AssetCost;
  producer: AssetProducer;
  workflowId: string;
  /** The workflow's name when the asset was made; the workflows table has the current one. */
  workflowName: string | null;
  runId: string;
  /** Set when the asset came from one run of a batch ("Run 10×"). */
  batch?: AssetBatch;
  tags: string[];
  favorite: boolean;
  /** Set when the asset is in the in-app Trash. */
  trashedAt?: number;
  /** A browser-made poster exists in `.nodebanana/posters/<sha256>.webp`. */
  hasPoster?: boolean;
  /** The asset came from "Import existing projects" rather than a live run (no run snapshot). */
  imported?: boolean;
  /**
   * The file's bytes are not a readable image/video/audio file; the record is
   * kept but never listed. Set only when nothing can read them (no format in
   * the first bytes, and sharp or mediabunny can't open them either).
   */
  unreadable?: true;
}

/** PUT /api/assets/workflows/[id] body. */
export interface WorkflowEntryUpdate {
  name: string | null;
  projectPath: string | null;
  forkedFrom?: string;
  /** When the caller observed these values (ms). An older observation never overwrites a newer stored one (a run's late upsert must not undo a rename made during the run). */
  asOf?: number;
}

/** One row per workflow in `.nodebanana/workflows.json`. Classification is a single write here. */
export interface LibraryWorkflowEntry {
  id: string;
  name: string | null;
  /** Absolute project folder, or null while the workflow has no project. */
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  /** Set when a save into a new folder re-minted the id (the old id's assets stay with the old project). */
  forkedFrom?: string;
}

/** What the API returns for an asset: the record joined with its workflow and file state. */
export interface AssetView extends AssetRecord {
  workflow: {
    id: string;
    name: string | null;
    projectPath: string | null;
  };
  /** The file could not be found at its recorded location when last checked. */
  missing?: boolean;
  /** Absolute path of the file, for display and "Show in Finder/Explorer". */
  displayPath: string;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export type AssetSort = "newest" | "oldest";
/** Which slice of the library: live assets, the in-app Trash, or live assets whose file is missing. No scope lists an `unreadable` record. */
export type AssetScope = "library" | "trash" | "missing";

/**
 * Filters combine with AND across groups and OR within a group.
 * Omitted or empty groups do not filter.
 */
export interface AssetQuery {
  scope?: AssetScope;
  /** Case-insensitive substring over prompt, name, filename, model, workflow name and tags. */
  q?: string;
  kinds?: AssetKind[];
  origins?: AssetOrigin[];
  tags?: string[];
  /** Model ids (`AssetModelRef.modelId`). */
  models?: string[];
  workflowIds?: string[];
  /** Project folders; the empty string means "not in a project". */
  projects?: string[];
  favorite?: boolean;
  /** createdAt lower bound (inclusive, ms). */
  from?: number;
  /** createdAt upper bound (exclusive, ms). */
  to?: number;
  sort?: AssetSort;
}

export interface AssetPageRequest extends AssetQuery {
  /** Opaque keyset cursor `(createdAt, id)` from a previous page. */
  cursor?: string;
  /** Only items strictly ahead of this head cursor in sort order (new arrivals). */
  newerThan?: string;
  /** Default 200, max 500. */
  limit?: number;
}

export interface AssetPage {
  assets: AssetView[];
  nextCursor: string | null;
  /** Cursor of the first item in the full result, for `newerThan` polling. */
  headCursor: string | null;
  /** Total matching the query (not just this page). */
  total: number;
  /** Sum of `bytes` over the matching set, for bulk-download thresholds. */
  totalBytes: number;
}

/** Counts over the records the Assets view can show (never an `unreadable` one). */
export interface AssetFacets {
  /** Live (not trashed) assets. */
  total: number;
  favorites: number;
  trash: number;
  missing: number;
  kinds: Record<AssetKind, number>;
  origins: Record<AssetOrigin, number>;
  models: { modelId: string; label: string; provider: string; count: number }[];
  tags: { tag: string; count: number }[];
  workflows: { id: string; name: string | null; projectPath: string | null; count: number; lastAt: number }[];
  /** `path` null = not in a project. */
  projects: { path: string | null; name: string; count: number }[];
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export type AssetSelection =
  | { mode: "ids"; ids: string[] }
  | { mode: "query"; query: AssetQuery; excludeIds: string[] };

export type AssetBulkOp =
  | { action: "tag"; tags: string[] }
  | { action: "untag"; tags: string[] }
  | { action: "favorite" }
  | { action: "unfavorite" }
  | { action: "trash" }
  | { action: "restore" }
  /**
   * Remove from the library for good. Library-owned files go to the OS
   * Trash/Recycle Bin unless another record or a stored workflow snapshot
   * still uses the bytes (then they move to `.nodebanana/media`). Files in
   * project folders stay unless `deleteProjectFiles` is set.
   */
  | { action: "delete"; deleteProjectFiles?: boolean };

export interface AssetBulkRequest {
  selection: AssetSelection;
  op: AssetBulkOp;
}

export interface AssetBulkResult {
  affected: number;
  ids: string[];
  errors: { id: string; error: string }[];
}

export interface AssetPatch {
  tags?: string[];
  favorite?: boolean;
  trashed?: boolean;
  /** The display name; `""` clears it. */
  name?: string;
}

/** `present`: a record exists (live or trashed) and the file is there. `gone`: permanently deleted, or the record's file is verified absent. `unknown`: this library has never seen the id, or is unavailable. Carousels prune only `gone`. */
export type AssetExistence = "present" | "gone" | "unknown";

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

/** Metadata sent with a new asset. The server derives mime/ext/bytes/hashes/dimensions from the bytes when it can. */
export interface RecordAssetMeta {
  id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  /** MIME type hint from the client (the server sniffs and may override). */
  mime?: string;
  createdAt: number;
  /** The display name to record it under (an upload's own file name); the library file gets its own name. */
  name?: string;
  prompt?: string;
  model?: AssetModelRef;
  parameters?: Record<string, unknown>;
  aspectRatio?: string;
  resolution?: string;
  cost?: AssetCost;
  producer: AssetProducer;
  workflowId: string;
  workflowName: string | null;
  /** The workflow's project folder, if it has one. The server writes into `<projectDir>/generations` (created if the project folder exists), else into the library. */
  projectDir?: string | null;
  runId: string;
  batch?: AssetBatch;
  width?: number;
  height?: number;
  durationSec?: number;
  tags?: string[];
}

/** POST /api/assets body. `upload`: the bytes follow in PUT /api/assets/uploads/[uploadId]. `url`: the server downloads an https URL from a provider. */
export interface RecordAssetRequest {
  meta: RecordAssetMeta;
  source: { type: "upload" } | { type: "url"; url: string };
}

export interface UploadTicket {
  uploadId: string;
  expiresAt: number;
}

export interface RecordAssetResult {
  asset: AssetView;
  /** Basename written or reused. In a project folder this is `<snippet>_<md5>.<ext>`. */
  filename: string;
  /** `filename` without its extension: the legacy carousel id for project folders. */
  legacyId: string;
  /** The bytes already existed in the destination folder, so no new file was written. */
  reusedFile: boolean;
}

/* ------------------------------------------------------------------ */
/* Workflow snapshots                                                  */
/* ------------------------------------------------------------------ */

/** Replaces a data:/blob: media string inside a stored workflow snapshot. */
export interface SnapshotMediaRef {
  $nbMedia: string; // sha256
  mime: string;
  bytes?: number;
}

/**
 * A workflow as stored for "open original workflow": the WorkflowFile shape
 * with media strings replaced by SnapshotMediaRef objects. Kept as `unknown`
 * node data here so this module does not depend on the store's types.
 */
export interface SnapshotWorkflow {
  version: 1;
  id?: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  edgeStyle: string;
  edgeAppearance?: unknown;
  groups?: Record<string, unknown>;
}

export interface RunMeta {
  id: string;
  workflowId: string;
  workflowName: string | null;
  projectPath: string | null;
  startedAt: number;
  updatedAt: number;
}

/** `.nodebanana/runs/<runId>.json.gz`. `start` is the graph when the run began; `final` the graph when it ended (only written if the canvas was not replaced mid-run). */
export interface StoredRun extends RunMeta {
  start?: SnapshotWorkflow;
  final?: SnapshotWorkflow;
  /** sha256 of every SnapshotMediaRef in start/final, for reference counting. */
  mediaHashes: string[];
}

/** PUT /api/assets/runs/[runId] */
export interface PutRunRequest {
  meta: Omit<RunMeta, "updatedAt">;
  phase: "start" | "final";
  workflow: SnapshotWorkflow;
  mediaHashes: string[];
}

export interface PutRunResult {
  /** Media the snapshot references that the server does not hold; the client uploads these. */
  missingMedia: string[];
}

/** GET /api/assets/[id]/workflow */
export interface AssetWorkflowResult {
  asset: AssetView;
  run: RunMeta;
  which: "final" | "start";
  workflow: SnapshotWorkflow;
}

/* ------------------------------------------------------------------ */
/* Library location and jobs                                           */
/* ------------------------------------------------------------------ */

export type LibraryRootSource = "env" | "config" | "default" | "fallback";

export interface LibraryStatus {
  /** Recording and browsing work. False on a read-only/hosted server, when the request guard refuses, or when no writable root exists. */
  available: boolean;
  /** Why not available, in words for the user. */
  reason?: string;
  /** Why not available, for code: "hosted" and "guard" do not change while the page is open (no point asking again); "unwritable" and "unavailable" may. */
  reasonCode?: "hosted" | "guard" | "unwritable" | "unavailable";
  root: string | null;
  source: LibraryRootSource;
  /** The platform default this machine would use. */
  defaultRoot: string;
  /** Set when the default could not be written and the library fell back to another folder. */
  fallbackReason?: string;
  cacheDir: string;
  platform: string;
  /** The root is inside a cloud-synced folder. */
  synced: "onedrive" | "icloud" | "dropbox" | null;
  /** What the Assets view can show: `unreadable` records are not counted. */
  counts: { assets: number; trashed: number; bytes: number };
  /** The library's first scan outlasted the request: `counts` are provisional zeros, so ask again shortly. */
  counting?: boolean;
  /** No asset has been recorded yet (drives the first-run hint). */
  empty: boolean;
  job: LibraryJobStatus | null;
}

export interface SetLibraryRootRequest {
  root: string;
  /** `move`: copy this library there (background job), then switch. `switch`: use that folder as it is (the old library stays on disk). */
  mode: "move" | "switch";
  /**
   * `move` only: project folders (the old folder's own) that move into the
   * new folder once the library has, in the same job, so leaving the page
   * never strands them.
   */
  projects?: string[];
}

/** `projects`: move project folders into the Node Banana folder. */
export type LibraryJobType = "move" | "import" | "cleanup" | "export" | "projects";

export interface LibraryJobStatus {
  id: string;
  type: LibraryJobType;
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** A projects move: the folders that moved, and where to. */
  moved?: MovedProject[];
}

/** One folder a projects move handled. */
export interface MovedProject {
  from: string;
  to: string;
  /** The copy is in place and the library follows it, but some of the old folder could not be removed. */
  leftovers?: boolean;
}

/** POST /api/assets/import: index the generations of existing project folders. */
export interface ImportProjectsRequest {
  projectDirs: string[];
}

/** Most project folders one import takes, and one search reports. */
export const MAX_IMPORT_PROJECTS = 500;

/** POST /api/assets/import/scan: find the Node Banana projects under a folder, nested ones included. */
export interface ScanProjectsRequest {
  root: string;
}

/** A folder whose `generations` subfolder holds media: what an import of it would index. */
export interface FoundProject {
  /** Absolute folder. */
  dir: string;
  /** The name in its newest workflow file, else the folder's own name. */
  name: string;
  /** Media files directly in its `generations` folder, counted up to {@link FOUND_MEDIA_COUNT_CAP}. */
  mediaCount: number;
  /** Size of the whole folder, as far as a bounded count got (moving it moves all of it). */
  bytes?: number;
}

/** `FoundProject.mediaCount` stops counting here. */
export const FOUND_MEDIA_COUNT_CAP = 10_000;

export interface ScanProjectsResult {
  /** The folder searched, as the server resolved it. */
  root: string;
  /** Sorted by path. */
  projects: FoundProject[];
  /** The search stopped at a bound (folders visited, projects found, time) before it was done. */
  truncated: boolean;
  /** Folders that could not be read (no permission, gone); the search went on without them. */
  unreadable: number;
  /**
   * Every visible entry at the top of the folder is a project, holds
   * projects, or is a loose workflow file: the folder looks like a Node
   * Banana folder already, so "Make this my Node Banana folder" is the
   * suggestion.
   */
  recommendUse?: boolean;
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/**
 * A project the app knows about: a folder under the Node Banana folder,
 * one the registry (`projects.json`) lists, or one a workflow row names.
 */
export interface KnownProject {
  /** Absolute folder. */
  dir: string;
  /** The name in its newest workflow file, else the folder's own name. */
  name: string;
  /** Relative to the Node Banana folder ("/"-separated) when it is inside it, else null. */
  relativePath: string | null;
  inRoot: boolean;
  /** mtime of its newest workflow file (ms), else of the folder. */
  lastModified: number;
  /** Media files directly in its `generations` folder, capped like {@link FoundProject.mediaCount}. */
  mediaCount: number;
}

/** Known projects outside the Node Banana folder: what "Move them in" would move. */
export interface ProjectsElsewhere {
  /** Outermost folders only: a project inside another moves with it. */
  count: number;
  /** Those folders: what "Move them in" sends. */
  dirs: string[];
  bytes: number;
  /** By parent folder (`~`-shortened), largest first. */
  groups: { label: string; count: number }[];
}

/** GET /api/assets/projects */
export interface ProjectsOverview {
  root: string;
  /** Newest first. */
  projects: KnownProject[];
  elsewhere: ProjectsElsewhere | null;
  offerDismissed: boolean;
  /** Bytes in the projects inside the Node Banana folder (what "Move everything there" carries besides the library). */
  rootBytes?: number;
}

/** POST /api/assets/projects/report: what this browser's localStorage knows, sent once per page load. */
export interface ReportProjectsRequest {
  /** The old default workflows folder (`node-banana-workflows-directory`). */
  workflowsDir?: string | null;
  projects: { dir: string; name?: string | null; lastOpenedAt?: number | null }[];
}

export interface ReportProjectsResult {
  /** The Node Banana folder became (or is moving to) `workflowsDir`. */
  adopted: boolean;
  root: string | null;
}

/**
 * POST /api/assets/projects/bring-in. `use`: `folder` becomes the Node
 * Banana folder. `move`: the project folders move into it. `leave`: they
 * stay where they are and are listed (and indexed) from there.
 */
export interface BringInProjectsRequest {
  dirs: string[];
  mode: "use" | "move" | "leave";
  folder?: string;
}

export interface BringInProjectsResult {
  root: string | null;
  /** The move started, when there is one to follow. */
  job: LibraryJobStatus | null;
}

/** POST /api/assets/projects/offer */
export interface ProjectsOfferRequest {
  dismissed: true;
}

/** GET /api/assets/projects/folder-name?name= */
export interface ProjectFolderName {
  /** The folder name a project of that name gets (sanitised, numbered past a taken one). */
  folder: string;
  /** `<root>/<folder>`. */
  path: string;
  /** A folder of the plain name was already there, so this one got a number. */
  taken: boolean;
}

/** POST /api/assets/reveal: show an asset's file, or the library folder, in Finder/Explorer. */
export type RevealRequest = { id: string } | { target: "root" };

/** POST /api/assets/cleanup. `unusedMedia`: delete snapshot media and posters nothing references. `thumbnails`: empty the thumbnail cache. */
export interface CleanupRequest {
  unusedMedia?: boolean;
  thumbnails?: boolean;
}

/** POST /api/assets/export: copy files to a folder the user picked. */
export interface ExportAssetsRequest {
  selection: AssetSelection;
  dest: string;
}

/* ------------------------------------------------------------------ */
/* Client recording                                                    */
/* ------------------------------------------------------------------ */

/** What an executor or UI action hands to the recorder. */
export interface RecordAssetInput {
  kind: AssetKind;
  origin: AssetOrigin;
  /**
   * A data: URL, blob: URL, http(s) URL or a Blob. data:/blob: are turned
   * into a Blob when the call is made (a revoked blob: URL later would lose
   * the bytes); http(s) URLs are downloaded by the server.
   */
  media: string | Blob;
  mime?: string;
  /** The display name (`AssetRecord.name`). */
  name?: string;
  prompt?: string;
  model?: AssetModelRef;
  parameters?: Record<string, unknown>;
  aspectRatio?: string;
  resolution?: string;
  cost?: AssetCost;
  producer: AssetProducer;
  width?: number;
  height?: number;
  durationSec?: number;
}

/** The workflow a recording belongs to, captured when its run started. */
export interface AssetRunContext {
  runId: string;
  workflowId: string;
  workflowName: string | null;
  /** The workflow's project folder, or null. */
  projectDir: string | null;
  startedAt: number;
  /** Set when the run is one of a batch ("Run 10×"). */
  batch?: AssetBatch;
}

/** Returned synchronously so the id can go into node data with the output itself. */
export interface RecordedAssetHandle {
  assetId: string;
  /** Resolves when the asset is on disk; null if recording failed (the failure is reported once by the recorder). */
  done: Promise<RecordAssetResult | null>;
}

/* ------------------------------------------------------------------ */
/* Desktop bridge (server side)                                        */
/* ------------------------------------------------------------------ */

/**
 * Installed on `globalThis.__nodeBananaDesktop` by electron/server.cjs so
 * route code can ask the Electron main process for native actions. Absent in
 * web mode, where the server uses OS tools instead.
 */
export interface DesktopServerBridge {
  request(
    type: "reveal" | "trash" | "choose-directory",
    payload: { path?: string; title?: string },
  ): Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const ASSET_ROUTES = {
  list: "/api/assets", // GET ?<encodeAssetPageRequest(...)> (src/lib/assets/query.ts) → AssetPage
  record: "/api/assets", // POST RecordAssetRequest
  upload: (uploadId: string) => `/api/assets/uploads/${uploadId}`, // PUT raw bytes
  facets: "/api/assets/facets", // GET
  asset: (id: string) => `/api/assets/${id}`, // GET, PATCH AssetPatch
  file: (id: string) => `/api/assets/${id}/file`, // GET (?download=1)
  poster: (id: string) => `/api/assets/${id}/poster`, // PUT image/webp|jpeg
  workflow: (id: string) => `/api/assets/${id}/workflow`, // GET AssetWorkflowResult
  thumb: (sha256: string, width: 320 | 640) => `/api/assets/thumb/${sha256}?w=${width}`, // GET webp | 204
  bulk: "/api/assets/bulk", // POST AssetBulkRequest
  exists: "/api/assets/exists", // POST { ids } → { states: Record<id, AssetExistence> }
  reveal: "/api/assets/reveal", // POST RevealRequest
  mediaHas: "/api/assets/media/has", // POST { hashes } → { missing }
  media: (sha256: string) => `/api/assets/media/${sha256}`, // PUT raw bytes (x-nb-mime header), GET bytes
  run: (runId: string) => `/api/assets/runs/${runId}`, // PUT PutRunRequest
  workflowEntry: (workflowId: string) => `/api/assets/workflows/${encodeURIComponent(workflowId)}`, // PUT { name, projectPath, forkedFrom? }
  library: "/api/assets/library", // GET LibraryStatus, PUT SetLibraryRootRequest
  job: (jobId: string) => `/api/assets/jobs/${jobId}`, // GET LibraryJobStatus, DELETE cancels
  importProjects: "/api/assets/import", // POST ImportProjectsRequest → { job }
  scanProjects: "/api/assets/import/scan", // POST ScanProjectsRequest → ScanProjectsResult
  cleanup: "/api/assets/cleanup", // POST CleanupRequest → { job }
  exportAssets: "/api/assets/export", // POST ExportAssetsRequest → { job }
  projects: "/api/assets/projects", // GET ProjectsOverview
  reportProjects: "/api/assets/projects/report", // POST ReportProjectsRequest → ReportProjectsResult
  bringInProjects: "/api/assets/projects/bring-in", // POST BringInProjectsRequest → BringInProjectsResult
  projectsOffer: "/api/assets/projects/offer", // POST ProjectsOfferRequest → { ok }
  projectFolderName: (name: string) => `/api/assets/projects/folder-name?name=${encodeURIComponent(name)}`, // GET ProjectFolderName
} as const;

/** Thumbnail widths the server renders. The client picks the smallest ≥ tile CSS width × devicePixelRatio. */
export const THUMB_WIDTHS = [320, 640] as const;
