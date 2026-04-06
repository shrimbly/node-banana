import { Node } from "@xyflow/react";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { NodeType } from "@/types";

const COLLISION_GAP = 20; // Same as STACK_GAP in MultiSelectToolbar

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Check if two rectangles intersect (AABB collision detection)
 */
export function rectanglesIntersect(a: Rectangle, b: Rectangle): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/**
 * Find the nearest free position that doesn't overlap existing nodes.
 * Tries offsets in order: right, down, left, up (spiral pattern).
 */
export function findNearestFreePosition(
  targetPos: { x: number; y: number },
  nodeType: NodeType,
  existingNodes: Node[]
): { x: number; y: number } {
  const { width, height } = defaultNodeDimensions[nodeType];

  // Try original position first
  if (!hasCollision(targetPos, width, height, existingNodes)) {
    return targetPos;
  }

  // Try offsets in spiral pattern (right, down, left, up, right-down, etc.)
  const offsets = [
    { x: width + COLLISION_GAP, y: 0 }, // right
    { x: 0, y: height + COLLISION_GAP }, // down
    { x: -(width + COLLISION_GAP), y: 0 }, // left
    { x: 0, y: -(height + COLLISION_GAP) }, // up
    { x: width + COLLISION_GAP, y: height + COLLISION_GAP }, // right-down
    { x: -(width + COLLISION_GAP), y: height + COLLISION_GAP }, // left-down
    { x: width + COLLISION_GAP, y: -(height + COLLISION_GAP) }, // right-up
    { x: -(width + COLLISION_GAP), y: -(height + COLLISION_GAP) }, // left-up
  ];

  for (const offset of offsets) {
    const testPos = {
      x: targetPos.x + offset.x,
      y: targetPos.y + offset.y,
    };

    if (!hasCollision(testPos, width, height, existingNodes)) {
      return testPos;
    }
  }

  // Fallback: if all offsets fail, use original position (rare in practice)
  return targetPos;
}

/**
 * Check if placing a node at position would collide with existing nodes
 */
function hasCollision(
  pos: { x: number; y: number },
  width: number,
  height: number,
  existingNodes: Node[]
): boolean {
  const newRect: Rectangle = {
    x: pos.x,
    y: pos.y,
    width,
    height,
  };

  for (const node of existingNodes) {
    const nodeWidth =
      (node.measured?.width as number) ||
      (node.style?.width as number) ||
      300;
    const nodeHeight =
      (node.measured?.height as number) ||
      (node.style?.height as number) ||
      300;

    const existingRect: Rectangle = {
      x: node.position.x,
      y: node.position.y,
      width: nodeWidth,
      height: nodeHeight,
    };

    if (rectanglesIntersect(newRect, existingRect)) {
      return true;
    }
  }

  return false;
}
