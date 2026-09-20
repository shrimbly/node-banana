"use client";

import { useEffect, type RefObject } from "react";
import { useStoreApi } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { pathIntersectsRect, sampleEdgePaths } from "@/lib/edges/marquee";

/** React Flow owns the marquee and node hit testing; we add curve hit testing. */
export function EdgeMarqueeSelection({ canvas, disabled }: { canvas: RefObject<HTMLDivElement | null>; disabled: boolean }) {
  const flow = useStoreApi();
  useEffect(() => {
    if (disabled) return;
    let paths: ReturnType<typeof sampleEdgePaths> | null = null;
    return flow.subscribe((state, previous) => {
      const rect = state.userSelectionRect;
      if (!rect) { paths = null; return; }
      if (!state.userSelectionActive || rect === previous.userSelectionRect || !canvas.current) return;
      const store = useWorkflowStore.getState();
      if (!paths) paths = sampleEdgePaths(canvas.current, new Set(store.edges.filter((e) => !e.hidden && !e.data?.hidden && e.selectable !== false && e.type !== "reference").map((e) => e.id)));
      const bounds = state.domNode?.getBoundingClientRect();
      if (!bounds) return;
      const selected = store.nodes.some((n) => n.selected) ? new Set<string>() : new Set(paths.filter((p) => pathIntersectsRect(p.points, {
        x: bounds.left + rect.x, y: bounds.top + rect.y, width: rect.width, height: rect.height,
      })).map((p) => p.id));
      const changes = store.edges.filter((e) => Boolean(e.selected) !== selected.has(e.id)).map((e) => ({ type: "select" as const, id: e.id, selected: selected.has(e.id) }));
      if (changes.length) store.onEdgesChange(changes);
    });
  }, [canvas, disabled, flow]);
  return null;
}
