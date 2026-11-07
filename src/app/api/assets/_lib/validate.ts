/**
 * Request bodies of the `/api/assets/*` routes, checked at the door.
 *
 * The routes check shape: every field the contract types promise has that
 * type, ids and hashes match their patterns, and folders a client names are
 * absolute and outside the system folders (validateWorkflowPath, whose
 * resolved form is what the library receives). Meaning — size caps on
 * prompts, URL policy, whether a folder exists — is the library's to judge.
 * Every failure throws a 400 naming the field.
 */

import { assetNameProblem } from "@/lib/assets/name";
import { decodeAssetPageRequest, encodeAssetPageRequest, queryOf } from "@/lib/assets/query";
import {
  ASSET_ID_PATTERN,
  ASSET_KINDS,
  ASSET_ORIGINS,
  MAX_IMPORT_PROJECTS,
  RUN_ID_PATTERN,
  SHA256_PATTERN,
  WORKFLOW_ID_PATTERN,
  type AssetBulkOp,
  type AssetBulkRequest,
  type AssetModelRef,
  type AssetPageRequest,
  type AssetPatch,
  type AssetProducer,
  type AssetQuery,
  type AssetSelection,
  type BringInProjectsRequest,
  type CleanupRequest,
  type ExportAssetsRequest,
  type ImportProjectsRequest,
  type ProjectsOfferRequest,
  type PutRunRequest,
  type RecordAssetMeta,
  type RecordAssetRequest,
  type ReportProjectsRequest,
  type RevealRequest,
  type ScanProjectsRequest,
  type SetLibraryRootRequest,
  type SnapshotWorkflow,
  type WorkflowEntryUpdate,
} from "@/lib/assets/types";
import { validateWorkflowPath } from "@/utils/pathValidation";
import { badRequest } from "./http";

/** Ids in one explicit selection (the grid keeps at most 5,000 loaded; "all matching" switches to a query). */
export const MAX_SELECTION_IDS = 10_000;
/** POST /exists: one carousel's worth of ids and more. */
export const MAX_EXISTS_IDS = 1000;
/** POST /media/has: the media of one snapshot. */
export const MAX_MEDIA_HASHES = 5000;
/** Tags in one patch or bulk operation, and the longest tag. */
export const MAX_TAGS = 200;
export const MAX_TAG_LENGTH = 200;
/** Project folders in one import. */
export const MAX_IMPORT_DIRS = MAX_IMPORT_PROJECTS;
/** Projects one page load reports (its localStorage's project folders). */
export const MAX_REPORTED_PROJECTS = 2000;
/** The longest project name a folder name is asked for. */
export const MAX_PROJECT_NAME = 512;
/** Hashes referenced by one stored run. */
export const MAX_RUN_MEDIA_HASHES = 50_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, field: string): Json {
  if (!isObject(value)) throw badRequest(`${field} must be an object.`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw badRequest(`${field} must be a string.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} must be true or false.`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw badRequest(`${field} must be a number.`);
  return value;
}

function optionalPositive(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = finiteNumber(value, field);
  if (n <= 0) throw badRequest(`${field} must be positive.`);
  return n;
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw badRequest(`${field} is not valid.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list.`);
  if (value.length > max) throw badRequest(`${field} has more than ${max.toLocaleString("en-US")} entries.`);
  return value;
}

function stringList(value: unknown, field: string, max: number): string[] {
  return array(value, field, max).map((entry, i) => string(entry, `${field}[${i}]`));
}

function patternList(value: unknown, pattern: RegExp, field: string, max: number): string[] {
  return array(value, field, max).map((entry, i) => matching(entry, pattern, `${field}[${i}]`));
}

function tagList(value: unknown, field: string): string[] {
  return stringList(value, field, MAX_TAGS).map((tag, i) => {
    if (!tag.trim()) throw badRequest(`${field}[${i}] is empty.`);
    if (tag.length > MAX_TAG_LENGTH) throw badRequest(`${field}[${i}] is longer than ${MAX_TAG_LENGTH} characters.`);
    return tag;
  });
}

/** A display name, trimmed; "" clears it. */
function displayName(value: unknown, field: string): string {
  const name = string(value, field).trim();
  const problem = assetNameProblem(name, field);
  if (problem) throw badRequest(problem);
  return name;
}

/** A folder the client names, as validateWorkflowPath resolves it. */
export function folder(value: unknown, field: string): string {
  const result = validateWorkflowPath(string(value, field));
  if (!result.valid) throw badRequest(`${field}: ${result.error}.`);
  return result.resolved;
}

/* Recording ---------------------------------------------------------- */

function modelRef(value: unknown, field: string): AssetModelRef {
  const model = object(value, field);
  return {
    provider: string(model.provider, `${field}.provider`),
    modelId: string(model.modelId, `${field}.modelId`),
    ...(model.displayName !== undefined && { displayName: string(model.displayName, `${field}.displayName`) }),
  };
}

function producer(value: unknown, field: string): AssetProducer {
  const p = object(value, field);
  const result: AssetProducer = {
    nodeId: string(p.nodeId, `${field}.nodeId`),
    nodeType: string(p.nodeType, `${field}.nodeType`),
  };
  for (const key of ["nodeTitle", "operation", "outputHandle"] as const) {
    const v = optionalString(p[key], `${field}.${key}`);
    if (v !== undefined) result[key] = v;
  }
  if (p.batchIndex !== undefined) {
    const index = finiteNumber(p.batchIndex, `${field}.batchIndex`);
    if (!Number.isInteger(index) || index < 0) throw badRequest(`${field}.batchIndex must be a whole number.`);
    result.batchIndex = index;
  }
  return result;
}

function recordMeta(value: unknown): RecordAssetMeta {
  const m = object(value, "meta");
  const meta: RecordAssetMeta = {
    id: matching(m.id, ASSET_ID_PATTERN, "meta.id"),
    kind: oneOf(m.kind, ASSET_KINDS, "meta.kind"),
    origin: oneOf(m.origin, ASSET_ORIGINS, "meta.origin"),
    createdAt: finiteNumber(m.createdAt, "meta.createdAt"),
    producer: producer(m.producer, "meta.producer"),
    workflowId: matching(m.workflowId, WORKFLOW_ID_PATTERN, "meta.workflowId"),
    workflowName: nullableString(m.workflowName ?? null, "meta.workflowName"),
    runId: matching(m.runId, RUN_ID_PATTERN, "meta.runId"),
  };
  for (const key of ["mime", "prompt", "aspectRatio", "resolution"] as const) {
    const v = optionalString(m[key], `meta.${key}`);
    if (v !== undefined) meta[key] = v;
  }
  if (m.name !== undefined) {
    const name = displayName(m.name, "meta.name");
    if (name) meta.name = name;
  }
  if (m.model !== undefined) meta.model = modelRef(m.model, "meta.model");
  if (m.parameters !== undefined) meta.parameters = object(m.parameters, "meta.parameters");
  if (m.cost !== undefined) {
    const cost = object(m.cost, "meta.cost");
    if (cost.currency !== "USD") throw badRequest("meta.cost.currency must be USD.");
    meta.cost = {
      amount: finiteNumber(cost.amount, "meta.cost.amount"),
      currency: "USD",
      estimated: optionalBoolean(cost.estimated, "meta.cost.estimated") ?? false,
    };
  }
  if (m.projectDir !== undefined) meta.projectDir = nullableString(m.projectDir, "meta.projectDir");
  for (const key of ["width", "height", "durationSec"] as const) {
    const v = optionalPositive(m[key], `meta.${key}`);
    if (v !== undefined) meta[key] = v;
  }
  if (m.tags !== undefined) meta.tags = tagList(m.tags, "meta.tags");
  return meta;
}

export function parseRecordRequest(body: unknown): RecordAssetRequest {
  const request = object(body, "The request");
  const meta = recordMeta(request.meta);
  const source = object(request.source, "source");
  if (source.type === "upload") return { meta, source: { type: "upload" } };
  if (source.type === "url") {
    const url = string(source.url, "source.url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest("source.url is not a URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("source.url must be a web address.");
    return { meta, source: { type: "url", url } };
  }
  throw badRequest("source.type must be upload or url.");
}

/* Browsing and mutations --------------------------------------------- */

export function parsePatch(body: unknown): AssetPatch {
  const p = object(body, "The patch");
  const patch: AssetPatch = {};
  if (p.tags !== undefined) patch.tags = tagList(p.tags, "tags");
  const favorite = optionalBoolean(p.favorite, "favorite");
  if (favorite !== undefined) patch.favorite = favorite;
  const trashed = optionalBoolean(p.trashed, "trashed");
  if (trashed !== undefined) patch.trashed = trashed;
  if (p.name !== undefined) patch.name = displayName(p.name, "name");
  if (Object.keys(patch).length === 0) throw badRequest("The patch changes nothing: send tags, favorite, trashed or name.");
  return patch;
}

const SCOPES = ["library", "trash", "missing"] as const;
const SORTS = ["newest", "oldest"] as const;

/**
 * An AssetQuery from JSON. Unknown values are refused rather than dropped
 * (a bulk delete must never widen to another scope), then the query goes
 * through the URL codec so a bulk operation selects exactly what the grid
 * listed for the same filters.
 */
export function parseQuery(value: unknown, field: string): AssetQuery {
  const q = object(value, field);
  const draft: AssetPageRequest = {};
  if (q.scope !== undefined) draft.scope = oneOf(q.scope, SCOPES, `${field}.scope`);
  if (q.q !== undefined) draft.q = string(q.q, `${field}.q`);
  if (q.kinds !== undefined) {
    draft.kinds = array(q.kinds, `${field}.kinds`, ASSET_KINDS.length).map((k, i) =>
      oneOf(k, ASSET_KINDS, `${field}.kinds[${i}]`),
    );
  }
  if (q.origins !== undefined) {
    draft.origins = array(q.origins, `${field}.origins`, ASSET_ORIGINS.length).map((o, i) =>
      oneOf(o, ASSET_ORIGINS, `${field}.origins[${i}]`),
    );
  }
  for (const key of ["tags", "models", "workflowIds", "projects"] as const) {
    if (q[key] !== undefined) draft[key] = stringList(q[key], `${field}.${key}`, 1000);
  }
  const favorite = optionalBoolean(q.favorite, `${field}.favorite`);
  if (favorite !== undefined) draft.favorite = favorite;
  if (q.from !== undefined) draft.from = finiteNumber(q.from, `${field}.from`);
  if (q.to !== undefined) draft.to = finiteNumber(q.to, `${field}.to`);
  if (q.sort !== undefined) draft.sort = oneOf(q.sort, SORTS, `${field}.sort`);
  return queryOf(decodeAssetPageRequest(encodeAssetPageRequest(draft)));
}

export function parseSelection(value: unknown): AssetSelection {
  const selection = object(value, "selection");
  if (selection.mode === "ids") {
    const ids = patternList(selection.ids, ASSET_ID_PATTERN, "selection.ids", MAX_SELECTION_IDS);
    if (ids.length === 0) throw badRequest("selection.ids is empty.");
    return { mode: "ids", ids };
  }
  if (selection.mode === "query") {
    return {
      mode: "query",
      query: parseQuery(selection.query, "selection.query"),
      excludeIds: patternList(selection.excludeIds ?? [], ASSET_ID_PATTERN, "selection.excludeIds", MAX_SELECTION_IDS),
    };
  }
  throw badRequest("selection.mode must be ids or query.");
}

function bulkOp(value: unknown): AssetBulkOp {
  const op = object(value, "op");
  switch (op.action) {
    case "tag":
    case "untag": {
      const tags = tagList(op.tags, "op.tags");
      if (tags.length === 0) throw badRequest("op.tags is empty.");
      return { action: op.action, tags };
    }
    case "favorite":
    case "unfavorite":
    case "trash":
    case "restore":
      return { action: op.action };
    case "delete": {
      const deleteProjectFiles = optionalBoolean(op.deleteProjectFiles, "op.deleteProjectFiles");
      return deleteProjectFiles === undefined ? { action: "delete" } : { action: "delete", deleteProjectFiles };
    }
    default:
      throw badRequest("op.action must be one of: tag, untag, favorite, unfavorite, trash, restore, delete.");
  }
}

export function parseBulkRequest(body: unknown): AssetBulkRequest {
  const request = object(body, "The request");
  return { selection: parseSelection(request.selection), op: bulkOp(request.op) };
}

/** POST /exists: any string is accepted, so an id the library could never hold simply reads `unknown`. */
export function parseExistsIds(body: unknown): string[] {
  const request = object(body, "The request");
  return stringList(request.ids, "ids", MAX_EXISTS_IDS);
}

export function parseRevealRequest(body: unknown): RevealRequest {
  const request = object(body, "The request");
  if (request.target === "root") return { target: "root" };
  if (request.id !== undefined) return { id: matching(request.id, ASSET_ID_PATTERN, "id") };
  throw badRequest('Send an asset id, or target: "root".');
}

/* Posters ------------------------------------------------------------ */

/** The poster formats a browser canvas can encode. */
export const POSTER_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
export type PosterType = (typeof POSTER_TYPES)[number];

/** The poster's real format from its first bytes, whatever the request claimed; null when it is none of the three. */
export function sniffPosterType(bytes: Uint8Array): PosterType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return "image/png";
  }
  return null;
}

/* Snapshots ---------------------------------------------------------- */

export function parseMediaHashes(body: unknown): string[] {
  const request = object(body, "The request");
  return patternList(request.hashes, SHA256_PATTERN, "hashes", MAX_MEDIA_HASHES);
}

function snapshotWorkflow(value: unknown): SnapshotWorkflow {
  const workflow = object(value, "workflow");
  array(workflow.nodes, "workflow.nodes", Number.MAX_SAFE_INTEGER);
  array(workflow.edges, "workflow.edges", Number.MAX_SAFE_INTEGER);
  string(workflow.name, "workflow.name");
  if (workflow.version !== 1) throw badRequest("workflow.version must be 1.");
  return workflow as unknown as SnapshotWorkflow;
}

export function parsePutRunRequest(runId: string, body: unknown): PutRunRequest {
  const request = object(body, "The request");
  const m = object(request.meta, "meta");
  const id = matching(m.id, RUN_ID_PATTERN, "meta.id");
  if (id !== runId) throw badRequest("meta.id does not match the run in the URL.");
  const phase = request.phase;
  if (phase !== "start" && phase !== "final") throw badRequest("phase must be start or final.");
  return {
    meta: {
      id,
      workflowId: matching(m.workflowId, WORKFLOW_ID_PATTERN, "meta.workflowId"),
      workflowName: nullableString(m.workflowName ?? null, "meta.workflowName"),
      projectPath: nullableString(m.projectPath ?? null, "meta.projectPath"),
      startedAt: finiteNumber(m.startedAt, "meta.startedAt"),
    },
    phase,
    workflow: snapshotWorkflow(request.workflow),
    mediaHashes: patternList(request.mediaHashes, SHA256_PATTERN, "mediaHashes", MAX_RUN_MEDIA_HASHES),
  };
}

export function parseWorkflowEntry(body: unknown): WorkflowEntryUpdate {
  const request = object(body, "The request");
  const entry: WorkflowEntryUpdate = {
    name: nullableString(request.name ?? null, "name"),
    projectPath: request.projectPath == null ? null : folder(request.projectPath, "projectPath"),
  };
  if (request.forkedFrom != null) entry.forkedFrom = matching(request.forkedFrom, WORKFLOW_ID_PATTERN, "forkedFrom");
  if (request.asOf != null) entry.asOf = finiteNumber(request.asOf, "asOf");
  return entry;
}

/* Library and jobs --------------------------------------------------- */

export function parseSetLibraryRoot(body: unknown): SetLibraryRootRequest {
  const request = object(body, "The request");
  const mode = oneOf(request.mode, ["move", "switch"] as const, "mode");
  const projects = array(request.projects ?? [], "projects", MAX_IMPORT_DIRS).map((dir, i) => folder(dir, `projects[${i}]`));
  return {
    root: folder(request.root, "root"),
    mode,
    ...(mode === "move" && projects.length ? { projects: [...new Set(projects)] } : {}),
  };
}

export function parseImportRequest(body: unknown): ImportProjectsRequest {
  const request = object(body, "The request");
  const dirs = array(request.projectDirs, "projectDirs", MAX_IMPORT_DIRS).map((dir, i) => folder(dir, `projectDirs[${i}]`));
  if (dirs.length === 0) throw badRequest("Choose at least one project folder to import.");
  return { projectDirs: [...new Set(dirs)] };
}

export function parseScanProjectsRequest(body: unknown): ScanProjectsRequest {
  const request = object(body, "The request");
  return { root: folder(request.root, "root") };
}

export function parseCleanupRequest(body: unknown): CleanupRequest {
  const request = object(body, "The request");
  const cleanup: CleanupRequest = {};
  const unusedMedia = optionalBoolean(request.unusedMedia, "unusedMedia");
  const thumbnails = optionalBoolean(request.thumbnails, "thumbnails");
  if (unusedMedia !== undefined) cleanup.unusedMedia = unusedMedia;
  if (thumbnails !== undefined) cleanup.thumbnails = thumbnails;
  if (!cleanup.unusedMedia && !cleanup.thumbnails) throw badRequest("Nothing to clean up: set unusedMedia or thumbnails.");
  return cleanup;
}

export function parseExportRequest(body: unknown): ExportAssetsRequest {
  const request = object(body, "The request");
  return { selection: parseSelection(request.selection), dest: folder(request.dest, "dest") };
}

/* Projects ----------------------------------------------------------- */

/**
 * What a page load remembers is whatever its localStorage held, so a
 * folder that fails the checks (a relative path, a system folder) is left
 * out rather than refusing the rest.
 */
export function parseReportProjects(body: unknown): ReportProjectsRequest {
  const request = object(body, "The request");
  const projects: ReportProjectsRequest["projects"] = [];
  array(request.projects ?? [], "projects", MAX_REPORTED_PROJECTS).forEach((value) => {
    if (!isObject(value) || typeof value.dir !== "string") return;
    const checked = validateWorkflowPath(value.dir);
    if (!checked.valid) return;
    projects.push({
      dir: checked.resolved,
      name: typeof value.name === "string" ? value.name.slice(0, MAX_PROJECT_NAME) : null,
      lastOpenedAt: typeof value.lastOpenedAt === "number" && Number.isFinite(value.lastOpenedAt) ? value.lastOpenedAt : null,
    });
  });
  let workflowsDir: string | null = null;
  if (typeof request.workflowsDir === "string" && request.workflowsDir.trim()) {
    const checked = validateWorkflowPath(request.workflowsDir);
    if (checked.valid) workflowsDir = checked.resolved;
  }
  return { workflowsDir, projects };
}

export function parseBringInProjects(body: unknown): BringInProjectsRequest {
  const request = object(body, "The request");
  const mode = oneOf(request.mode, ["use", "move", "leave"] as const, "mode");
  const dirs = array(request.dirs ?? [], "dirs", MAX_IMPORT_DIRS).map((dir, i) => folder(dir, `dirs[${i}]`));
  if (mode === "use") {
    return { dirs: [...new Set(dirs)], mode, folder: folder(request.folder, "folder") };
  }
  if (dirs.length === 0) throw badRequest("Choose at least one project folder.");
  return { dirs: [...new Set(dirs)], mode };
}

export function parseProjectsOffer(body: unknown): ProjectsOfferRequest {
  const request = object(body, "The request");
  if (request.dismissed !== true) throw badRequest("dismissed must be true.");
  return { dismissed: true };
}

/** `?name=` of GET /projects/folder-name. */
export function parseProjectName(value: string | null): string {
  if (value === null) throw badRequest("name is required.");
  if (value.length > MAX_PROJECT_NAME) throw badRequest(`name is longer than ${MAX_PROJECT_NAME} characters.`);
  return value;
}
