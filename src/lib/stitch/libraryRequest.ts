import type { AssetKind, AssetPageRequest, AssetSort } from "@/lib/assets/types";

/**
 * The Stitch editor's Add media query, and the asset page request
 * it becomes. Pure: the picker's hook sends what this builds.
 */

export interface LibraryVideoQuery {
  q: string;
  /** null = all projects; "" = not in a project; otherwise the project's folder. */
  project: string | null;
  favourites: boolean;
  thisWorkflow: boolean;
  sort: AssetSort;
}

/** Which kinds a library list holds: both (the Edit video view's Add media), or one (a + on the timeline). */
export type LibraryKind = "all" | "video" | "audio";

const KINDS: Record<LibraryKind, readonly AssetKind[]> = { all: ["video", "audio"], video: ["video"], audio: ["audio"] };

/** The asset kinds a LibraryKind asks for. */
export function libraryKinds(kind: LibraryKind): readonly AssetKind[] {
  return KINDS[kind];
}

export const LIBRARY_PAGE_SIZE = 60;

export const DEFAULT_LIBRARY_QUERY: LibraryVideoQuery = {
  q: "",
  project: null,
  favourites: false,
  thisWorkflow: false,
  sort: "newest",
};

/**
 * One kind of asset (videos unless `kinds` says otherwise), a page at a time. Every other field is sent only when it
 * narrows the list: a search with something in it, Favourites, a project,
 * This workflow when the canvas has an id (nothing was ever recorded from one
 * without), and the sort when it is not the default newest first.
 */
export function buildLibraryRequest(
  query: LibraryVideoQuery,
  workflowId: string | null,
  cursor?: string,
  kinds: readonly AssetKind[] = ["video"],
): AssetPageRequest {
  const request: AssetPageRequest = { kinds: [...kinds], limit: LIBRARY_PAGE_SIZE };
  const q = query.q.trim();
  if (q) request.q = q;
  if (query.favourites) request.favorite = true;
  if (query.project !== null) request.projects = [query.project];
  if (query.thisWorkflow && workflowId) request.workflowIds = [workflowId];
  if (query.sort === "oldest") request.sort = "oldest";
  if (cursor) request.cursor = cursor;
  return request;
}
