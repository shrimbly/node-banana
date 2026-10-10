"use client";

import { memo, useMemo } from "react";
import { useStore, type Node } from "@xyflow/react";
import { ViewportPortal } from "@/components/flowPortals";
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
        // Generate nodes say "connect inputs and run" in their own body, so
        // their header carries no hint; the others have nowhere else to say it
        const hint = GENERATE_TYPES.has(node.type as string) ? undefined : hints?.[node.id];
        return <NodeHeader key={`header-${node.id}`} node={node} hint={hint} {...actions} />;
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
  const type = node.type ?? "";
  const canBrowse = GENERATE_TYPES.has(type);
  const canFallback = GENERATE_TYPES.has(type) || type === "llmGenerate";
  const canToggleOptional = INPUT_TYPES.has(type);

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
      onBrowse={canBrowse ? onBrowse : undefined}
      canFallback={canFallback}
      fallbackName={data?.fallbackModel?.displayName}
      onOpenFallback={onOpenFallback}
      canToggleOptional={canToggleOptional}
      isOptional={!!data?.isOptional}
      onToggleOptional={onToggleOptional}
      hint={hint}
      onCustomTitleChange={onCustomTitleChange}
      onCommentChange={onCommentChange}
      onRunNode={onRunNode}
      onExpandNode={onExpandNode}
    />
  );
});
