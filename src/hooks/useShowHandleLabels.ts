import { useConnection } from "@xyflow/react";
import { useIsPaintedNode } from "@/components/nodes/paintMode";
import { useConnectDragStore } from "@/store/connectDragStore";

export function useShowHandleLabels(selected: boolean | undefined): boolean {
  const isConnecting = useConnection((c) => c.inProgress);
  // The GPU canvas draws its connections itself; its painted pictures stay as they are at rest.
  const painted = useIsPaintedNode();
  const gpuConnecting = useConnectDragStore((s) => s.active) && !painted;
  return !!selected || isConnecting || gpuConnecting;
}
