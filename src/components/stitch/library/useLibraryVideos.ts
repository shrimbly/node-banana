import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAssetPage } from "@/lib/assets/client/api";
import type { AssetKind, AssetPageRequest, AssetView } from "@/lib/assets/types";
import { buildLibraryRequest, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";

/** The Assets view's own search delay. */
const SEARCH_DEBOUNCE_MS = 200;

interface Listing {
  /** The request these pages answer. */
  key: string;
  assets: AssetView[];
  total: number;
  cursor: string | null;
  done: boolean;
  /** The first page failed: nothing to show but this. */
  error: string | null;
  /** A next page failed: the list so far stays, the cursor too, for Try again. */
  moreError: string | null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The library could not be read.";
}

const VIDEO: readonly AssetKind[] = ["video"];

/**
 * The library's videos (or the kinds asked for: audio for the audio picker) for the picker, a page at a time, in the picker's own
 * state (never the Assets view's store, whose list and filters it would
 * change). The search waits 200 ms after the last key; the toggles ask at
 * once. Each query has its own request: a newer one aborts the older, and an
 * answer to a query that is no longer current is dropped. loadMore follows
 * the cursor until a page adds nothing, and never while the current query's
 * first page is still out (its answer starts the list again), so a next page
 * only ever continues the list it was asked from. A next page that fails keeps the
 * list and its cursor and says so (moreError); loadMore asks again. A first
 * page that fails says so (error); retry asks for it again.
 */
export function useLibraryVideos(
  query: LibraryVideoQuery,
  workflowId: string | null,
  enabled = true,
  kinds: readonly AssetKind[] = VIDEO,
): {
  assets: AssetView[];
  total: number;
  /** The current query's first page has not come back yet (the previous query's videos are still given). */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** The next page could not be read; loadMore tries it again. */
  moreError: string | null;
  /** Another page can be asked for by scrolling (not while a failed one waits for Try again). */
  hasMore: boolean;
  loadMore(): void;
  /** Asks again for a first page that failed. */
  retry(): void;
  /** The query whose list is shown: it changes when a new query's first page lands, not for a next page. */
  listingKey: string | null;
} {
  const [searchText, setSearchText] = useState(query.q);
  useEffect(() => {
    if (query.q === searchText) return;
    const timer = setTimeout(() => setSearchText(query.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query.q, searchText]);

  const q = searchText.trim();
  const { project, favourites, thisWorkflow, sort } = query;
  const key = JSON.stringify(buildLibraryRequest({ q, project, favourites, thisWorkflow, sort }, workflowId, undefined, kinds));
  // One request per distinct query: a change that leaves it as it was (the workflow's id while This workflow is
  // off) asks nothing again
  const request = useMemo(() => JSON.parse(key) as AssetPageRequest, [key]);

  const [listing, setListing] = useState<Listing | null>(null);
  /** Bumped per query, so an answer to an older one is dropped even when its request ignored the abort. */
  const sequence = useRef(0);
  const more = useRef<AbortController | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  /** The sequence id of the first page still out, if any: no next page is asked for meanwhile. */
  const firstPending = useRef<number | null>(null);
  /** Bumped by retry: the same query's first page is asked for again. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = ++sequence.current;
    firstPending.current = id;
    more.current?.abort();
    more.current = null;
    const controller = new AbortController();
    // The first page's answer starts the list again: nothing asked from the list before it is kept
    const settle = () => {
      firstPending.current = null;
      more.current?.abort();
      more.current = null;
      setMoreLoading(false);
    };
    fetchAssetPage(request, controller.signal).then(
      (page) => {
        if (sequence.current !== id) return;
        settle();
        setListing({
          key,
          assets: page.assets,
          total: page.total,
          cursor: page.nextCursor,
          done: !page.nextCursor || page.assets.length === 0,
          error: null,
          moreError: null,
        });
      },
      (error: unknown) => {
        if (sequence.current !== id || isAbort(error)) return;
        settle();
        setListing({ key, assets: [], total: 0, cursor: null, done: true, error: message(error), moreError: null });
      },
    );
    return () => {
      controller.abort();
      if (firstPending.current === id) firstPending.current = null;
    };
  }, [enabled, request, key, attempt]);

  const current = listing?.key === key ? listing : null;

  const loadMore = useCallback(() => {
    if (!current || current.done || !current.cursor || more.current || firstPending.current !== null) return;
    const id = sequence.current;
    const cursor = current.cursor;
    const controller = new AbortController();
    more.current = controller;
    setMoreLoading(true);
    if (current.moreError) setListing((prev) => (prev && prev.key === key ? { ...prev, moreError: null } : prev));
    fetchAssetPage({ ...request, cursor }, controller.signal).then(
      (page) => {
        if (sequence.current !== id) return;
        more.current = null;
        setMoreLoading(false);
        setListing((prev) => {
          // Only a page that continues the list it was asked from
          if (!prev || prev.key !== key || prev.cursor !== cursor) return prev;
          const seen = new Set(prev.assets.map((a) => a.id));
          const added = page.assets.filter((a) => !seen.has(a.id));
          // A page that adds nothing on the same cursor is the end
          const done = !page.nextCursor || (added.length === 0 && page.nextCursor === cursor);
          return {
            ...prev,
            assets: [...prev.assets, ...added],
            total: page.total,
            cursor: page.nextCursor,
            done,
            moreError: null,
          };
        });
      },
      (error: unknown) => {
        if (sequence.current !== id || isAbort(error)) return;
        more.current = null;
        setMoreLoading(false);
        // Not the end of the list: the cursor stays for Try again (never asked again by itself, so a library
        // that keeps failing is not asked in a loop)
        setListing((prev) =>
          prev && prev.key === key && prev.cursor === cursor ? { ...prev, moreError: message(error) } : prev,
        );
      },
    );
  }, [current, request, key]);

  const retry = useCallback(() => {
    // The failed list goes, so the spinner shows while it is asked for again
    setListing((prev) => (prev && prev.key === key && prev.error ? null : prev));
    setAttempt((n) => n + 1);
  }, [key]);

  // Nothing in flight outlives the picker
  useEffect(
    () => () => {
      sequence.current++;
      more.current?.abort();
    },
    [],
  );

  return {
    assets: current?.assets ?? listing?.assets ?? [],
    total: current?.total ?? 0,
    loading: enabled && current === null,
    loadingMore: moreLoading,
    error: current?.error ?? null,
    moreError: current?.moreError ?? null,
    hasMore: current !== null && !current.done && current.moreError === null,
    loadMore,
    retry,
    listingKey: listing?.key ?? null,
  };
}
