"use client";

import { useCallback, useRef } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { getVisibleFlowRect, rectContains } from "@/lib/agent/client/layout";
import type { AgentGraphOpBatch, AgentWorkflowSnapshot } from "@/lib/agent/types";

const FOCUS_DURATION_MS = 450;
const FOCUS_PADDING_PX = 72;

/**
 * The agent's view of the canvas: the visible area it should build in (minus
 * the strip the agent window covers) and bringing its edits into view.
 */
export function useAgentCanvasView(occludedRight: number) {
  const reactFlow = useReactFlow();
  const storeApi = useStoreApi();
  const occludedRef = useRef(occludedRight);
  occludedRef.current = occludedRight;

  const getViewport = useCallback((): AgentWorkflowSnapshot["viewport"] => {
    const { transform, width, height } = storeApi.getState();
    if (!width || !height) return undefined;
    return getVisibleFlowRect({
      transform,
      paneWidth: width,
      paneHeight: height,
      occludedRight: occludedRef.current,
    });
  }, [storeApi]);

  /**
   * After a frame (so React Flow has the new nodes), pan/zoom to the nodes a
   * batch touched — unless they are already in view. A replaced canvas always
   * fits the whole new workflow.
   */
  const focusBatch = useCallback(
    (batch: AgentGraphOpBatch) => {
      requestAnimationFrame(() => {
        const candidates = batch.replacedCanvas
          ? reactFlow.getNodes().map((node) => node.id)
          : (batch.focusNodeIds ?? []);
        const ids = candidates.filter((id) => reactFlow.getNode(id));
        if (ids.length === 0) return;

        const visible = getViewport();
        if (!batch.replacedCanvas && visible && rectContains(visible, reactFlow.getNodesBounds(ids))) return;

        const zoom = reactFlow.getZoom();
        const paneWidth = storeApi.getState().width;
        // On a narrow pane the window covers most of it; fit into the whole pane instead.
        const rightInset =
          paneWidth - occludedRef.current >= 240 ? occludedRef.current + FOCUS_PADDING_PX / 2 : FOCUS_PADDING_PX;
        void reactFlow.fitView({
          nodes: ids.map((id) => ({ id })),
          duration: FOCUS_DURATION_MS,
          // Never zoom in past 100%, nor past where the user already was for a small edit.
          maxZoom: batch.replacedCanvas ? 1 : Math.min(1, Math.max(zoom, 0.1)),
          padding: {
            top: `${FOCUS_PADDING_PX}px`,
            bottom: `${FOCUS_PADDING_PX}px`,
            left: `${FOCUS_PADDING_PX}px`,
            right: `${rightInset}px`,
          },
        });
      });
    },
    [reactFlow, storeApi, getViewport],
  );

  return { getViewport, focusBatch };
}
