import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  getMediaInfo,
  getMediaInfoVersion,
  requestMediaInfo,
  retainMediaInfo,
  subscribeMediaInfo,
  type MediaInfoLevel,
  type StitchMediaInfo,
} from "@/lib/stitch/mediaInfo";

/** One source to read; `level` overrides the hook's own for this entry. */
export interface StitchMediaEntry {
  key: string;
  src: string;
  level?: MediaInfoLevel;
}

/**
 * The media info of each entry, from the shared Stitch cache. While mounted it
 * retains the entries' keys (so their frames are never revoked under it) and
 * asks for each at its level. Keys are content identities, so the request runs
 * again only when the set of keys or a level changes, not when the order does.
 */
export function useStitchMediaInfo(
  entries: ReadonlyArray<StitchMediaEntry>,
  level: MediaInfoLevel,
): ReadonlyMap<string, StitchMediaInfo> {
  const version = useSyncExternalStore(subscribeMediaInfo, getMediaInfoVersion, getMediaInfoVersion);
  // The set of keys, each with its level: the order of the entries does not matter
  const requests = [...new Set(entries.map((e) => `${e.key}\t${e.level ?? level}`))].sort().join("\n");

  // The latest entries, read by the request effect, which runs on a change of that set only
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
  });

  // The keys retained now. A new set is retained before the old one is let
  // go, so a key in both is never unretained in between (and so never evicted
  // while its tile shows it)
  const held = useRef<(() => void) | null>(null);
  useEffect(() => {
    const current = latest.current;
    const release = retainMediaInfo(current.map((e) => e.key));
    for (const entry of current) requestMediaInfo(entry.key, entry.src, entry.level ?? level);
    const previous = held.current;
    held.current = release;
    previous?.();
  }, [requests, level]);
  // On unmount, let go a microtask later: StrictMode's remount retains the
  // same keys again first, so they are never unretained in between either
  useEffect(
    () => () => {
      const release = held.current;
      held.current = null;
      if (release) queueMicrotask(release);
    },
    [],
  );

  const keys = entries.map((e) => e.key).join("\n");
  return useMemo(() => {
    const infos = new Map<string, StitchMediaInfo>();
    for (const key of keys ? keys.split("\n") : []) {
      const info = getMediaInfo(key);
      if (info) infos.set(key, info);
    }
    return infos;
    // version: the cache changed, so read it again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, version]);
}
