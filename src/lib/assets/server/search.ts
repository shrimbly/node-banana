/**
 * Pure query machinery over the in-memory index: sort order, keyset cursors,
 * filter compilation and facets. No I/O, so it is cheap to test and to
 * measure (a 20k library filters and facets in a few milliseconds).
 */

import path from "path";
import type {
  AssetFacets,
  AssetKind,
  AssetOrigin,
  AssetQuery,
  AssetRecord,
  AssetSort,
} from "../types";
import { ASSET_KINDS, ASSET_ORIGINS } from "../types";
import { LibraryError } from "./errors";
import { isAssetId } from "./validate";

/* ------------------------------------------------------------------ */
/* Order and cursors                                                   */
/* ------------------------------------------------------------------ */

export interface SortKey {
  createdAt: number;
  id: string;
}

/** Newest first: `(createdAt desc, id desc)`. Negative when `a` comes first. */
export function compareNewest(a: SortKey, b: SortKey): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function comparatorFor(sort: AssetSort | undefined): (a: SortKey, b: SortKey) => number {
  return sort === "oldest" ? (a, b) => compareNewest(b, a) : compareNewest;
}

/** Opaque to the client: `<createdAt base36>.<id>`. */
export function encodeCursor(key: SortKey): string {
  return `${Math.floor(key.createdAt).toString(36)}.${key.id}`;
}

export function decodeCursor(cursor: string): SortKey {
  const dot = cursor.indexOf(".");
  const createdAt = dot > 0 ? parseInt(cursor.slice(0, dot), 36) : NaN;
  const id = dot > 0 ? cursor.slice(dot + 1) : "";
  if (!Number.isFinite(createdAt) || !isAssetId(id)) {
    throw new LibraryError("Invalid cursor", 400, "bad_request");
  }
  return { createdAt, id };
}

/** Index of the first item that sorts strictly after `key` (binary search over a sorted array). */
export function indexAfter<T extends SortKey>(items: readonly T[], key: SortKey, compare: (a: SortKey, b: SortKey) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(items[mid], key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first item that does not sort before `key`. */
export function indexAtOrAfter<T extends SortKey>(items: readonly T[], key: SortKey, compare: (a: SortKey, b: SortKey) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(items[mid], key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/** What a query needs to know beyond the record itself. */
export interface QueryContext {
  /** The workflow's current name and project (the workflows table, else the record). */
  workflowOf(record: AssetRecord): { name: string | null; projectPath: string | null };
  isMissing(id: string): boolean;
  /** Lowercase text of the record's own searchable fields. */
  searchText(record: AssetRecord): string;
  /** Compares project folders with the platform's case rules. */
  projectKey(projectPath: string): string;
}

/** Splits a search box into lowercase terms; every term must match. */
export function searchTerms(q: string | undefined): string[] {
  return (q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 16);
}

/** The lowercase haystack for a record: prompt, display name, filename, model, workflow name and tags. */
export function recordSearchText(record: AssetRecord): string {
  return [
    record.prompt ?? "",
    record.name ?? "",
    record.filename,
    record.model?.modelId ?? "",
    record.model?.displayName ?? "",
    record.workflowName ?? "",
    record.tags.join("\n"),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * A predicate for a query: AND across groups, OR within one. The scope
 * decides trashed vs live, and `missing` narrows live records to those whose
 * file was last found absent. No scope matches an `unreadable` record.
 */
export function compileQuery(query: AssetQuery, ctx: QueryContext): (record: AssetRecord) => boolean {
  const scope = query.scope ?? "library";
  const kinds = query.kinds?.length ? new Set<AssetKind>(query.kinds) : null;
  const origins = query.origins?.length ? new Set<AssetOrigin>(query.origins) : null;
  const tags = query.tags?.length ? new Set(query.tags.map((tag) => tag.toLowerCase())) : null;
  const models = query.models?.length ? new Set(query.models) : null;
  const workflows = query.workflowIds?.length ? new Set(query.workflowIds) : null;
  const projects = query.projects?.length
    ? new Set(query.projects.map((project) => (project === "" ? "" : ctx.projectKey(project))))
    : null;
  const terms = searchTerms(query.q);
  const from = typeof query.from === "number" ? query.from : null;
  const to = typeof query.to === "number" ? query.to : null;

  return (record) => {
    if (record.unreadable) return false;
    if (scope === "trash") {
      if (record.trashedAt === undefined) return false;
    } else {
      if (record.trashedAt !== undefined) return false;
      if (scope === "missing" && !ctx.isMissing(record.id)) return false;
    }
    if (kinds && !kinds.has(record.kind)) return false;
    if (origins && !origins.has(record.origin)) return false;
    if (query.favorite !== undefined && record.favorite !== query.favorite) return false;
    if (from !== null && record.createdAt < from) return false;
    if (to !== null && record.createdAt >= to) return false;
    if (models && !(record.model && models.has(record.model.modelId))) return false;
    if (workflows && !workflows.has(record.workflowId)) return false;
    if (tags && !record.tags.some((tag) => tags.has(tag.toLowerCase()))) return false;
    if (projects || terms.length) {
      const workflow = ctx.workflowOf(record);
      if (projects && !projects.has(workflow.projectPath ? ctx.projectKey(workflow.projectPath) : "")) return false;
      if (terms.length) {
        const text = ctx.searchText(record);
        const name = workflow.name?.toLowerCase() ?? "";
        for (const term of terms) {
          if (!text.includes(term) && !name.includes(term)) return false;
        }
      }
    }
    return true;
  };
}

/* ------------------------------------------------------------------ */
/* Facets                                                              */
/* ------------------------------------------------------------------ */

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/** Last path segment of a project folder, for display. */
export function projectName(projectPath: string): string {
  const api = /^[A-Za-z]:[\\/]|^\\\\/.test(projectPath) ? path.win32 : path.posix;
  return api.basename(projectPath) || projectPath;
}

/**
 * Counts for the filter rail, over live assets (trash only contributes its
 * own count; `unreadable` records nothing). `records` is in newest-first
 * order, so the first spelling seen of a model label or workflow name is the
 * most recent.
 */
export function computeFacets(records: Iterable<AssetRecord>, ctx: QueryContext): AssetFacets {
  const facets: AssetFacets = {
    total: 0,
    favorites: 0,
    trash: 0,
    missing: 0,
    kinds: emptyCounts(ASSET_KINDS),
    origins: emptyCounts(ASSET_ORIGINS),
    models: [],
    tags: [],
    workflows: [],
    projects: [],
  };
  const models = new Map<string, AssetFacets["models"][number]>();
  const tags = new Map<string, { tag: string; count: number }>();
  const workflows = new Map<string, AssetFacets["workflows"][number]>();
  const projects = new Map<string, AssetFacets["projects"][number]>();

  for (const record of records) {
    if (record.unreadable) continue;
    if (record.trashedAt !== undefined) {
      facets.trash++;
      continue;
    }
    facets.total++;
    if (record.favorite) facets.favorites++;
    if (ctx.isMissing(record.id)) facets.missing++;
    facets.kinds[record.kind]++;
    facets.origins[record.origin]++;

    if (record.model?.modelId) {
      const existing = models.get(record.model.modelId);
      if (existing) existing.count++;
      else {
        models.set(record.model.modelId, {
          modelId: record.model.modelId,
          label: record.model.displayName || record.model.modelId,
          provider: record.model.provider,
          count: 1,
        });
      }
    }
    for (const tag of record.tags) {
      const key = tag.toLowerCase();
      const existing = tags.get(key);
      if (existing) existing.count++;
      else tags.set(key, { tag, count: 1 });
    }
    const workflow = ctx.workflowOf(record);
    const entry = workflows.get(record.workflowId);
    if (entry) {
      entry.count++;
      if (record.createdAt > entry.lastAt) entry.lastAt = record.createdAt;
    } else {
      workflows.set(record.workflowId, {
        id: record.workflowId,
        name: workflow.name,
        projectPath: workflow.projectPath,
        count: 1,
        lastAt: record.createdAt,
      });
    }
    const projectKey = workflow.projectPath ? ctx.projectKey(workflow.projectPath) : "";
    const project = projects.get(projectKey);
    if (project) project.count++;
    else {
      projects.set(projectKey, {
        path: workflow.projectPath,
        name: workflow.projectPath ? projectName(workflow.projectPath) : "Not in a project",
        count: 1,
      });
    }
  }

  facets.models = [...models.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  facets.tags = [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  facets.workflows = [...workflows.values()].sort((a, b) => b.lastAt - a.lastAt);
  facets.projects = [...projects.values()].sort((a, b) => {
    if (a.path === null) return 1;
    if (b.path === null) return -1;
    return a.name.localeCompare(b.name);
  });
  return facets;
}
