import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  getAssetInfo,
  getAssetInfoVersion,
  requestAssetInfo,
  subscribeAssetInfo,
} from "@/lib/stitch/assetInfo";
import type { AssetView } from "@/lib/assets/types";

/**
 * The library's records for a Stitch timeline's asset clips, from the shared
 * cache, asked for while mounted: a record, null for one the library no
 * longer has, undefined while it is being read. The ids there are when it
 * mounts are read again once (an editor being opened), so an asset deleted
 * or brought back since the last read shows as it is now; ids added later
 * (a picked clip, whose record the picker primed) are read only if unknown.
 */
export function useStitchAssetInfo(ids: readonly string[]): ReadonlyMap<string, AssetView | null | undefined> {
  const key = [...new Set(ids)].join("\n");
  const version = useSyncExternalStore(subscribeAssetInfo, getAssetInfoVersion, getAssetInfoVersion);
  const refreshed = useRef(false);
  useEffect(() => {
    // The mount's refresh is spent on the first run even with no ids, so an editor opened without library clips
    // does not read its first picks again
    const refresh = !refreshed.current;
    refreshed.current = true;
    if (!key) return;
    requestAssetInfo(key.split("\n"), { refresh });
  }, [key]);
  return useMemo(
    () => new Map(key ? key.split("\n").map((id) => [id, getAssetInfo(id)] as const) : []),
    // version: the cache changed, so read it again
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, version],
  );
}
