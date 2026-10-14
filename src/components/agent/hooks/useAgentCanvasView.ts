"use client";

import { useCallback, useRef } from "react";
import { getViewportForBounds, useReactFlow, useStoreApi, type Rect } from "@xyflow/react";
import { getVisibleFlowRect, rectContains } from "@/lib/agent/client/layout";
import { useGpuCanvasBridge } from "@/components/gpuCanvas/bridge";
import type { AgentGraphOpBatch, AgentWorkflowSnapshot } from "@/lib/agent/types";

const FOCUS_DURATION_MS = 450;
const FOCUS_PADDING_PX = 72;
/** The classic canvas's minZoom, which its fitView keeps to. */
const FIT_MIN_ZOOM = 0.1;

/**
 * The agent's view of the canvas: the visible area it should build in (minus
 * the strip the agent window covers) and bringing its edits into view.
 */
export function useAgentCanvasView(occludedRight: number) {
  const reactFlow = useReactFlow();
  const storeApi = useStoreApi();
  const occludedRef = useRef(occludedRight);
  occludedRef.current = occludedRight;
  // The GPU canvas's React Flow holds only its live nodes: there the scene's graph and view stand in.
  const gpu = useGpuCanvasBridge();
  const gpuRef = useRef(gpu);
  gpuRef.current = gpu;

  const hasNode = useCallback(
    (id: string) => (gpuRef.current ? gpuRef.current.graph().indexOf.has(id) : !!reactFlow.getNode(id)),
    [reactFlow],
  );
  const allNodeIds = useCallback(
    () => (gpuRef.current ? gpuRef.current.graph().nodes : reactFlow.getNodes()).map((node) => node.id),
    [reactFlow],
  );
  const nodesBounds = useCallback(
    (ids: string[]): Rect => {
      const bridge = gpuRef.current;
      if (!bridge) return reactFlow.getNodesBounds(ids);
      const graph = bridge.graph();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of ids) {
        const i = graph.indexOf.get(id);
        if (i == null) continue;
        const n = graph.nodes[i];
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },
    [reactFlow],
  );

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

  /** Pan/zoom so these (existing) nodes fill the part of the pane the window leaves visible. */
  const fitNodes = useCallback(
    (ids: string[], maxZoom: number) => {
      const bridge = gpuRef.current;
      const paneWidth = bridge ? bridge.size().width : storeApi.getState().width;
      // On a narrow pane the window covers most of it; fit into the whole pane instead.
      const rightInset =
        paneWidth - occludedRef.current >= 240 ? occludedRef.current + FOCUS_PADDING_PX / 2 : FOCUS_PADDING_PX;
      const padding = {
        top: `${FOCUS_PADDING_PX}px`,
        bottom: `${FOCUS_PADDING_PX}px`,
        left: `${FOCUS_PADDING_PX}px`,
        right: `${rightInset}px`,
      } as const;
      if (bridge) {
        const { width, height } = bridge.size();
        if (!width || !height) return;
        bridge.animateView(getViewportForBounds(nodesBounds(ids), width, height, FIT_MIN_ZOOM, maxZoom, padding), FOCUS_DURATION_MS);
        return;
      }
      void reactFlow.fitView({ nodes: ids.map((id) => ({ id })), duration: FOCUS_DURATION_MS, maxZoom, padding });
    },
    [reactFlow, storeApi, nodesBounds],
  );

  /**
   * After a frame (so React Flow has the new nodes), pan/zoom to the nodes a
   * batch touched — unless they are already in view. A replaced canvas always
   * fits the whole new workflow.
   */
  const focusBatch = useCallback(
    (batch: AgentGraphOpBatch) => {
      requestAnimationFrame(() => {
        const candidates = batch.replacedCanvas ? allNodeIds() : (batch.focusNodeIds ?? []);
        const ids = candidates.filter(hasNode);
        if (ids.length === 0) return;

        const visible = getViewport();
        if (!batch.replacedCanvas && visible && rectContains(visible, nodesBounds(ids))) return;

        // Never zoom in past 100%, nor past where the user already was for a small edit.
        fitNodes(ids, batch.replacedCanvas ? 1 : Math.min(1, Math.max(gpuRef.current?.view().zoom ?? reactFlow.getZoom(), 0.1)));
      });
    },
    [reactFlow, getViewport, fitNodes, allNodeIds, hasNode, nodesBounds],
  );

  /**
   * Fit these nodes into view (the user asked to see them), up to 100%. Waits
   * two frames: after a tab switch or leaving the chat view, the tab's own
   * viewport is restored first, and React Flow fits only once it has measured
   * the nodes. Ids no longer on the canvas are ignored.
   */
  const focusNodes = useCallback(
    (nodeIds: readonly string[]) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const ids = nodeIds.filter(hasNode);
          if (ids.length > 0) fitNodes(ids, 1);
        }),
      );
    },
    [fitNodes, hasNode],
  );

  return { getViewport, focusBatch, focusNodes };
}
