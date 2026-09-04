"use client";

import { ReactNode } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { CARD_EDGE } from "@/utils/nodeDimensions";
import { NodeShell } from "./NodeShell";
import { cn } from "./ui/cn";

interface BaseNodeProps {
  id: string;
  children: ReactNode;
  selected?: boolean;
  isExecuting?: boolean;
  hasError?: boolean;
  className?: string;
  contentClassName?: string;
  minWidth?: number;
  minHeight?: number;
  /** Ignored: every node is now full-bleed inside its media card. */
  fullBleed?: boolean;
  /** Ignored: height is derived from width, there is no aspect-fit gesture. */
  aspectFitMedia?: string | null;
  settingsExpanded?: boolean;
  /** Rendered as the node's controls card. */
  settingsPanel?: ReactNode;
  dataTutorial?: string;
}

/**
 * Transitional adapter: the pre-redesign node API on top of NodeShell, so a
 * node that has not been converted yet still renders inside the new anatomy.
 * Its content gets a fixed-height, unclipped media slot sized from the type's
 * default height, and its settings panel becomes the controls card.
 * Deleted once every node is on NodeShell directly.
 */
export function BaseNode({
  id,
  children,
  selected = false,
  isExecuting = false,
  hasError = false,
  className = "",
  contentClassName,
  minWidth = 180,
  minHeight = 100,
  fullBleed = false,
  settingsPanel,
  dataTutorial,
}: BaseNodeProps) {
  const nodeType = useWorkflowStore((state) => state.nodes?.find((n) => n.id === id)?.type);
  const defaultHeight = (nodeType && defaultNodeDimensions[nodeType]?.height) || 280;
  const mediaHeight = Math.max(minHeight, defaultHeight) - 2 * CARD_EDGE;

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isExecuting}
      hasError={hasError}
      dataTutorial={dataTutorial}
      media={{ kind: "fixed", height: mediaHeight }}
      clip={false}
      minWidth={minWidth}
      mediaClassName={cn(
        contentClassName ?? (fullBleed ? "flex flex-col" : "px-3 pb-4 flex flex-col"),
        className
      )}
      controls={
        settingsPanel ? (
          <div className="w-[calc(100%-24px)] max-w-[360px] rounded-controls squircle overflow-hidden bg-card border border-card-border">
            {settingsPanel}
          </div>
        ) : undefined
      }
    >
      {children}
    </NodeShell>
  );
}
