import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A URL a <video> can play for each source, by source. A `data:` source is
 * turned into an object URL once (Chrome re-parses base64 on every seek
 * otherwise), revoked when the source leaves the list and on unmount;
 * `blob:`, `http(s)` and `/api/assets/…` sources play as they are. The list
 * version of useVideoBlobUrl's rules.
 */
export function usePlayableUrls(srcs: readonly string[]): ReadonlyMap<string, string> {
  const [converted, setConverted] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Object URLs this hook made, by source; the conversions in flight; the sources wanted now
  const owned = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const wanted = useRef(new Set<string>());
  // Keyed on the list's identity: joining whole data: URLs into a key would copy megabytes per render
  const unique = useMemo(() => [...new Set(srcs)], [srcs]);

  useEffect(() => {
    wanted.current = new Set(unique);
    let removed = false;
    for (const [src, url] of owned.current) {
      if (wanted.current.has(src)) continue;
      URL.revokeObjectURL(url);
      owned.current.delete(src);
      removed = true;
    }
    if (removed) setConverted(new Map(owned.current));
    for (const src of wanted.current) {
      if (!src.startsWith("data:") || owned.current.has(src) || pending.current.has(src)) continue;
      pending.current.add(src);
      fetch(src)
        .then((response) => response.blob())
        .then((blob) => {
          pending.current.delete(src);
          // It left the list (or the hook unmounted) while converting
          if (!wanted.current.has(src)) return;
          owned.current.set(src, URL.createObjectURL(blob));
          setConverted(new Map(owned.current));
        })
        .catch(() => {
          // The data URL itself still plays
          pending.current.delete(src);
        });
    }
  }, [unique]);

  useEffect(() => {
    const urls = owned.current;
    const wantedRef = wanted;
    return () => {
      wantedRef.current = new Set();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return useMemo(() => {
    const playable = new Map<string, string>();
    for (const src of unique) playable.set(src, converted.get(src) ?? src);
    return playable;
  }, [unique, converted]);
}
