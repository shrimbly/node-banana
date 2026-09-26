import type { NodeType } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";

/**
 * Rendered heights for spacing nodes React Flow has not measured yet, where
 * they differ from defaultNodeDimensions: generation nodes show their
 * settings on the card and render ~450px tall, while their default height
 * (300) is what they shrink to without them. Over-estimating only widens a
 * gap; under-estimating stacks a new node onto the one above it.
 */
const RENDERED_HEIGHT: Partial<Record<NodeType, number>> = {
  nanoBanana: 460,
  generateVideo: 460,
  generate3d: 440,
  generateAudio: 420,
};

/** Height to assume for an unmeasured node of this type. */
export function estimatedNodeHeight(type: NodeType): number {
  const base = defaultNodeDimensions[type]?.height ?? 280;
  return Math.max(base, RENDERED_HEIGHT[type] ?? 0);
}
