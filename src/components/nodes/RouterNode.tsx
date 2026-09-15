"use client";

import { memo, useMemo } from "react";
import { NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
import { LogicRow, LogicRows, type SocketSpec } from "./ui";

const ALL_HANDLE_TYPES = ["image", "text", "video", "audio", "3d", "easeCurve"] as const;
type RoutedType = (typeof ALL_HANDLE_TYPES)[number];

const TYPE_LABELS: Record<RoutedType, string> = {
  image: "Image",
  text: "Text",
  video: "Video",
  audio: "Audio",
  "3d": "3D",
  easeCurve: "Ease curve",
};

/**
 * A pass-through that grows a typed lane for every kind of connection
 * dropped on it. Each lane is one row with its input socket on the left and
 * its output on the right; a grey generic socket waits below for the next.
 */
export const RouterNode = memo(({ id, selected }: NodeProps<WorkflowNode>) => {
  const edges = useWorkflowStore((state) => state.edges);

  // Derive active input types from incoming edge connections
  const activeInputTypes = useMemo(() => {
    const typeSet = new Set<RoutedType>();
    edges
      .filter((edge) => edge.target === id)
      .forEach((edge) => {
        const handleType = edge.targetHandle;
        if (handleType && ALL_HANDLE_TYPES.includes(handleType as RoutedType)) {
          typeSet.add(handleType as RoutedType);
        }
      });
    return Array.from(typeSet).sort();
  }, [edges, id]);

  // Show the generic socket while some type is still unrouted
  const showGeneric = activeInputTypes.length < ALL_HANDLE_TYPES.length;

  const inputs = useMemo<SocketSpec[]>(() => {
    const sockets: SocketSpec[] = activeInputTypes.map((type) => ({ id: type, type, label: TYPE_LABELS[type] }));
    if (showGeneric) sockets.push({ id: "generic-input", type: "reference", label: "Any" });
    return sockets;
  }, [activeInputTypes, showGeneric]);

  const outputs = useMemo<SocketSpec[]>(
    () => activeInputTypes.map((type) => ({ id: type, type, label: TYPE_LABELS[type] })),
    [activeInputTypes]
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "auto" }}
      inputs={inputs}
      outputs={outputs}
      minWidth={200}
      cardClassName="rounded-controls"
    >
      <LogicRows>
        {activeInputTypes.map((type) => (
          <LogicRow key={type} lane>
            <span className="text-node text-neutral-300">{TYPE_LABELS[type]}</span>
          </LogicRow>
        ))}
        {showGeneric && (
          <LogicRow lane>
            <span className="text-node text-neutral-500">
              {activeInputTypes.length > 0 ? "Drop another type here" : "Drop connections here"}
            </span>
          </LogicRow>
        )}
      </LogicRows>
    </NodeShell>
  );
});

RouterNode.displayName = "RouterNode";
