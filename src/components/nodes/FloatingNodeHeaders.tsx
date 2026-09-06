"use client";

import { memo, useMemo } from "react";
import { ViewportPortal, useStore, type Node } from "@xyflow/react";
import { FloatingNodeHeader } from "./FloatingNodeHeader";
import { selectMountedArea } from "./nodeCulling";
import { ComfyWordmark } from "../icons/ComfyWordmark";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import type { NodeType } from "@/types";

interface HeaderActions {
  getNodeTitle: (node: Node) => string;
  onCustomTitleChange: (nodeId: string, title: string) => void;
  onCommentChange: (nodeId: string, comment: string) => void;
  onRunNode: (nodeId: string) => void;
  onExpandNode: (nodeId: string, nodeType: string) => void;
  onBrowse: (nodeId: string) => void;
  onToggleOptional: (nodeId: string, isOptional: boolean) => void;
  onOpenFallback: (nodeId: string, nodeType: string) => void;
}

export interface FloatingNodeHeadersProps extends HeaderActions {
  nodes: Node[];
  /** Short hint per node id for nodes that cannot run as wired ("needs a prompt"). */
  hints?: Record<string, string>;
}

/** Room above a node for its header, in flow units. */
const HEADER_REACH = 48;

const GENERATE_TYPES = new Set(["nanoBanana", "generateVideo", "generate3d", "generateAudio"]);
const INPUT_TYPES = new Set(["imageInput", "audioInput", "prompt"]);

/**
 * The floating headers for every node on the canvas. Each one is its own
 * memoised element, so a drag frame re-renders the dragged node's header and
 * compares the rest, and headers outside the mounted area (the same area
 * that keeps nodes rendered, see nodeCulling.ts) are not mounted at all. A
 * selected node keeps its header wherever it is.
 */
export const FloatingNodeHeaders = memo(function FloatingNodeHeaders({ nodes, hints, ...actions }: FloatingNodeHeadersProps) {
  const area = useStore(selectMountedArea);
  const [minX, minY, maxX, maxY] = useMemo(() => area.split(" ").map(Number), [area]);

  return (
    <ViewportPortal>
      {nodes.map((node) => {
        // Groups don't get floating headers
        if ((node.type as string) === "group") return null;
        const width = headerWidth(node);
        const height = node.measured?.height ?? 0;
        const inView =
          node.position.x + width >= minX &&
          node.position.x <= maxX &&
          node.position.y + height >= minY &&
          node.position.y - HEADER_REACH <= maxY;
        if (!inView && !node.selected) return null;
        return <NodeHeader key={`header-${node.id}`} node={node} hint={hints?.[node.id]} {...actions} />;
      })}
    </ViewportPortal>
  );
});

function headerWidth(node: Node): number {
  const defaultWidth = defaultNodeDimensions[node.type as NodeType]?.width ?? 250;
  return node.measured?.width || (node.style?.width as number) || defaultWidth;
}

interface NodeHeaderProps extends HeaderActions {
  node: Node;
  hint?: string;
}

const NodeHeader = memo(function NodeHeader({
  node,
  hint,
  getNodeTitle,
  onCustomTitleChange,
  onCommentChange,
  onRunNode,
  onExpandNode,
  onBrowse,
  onToggleOptional,
  onOpenFallback,
}: NodeHeaderProps) {
  const data = node.data as any;

  // Browse button for generate nodes
  const browseAction = GENERATE_TYPES.has(node.type ?? "") ? (
    <button
      onClick={() => onBrowse(node.id)}
      className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
    >
      Browse
    </button>
  ) : undefined;

  // Optional toggle for input nodes
  const isOptional = !!data?.isOptional;
  const optionalToggle = INPUT_TYPES.has(node.type ?? "") ? (
    <button
      onClick={() => onToggleOptional(node.id, !isOptional)}
      className={`nodrag nopan text-[10px] py-0.5 px-1.5 rounded transition-colors ${
        isOptional
          ? "bg-amber-600/80 hover:bg-amber-500/80 text-white border border-amber-500/50"
          : "bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 text-neutral-400"
      }`}
      title={isOptional ? "This input is optional — empty inputs will be skipped" : "Mark as optional — empty inputs will skip this branch"}
    >
      {isOptional ? "Optional" : "Required"}
    </button>
  ) : undefined;

  // Fallback shield button for generation nodes
  const isGenerationNode = GENERATE_TYPES.has(node.type ?? "") || node.type === "llmGenerate";
  const hasFallback = !!data?.fallbackModel;
  const fallbackName = data?.fallbackModel?.displayName;
  const fallbackButton = isGenerationNode ? (
    <div className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpenFallback(node.id, node.type ?? "");
        }}
        className={`nodrag nopan p-0.5 rounded transition-colors border flex items-center ${
          hasFallback
            ? "text-blue-400 border-blue-600/60 hover:text-blue-200"
            : "text-neutral-500 border-neutral-600 hover:text-neutral-200"
        }`}
        title={hasFallback ? `Fallback: ${fallbackName}` : "Set fallback model (runs if primary fails)"}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0 1 16 0M12 4v8M8 12Q9 7 12 4M16 12Q15 7 12 4M4 12l8 8M20 12l-8 8M11 20h2" />
        </svg>
      </button>
      {hasFallback && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400 ring-1 ring-neutral-900 pointer-events-none" />
      )}
    </div>
  ) : undefined;

  return (
    <FloatingNodeHeader
      id={node.id}
      type={node.type as NodeType}
      isInLockedGroup={!!data?.isInLockedGroup}
      isExecuting={!!data?.isExecuting}
      focusedCommentNodeId={data?.focusedCommentNodeId}
      position={node.position}
      width={headerWidth(node)}
      selected={!!node.selected}
      title={getNodeTitle(node)}
      titleLogo={node.type === "comfyApp" ? <ComfyWordmark className="h-3 w-auto shrink-0" /> : undefined}
      customTitle={data?.customTitle}
      comment={data?.comment}
      provider={data?.selectedModel?.provider}
      headerAction={
        browseAction || fallbackButton ? (
          <>
            {browseAction}
            {fallbackButton}
          </>
        ) : undefined
      }
      headerButtons={optionalToggle}
      alwaysVisibleButtons={
        hint ? (
          <span
            data-testid="node-readiness-hint"
            title={`${hint}: this node will be skipped when the workflow runs`}
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] leading-4 text-amber-200/90 whitespace-nowrap"
          >
            {hint}
          </span>
        ) : undefined
      }
      onCustomTitleChange={onCustomTitleChange}
      onCommentChange={onCommentChange}
      onRunNode={onRunNode}
      onExpandNode={onExpandNode}
    />
  );
});
