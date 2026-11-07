import { useCallback, useEffect, useSyncExternalStore } from "react";
import { mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { getWaveform, requestWaveform, subscribeWaveform, type StitchWaveform } from "@/lib/stitch/waveformCache";

/**
 * The music's waveform from the shared cache, asked for while mounted; null with no source. Each change in the
 * cache is a new waveform object, so it is its own snapshot.
 */
export function useStitchWaveform(src: string | null): StitchWaveform | null {
  const key = src ? mediaKeyOf(src) : null;
  const snapshot = useCallback(() => (key ? (getWaveform(key) ?? null) : null), [key]);
  const waveform = useSyncExternalStore(subscribeWaveform, snapshot, snapshot);
  useEffect(() => {
    if (key && src) requestWaveform(key, src);
    // The key is the source's identity: a new string with the same content asks for nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return waveform;
}
