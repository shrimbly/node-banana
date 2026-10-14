"use client";

import { useCallback, useEffect, useRef } from "react";
import { agentTouchedNodeIds } from "@/lib/agent/client/highlights";
import { gpuCanvasBridge, shownNodeElement } from "@/components/gpuCanvas/bridge";
import type { AgentGraphOpBatch } from "@/lib/agent/types";

/** One pass of the sweep (agent-theme.css, 1.4s, held at its faded end), then the mark comes off. */
const SHIMMER_MS = 1600;
const ATTRIBUTE = "data-agent-shimmer";

/**
 * Shimmers the nodes the agent just changed, so its edits are easy to spot.
 * The mark is an attribute on React Flow's node element, set straight on the
 * DOM: it belongs to the moment, never to node data (which is saved).
 *
 * The GPU canvas draws most nodes as pictures: the nodes in view are held
 * live (real elements) for the sweep, and marked once they have swapped in.
 */
export function useAgentShimmer() {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const holds = useRef(new Set<() => void>());

  useEffect(() => {
    const pending = timers.current;
    const held = holds.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const release of held) release();
      held.clear();
    };
  }, []);

  return useCallback((batch: AgentGraphOpBatch) => {
    const ids = agentTouchedNodeIds(batch);
    if (ids.length === 0) return;
    const mark = () => {
      for (const id of ids) {
        const element = shownNodeElement(id);
        if (!element) continue;
        // Restart the sweep when the same node changes again mid-shimmer.
        element.removeAttribute(ATTRIBUTE);
        void element.offsetWidth;
        element.setAttribute(ATTRIBUTE, "");
        const previous = timers.current.get(id);
        if (previous) clearTimeout(previous);
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            element.removeAttribute(ATTRIBUTE);
          }, SHIMMER_MS),
        );
      }
    };
    // After a frame, so React Flow has mounted the nodes the batch added (and the GPU canvas has them in its graph).
    requestAnimationFrame(() => {
      const bridge = gpuCanvasBridge();
      if (!bridge) return mark();
      const hold = bridge.holdLive(ids);
      const release = () => {
        holds.current.delete(release);
        hold.release();
      };
      holds.current.add(release);
      void hold.ready.then(() => {
        if (!holds.current.has(release)) return;
        mark();
        setTimeout(release, SHIMMER_MS);
      });
    });
  }, []);
}
