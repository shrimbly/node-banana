/**
 * The tutorial's search for a ringed element on the GPU canvas, where only live nodes are real elements.
 * When no element matches and the painter's sheet holds no copy (the node was painted in an earlier batch or
 * came from the disk cache), each node of the graph is held live once to look inside it: one that holds a match
 * stays held while the step lasts, the rest are let go. A node held while out of view (holdLive skips it) is
 * tried again later. Classic never gets here: every node is mounted there.
 */
import type { GpuCanvasBridge } from "@/components/gpuCanvas/bridge";

/** How long a probed node may take to turn live before it is let go and tried again (off screen, say). */
export const PROBE_TIMEOUT_MS = 3000;

export interface LiveProbe {
  /**
   * `missing`: the selectors nothing on the page matches. Holds the nodes still to be looked inside, keeps those
   * that turned out to hold a match of `selectors`, and lets the others go. `onReady` runs once probed nodes swapped in.
   */
  update(bridge: GpuCanvasBridge, selectors: readonly string[], missing: readonly string[], onReady: () => void, now?: number): void;
  /** Whether the node is held for holding a match. */
  holds(id: string): boolean;
  dispose(): void;
}

export function createLiveProbe(shown: (id: string) => Element | null): LiveProbe {
  const kept = new Map<string, () => void>();
  const probing = new Map<string, { release: () => void; at: number }>();
  const checked = new Set<string>();
  const matches = (element: Element, selectors: readonly string[]) =>
    selectors.some((selector) => element.matches(selector) || !!element.querySelector(selector));

  return {
    update(bridge, selectors, missing, onReady, now = performance.now()) {
      // Look inside the nodes that have turned live.
      for (const [id, probe] of probing) {
        const element = shown(id);
        if (element) {
          probing.delete(id);
          if (matches(element, selectors)) kept.set(id, probe.release);
          else {
            probe.release();
            checked.add(id);
          }
        } else if (now - probe.at > PROBE_TIMEOUT_MS) {
          probing.delete(id);
          probe.release();
        }
      }
      if (!missing.length) return;
      const ids = bridge.graph().nodes.map((n) => n.id).filter((id) => !kept.has(id) && !probing.has(id) && !checked.has(id) && !shown(id));
      if (!ids.length) return;
      const holds = ids.map((id) => {
        const hold = bridge.holdLive([id]);
        probing.set(id, { release: hold.release, at: now });
        return hold.ready;
      });
      void Promise.all(holds).then(onReady);
    },
    holds: (id) => kept.has(id),
    dispose() {
      for (const release of kept.values()) release();
      for (const probe of probing.values()) probe.release();
      kept.clear();
      probing.clear();
      checked.clear();
    },
  };
}
