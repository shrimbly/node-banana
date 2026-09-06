"use client";

import { useRef } from "react";
import { EdgeLabelRenderer, useReactFlow, useViewport } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { MenuSurface, MenuIconButton, MenuBarLabel } from "@/components/ui/Menu";
import { bundleClampStyle } from "./BundleClamp";

export function HookBundleClamp({ bundle, members, selected }: {
  bundle: { id: string; x: number; y: number }; members: string[]; selected: boolean; color: string;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const { zoom } = useViewport();
  const drag = useRef<{ x: number; y: number; moved: boolean; start: { x: number; y: number } } | null>(null);
  const select = () => {
    const store = useWorkflowStore.getState();
    useWorkflowStore.setState({ activeHookBundleId: bundle.id });
    store.onNodesChange(store.nodes.filter((n) => n.selected).map((n) => ({ type: "select", id: n.id, selected: false })));
    store.onEdgesChange(store.edges.map((e) => ({ type: "select", id: e.id, selected: members.includes(e.id) })));
  };
  return (
    <EdgeLabelRenderer>
      <div className="nodrag nopan nokey" style={{ position: "absolute", transform: `translate(${bundle.x}px, ${bundle.y}px)`, pointerEvents: "all", zIndex: 2100 }}
        onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {selected && (
          <MenuSurface variant="bar" floating={false} className="absolute w-max"
            style={{ transform: `translate(-50%, calc(-100% - 20px)) scale(${1 / zoom})`, transformOrigin: "bottom center" }}
            onPointerDown={(e) => e.stopPropagation()}>
            <MenuBarLabel>{members.length} connections</MenuBarLabel>
            <MenuIconButton title="Remove bundle" onClick={() => useWorkflowStore.getState().removeHookBundle(bundle.id)}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <path d="M2 8h3.5c2 0 2-4 4-4H14M9.5 8H14M5.5 8c2 0 2 4 4 4H14" />
              </svg>
            </MenuIconButton>
            <MenuIconButton title={`Delete ${members.length} connections`} className="hover:text-red-400" onClick={() => useWorkflowStore.getState().removeEdges(members)}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
              </svg>
            </MenuIconButton>
          </MenuSurface>
        )}
        <button type="button" title={`${members.length} connections · drag bundle`} aria-label={`Bundle of ${members.length} connections`}
          data-testid="hook-bundle-clamp"
          style={{ ...bundleClampStyle, position: "absolute", transform: "translate(-50%, -50%)", cursor: "move", touchAction: "none" }}
          onClick={select}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { ...bundle, moved: false, start: screenToFlowPosition({ x: e.clientX, y: e.clientY }) };
            select();
          }}
          onPointerMove={(e) => {
            const start = drag.current;
            if (!start) return;
            const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            useWorkflowStore.getState().moveHookBundle(bundle.id, { x: start.x + point.x - start.start.x, y: start.y + point.y - start.start.y }, !start.moved);
            start.moved = true;
          }}
          onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        />
      </div>
    </EdgeLabelRenderer>
  );
}
