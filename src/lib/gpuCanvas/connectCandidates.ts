/**
 * The nodes made live while a connection is drawn on the GPU canvas, beside the one it starts from, the one
 * under the pointer and a valid target. On classic every node is mounted and labels its sockets while a
 * connection is in progress (useShowHandleLabels); a painted node keeps its at-rest picture, so the nodes on
 * screen that could take the connection turn live and label theirs too: first those with a socket of the
 * wanted kind, nearest the pointer first, up to a cap (each is a React Flow node).
 */
import type { SceneGraph } from "./graph";

/** At most this many on-screen nodes turn live for their socket labels while a connection is drawn. */
export const MAX_CONNECT_CANDIDATES = 12;

export function connectCandidates(
  graph: Pick<SceneGraph, "nodes">,
  onScreen: readonly number[],
  at: { x: number; y: number },
  wanted: "source" | "target",
  fromId: string,
  cap = MAX_CONNECT_CANDIDATES,
): string[] {
  const ranked = onScreen.flatMap((i) => {
    const n = graph.nodes[i];
    if (!n || n.id === fromId) return [];
    let takes = false;
    for (const [key, anchor] of n.handles ?? []) {
      if (key.startsWith(`${wanted}:`) && anchor.connectableEnd !== false) {
        takes = true;
        break;
      }
    }
    const dx = Math.max(n.x - at.x, 0, at.x - (n.x + n.w)), dy = Math.max(n.y - at.y, 0, at.y - (n.y + n.h));
    return [{ id: n.id, takes, d: Math.hypot(dx, dy) }];
  });
  ranked.sort((a, b) => Number(b.takes) - Number(a.takes) || a.d - b.d);
  return ranked.slice(0, cap).map((r) => r.id);
}
