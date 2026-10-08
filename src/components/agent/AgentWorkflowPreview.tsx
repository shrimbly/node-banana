"use client";

import { memo, useMemo } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { miniMapTypeColor } from "@/components/CanvasMinimap";
import { cn } from "@/components/agent/lib/utils";
import type { AgentGraphPreview } from "@/lib/agent/types";
import { useWorkflowStore } from "@/store/workflowStore";
import { AGENT_ICON } from "./AgentChrome";
import { useAgentTranscriptActions } from "./AgentSession";

const MAP_WIDTH = 300;
const MAP_HEIGHT = 150;
const MAP_PADDING = 14;
/** The canvas's card radius, scaled down with the map. */
const NODE_RADIUS = 14;

export interface GraphMap {
  nodes: Array<{ x: number; y: number; width: number; height: number; radius: number; color: string }>;
  /** One path per connection, out of the source's right edge into the target's left. */
  edges: string[];
}

/** The graph fitted into the map at the canvas's own proportions, centred. */
export function layoutGraphMap(graph: AgentGraphPreview, width = MAP_WIDTH, height = MAP_HEIGHT, padding = MAP_PADDING): GraphMap {
  const minX = Math.min(...graph.nodes.map(([, x]) => x));
  const minY = Math.min(...graph.nodes.map(([, , y]) => y));
  const maxX = Math.max(...graph.nodes.map(([, x, , w]) => x + w));
  const maxY = Math.max(...graph.nodes.map(([, , y, , h]) => y + h));
  const scale = Math.min((width - 2 * padding) / Math.max(maxX - minX, 1), (height - 2 * padding) / Math.max(maxY - minY, 1));
  const left = (width - (maxX - minX) * scale) / 2;
  const top = (height - (maxY - minY) * scale) / 2;
  const nodes = graph.nodes.map(([type, x, y, w, h]) => ({
    x: left + (x - minX) * scale,
    y: top + (y - minY) * scale,
    width: Math.max(w * scale, 1),
    height: Math.max(h * scale, 1),
    radius: Math.max(NODE_RADIUS * scale, 1.5),
    color: miniMapTypeColor(type),
  }));
  const edges = graph.edges.map(([source, target]) => {
    const from = nodes[source];
    const to = nodes[target];
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.max((x2 - x1) / 2, 6);
    const r = (n: number) => Math.round(n * 10) / 10;
    return `M${r(x1)} ${r(y1)}C${r(x1 + bend)} ${r(y1)} ${r(x2 - bend)} ${r(y2)} ${r(x2)} ${r(y2)}`;
  });
  return { nodes, edges };
}

/** The tab's name while it is open, and whether it still is. */
function useTabState(tabId: string | undefined): { open: boolean; name: string | null } {
  return useWorkflowStore(
    useShallow((state) => {
      if (!tabId) return { open: true, name: state.workflowName || null };
      const tab = state.tabs.find((entry) => entry.id === tabId);
      if (!tab) return { open: false, name: null };
      const name = tab.id === state.activeTabId ? state.workflowName : tab.snapshot?.workflowName;
      return { open: true, name: name || null };
    }),
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A workflow the agent built, as the canvas's minimap draws it: node blocks
 * in their type colours on the dot grid, with its name, its size and a way
 * into the canvas beside it. The full-page chat's, under the build call.
 */
export const AgentWorkflowPreview = memo(function AgentWorkflowPreview({
  tabId,
  graph,
}: {
  tabId?: string;
  graph: AgentGraphPreview;
}) {
  const transcript = useAgentTranscriptActions();
  const tab = useTabState(tabId);
  const map = useMemo(() => layoutGraphMap(graph), [graph]);
  const name = tab.name ?? graph.name ?? "Untitled workflow";
  const canOpen = !!transcript && tab.open;
  const open = () => transcript?.showOnCanvas({ ...(tabId ? { tabId } : {}), all: true });

  return (
    <div
      role="group"
      aria-label={name}
      data-workflow-preview=""
      className="flex flex-wrap items-center gap-x-4 gap-y-2 animate-in fade-in-0 duration-300 motion-reduce:animate-none"
    >
      {/* The map opens it too, for the pointer; the link is the one stop for the keyboard. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!canOpen}
        onClick={open}
        className={cn(
          "flex shrink-0 overflow-hidden rounded-[10px] bg-[#131313] bg-[length:16px_16px] bg-[radial-gradient(circle,#2a2a2a_0.9px,transparent_1.1px)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]",
          canOpen ? "cursor-pointer transition-shadow duration-[120ms] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)]" : "cursor-default",
        )}
      >
        <svg width={MAP_WIDTH} height={MAP_HEIGHT} viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} fill="none" aria-hidden="true">
          {map.edges.map((d, index) => (
            <path key={index} d={d} stroke="#ffffff" strokeOpacity={0.14} strokeWidth={1} />
          ))}
          {map.nodes.map((node, index) => (
            <rect
              key={index}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={node.radius}
              fill={node.color}
              fillOpacity={0.82}
            />
          ))}
        </svg>
      </button>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate font-medium text-[13px] text-neutral-200 leading-[18px]">{name}</span>
        <span className="text-neutral-500 text-xs leading-4">
          {plural(graph.nodes.length, "node")} · {plural(graph.edges.length, "connection")}
        </span>
        {canOpen ? (
          <button
            type="button"
            onClick={open}
            className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-sm text-neutral-400 text-xs leading-4 outline-none transition-colors duration-[120ms] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-selection"
          >
            Open in canvas
            <ArrowUpRightIcon {...AGENT_ICON} className="size-3" />
          </button>
        ) : transcript ? (
          <span className="mt-1.5 text-neutral-600 text-xs leading-4">No longer open</span>
        ) : null}
      </div>
    </div>
  );
});
