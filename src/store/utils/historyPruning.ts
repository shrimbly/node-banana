/**
 * Carousel history entries point at files in the generations folder. Once a
 * file is gone the entry can never be shown again, so a loaded workflow drops
 * the entries whose files are missing.
 */

import type { WorkflowNode, WorkflowNodeData } from "@/types";

interface HistoryField {
  list: string;
  index: string;
}

/** Where each node type keeps its carousel entries and the selected one. */
const HISTORY_FIELDS: Partial<Record<string, HistoryField>> = {
  nanoBanana: { list: "imageHistory", index: "selectedHistoryIndex" },
  generateVideo: { list: "videoHistory", index: "selectedVideoHistoryIndex" },
  generateAudio: { list: "audioHistory", index: "selectedAudioHistoryIndex" },
};

interface HistoryEntry {
  id: string;
}

function entriesOf(node: WorkflowNode): HistoryEntry[] {
  const field = HISTORY_FIELDS[node.type ?? ""];
  if (!field) return [];
  const list = (node.data as Record<string, unknown>)[field.list];
  return Array.isArray(list) ? (list as HistoryEntry[]) : [];
}

/** True when some node carries a carousel entry worth checking. */
export function hasHistoryEntries(nodes: ReadonlyArray<WorkflowNode>): boolean {
  return nodes.some((node) => entriesOf(node).length > 0);
}

/**
 * Drop every carousel entry whose id is not in `availableIds`. The selected
 * entry stays selected when it survives; otherwise the newest one is.
 */
export function pruneMissingHistory(
  nodes: ReadonlyArray<WorkflowNode>,
  availableIds: ReadonlySet<string>
): { nodes: WorkflowNode[]; changed: boolean } {
  let changed = false;
  const next = nodes.map((node) => {
    const field = HISTORY_FIELDS[node.type ?? ""];
    if (!field) return node;
    const entries = entriesOf(node);
    const kept = entries.filter((entry) => availableIds.has(entry.id));
    if (kept.length === entries.length) return node;
    changed = true;
    const data = node.data as Record<string, unknown>;
    const currentIndex = typeof data[field.index] === "number" ? (data[field.index] as number) : 0;
    const currentId = entries[currentIndex]?.id;
    const nextIndex = Math.max(0, kept.findIndex((entry) => entry.id === currentId));
    return {
      ...node,
      data: { ...data, [field.list]: kept, [field.index]: nextIndex } as WorkflowNodeData,
    };
  });
  return { nodes: next, changed };
}
