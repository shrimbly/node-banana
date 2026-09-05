/**
 * Workflow tabs: several workflows open at once, one live in the canvas.
 *
 * The store only ever holds one workflow's state in its top-level fields. A
 * tab is a parked copy of that state: switching tabs captures the live slice
 * into the outgoing tab and applies the incoming tab's copy. The active tab's
 * `snapshot` is null, meaning "look at the store". Everything here is pure so
 * the store's actions stay thin.
 */

import type { EdgeStyle, EdgeAppearance } from "@/types";
import type { WorkflowStore } from "../workflowStore";

/** The store fields that belong to one workflow rather than to the app. */
const SNAPSHOT_KEYS = [
  "nodes",
  "edges",
  "groups",
  "edgeStyle",
  "edgeAppearance",
  "workflowId",
  "workflowName",
  "saveDirectoryPath",
  "generationsPath",
  "lastSavedAt",
  "hasUnsavedChanges",
  "incurredCost",
  "imageRefBasePath",
  "useExternalImageStorage",
  "viewedCommentNodeIds",
  "globalImageHistory",
  "previousWorkflowSnapshot",
  "manualChangeCount",
  "dimmedNodeIds",
  "skippedNodeIds",
] as const satisfies readonly (keyof WorkflowStore)[];

export type WorkflowTabSnapshot = Pick<WorkflowStore, (typeof SNAPSHOT_KEYS)[number]>;

export interface WorkflowTab {
  id: string;
  /** Parked state for an inactive tab; null while the tab is live in the canvas. */
  snapshot: WorkflowTabSnapshot | null;
}

/** What the tab strip needs to draw one tab. */
export interface WorkflowTabSummary {
  id: string;
  name: string | null;
  hasUnsavedChanges: boolean;
  isActive: boolean;
}

let tabIdCounter = 0;

export function createTabId(): string {
  tabIdCounter += 1;
  return `tab-${tabIdCounter}`;
}

/** Copy the workflow fields out of the live store state. */
export function captureWorkflowTabSnapshot(state: WorkflowTabSnapshot): WorkflowTabSnapshot {
  const snapshot: Partial<WorkflowTabSnapshot> = {};
  for (const key of SNAPSHOT_KEYS) {
    Object.assign(snapshot, { [key]: state[key] });
  }
  return snapshot as WorkflowTabSnapshot;
}

/** The state of a fresh, untitled tab. */
export function emptyWorkflowTabSnapshot(defaults: {
  edgeStyle: EdgeStyle;
  edgeAppearance: EdgeAppearance;
  useExternalImageStorage: boolean;
}): WorkflowTabSnapshot {
  return {
    nodes: [],
    edges: [],
    groups: {},
    edgeStyle: defaults.edgeStyle,
    edgeAppearance: defaults.edgeAppearance,
    workflowId: null,
    workflowName: null,
    saveDirectoryPath: null,
    generationsPath: null,
    lastSavedAt: null,
    hasUnsavedChanges: false,
    incurredCost: 0,
    imageRefBasePath: null,
    useExternalImageStorage: defaults.useExternalImageStorage,
    viewedCommentNodeIds: new Set<string>(),
    globalImageHistory: [],
    previousWorkflowSnapshot: null,
    manualChangeCount: 0,
    dimmedNodeIds: new Set<string>(),
    skippedNodeIds: new Set<string>(),
  };
}

/** True when the tab has nothing worth keeping: no nodes, no name, no edits. */
export function isWorkflowTabPristine(
  state: Pick<WorkflowTabSnapshot, "nodes" | "workflowName" | "hasUnsavedChanges">
): boolean {
  return state.nodes.length === 0 && !state.workflowName && !state.hasUnsavedChanges;
}

/** Summaries for the strip; the active tab reads from the live state. */
export function summarizeWorkflowTabs(
  tabs: WorkflowTab[],
  activeTabId: string,
  live: Pick<WorkflowTabSnapshot, "workflowName" | "hasUnsavedChanges">
): WorkflowTabSummary[] {
  return tabs.map((tab) => {
    const isActive = tab.id === activeTabId;
    const source = isActive || !tab.snapshot ? live : tab.snapshot;
    return {
      id: tab.id,
      name: source.workflowName,
      hasUnsavedChanges: source.hasUnsavedChanges,
      isActive,
    };
  });
}

/**
 * Which tab takes over when `closingId` is the active tab: the one to its
 * right, else the one to its left. Null when it is the only tab.
 */
export function tabToActivateAfterClose(tabs: WorkflowTab[], closingId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0 || tabs.length <= 1) return null;
  const next = tabs[index + 1] ?? tabs[index - 1];
  return next ? next.id : null;
}

/** True when any tab, parked or live, has edits that are not on disk. */
export function anyWorkflowTabUnsaved(
  tabs: WorkflowTab[],
  live: Pick<WorkflowTabSnapshot, "hasUnsavedChanges">
): boolean {
  return live.hasUnsavedChanges || tabs.some((tab) => tab.snapshot?.hasUnsavedChanges === true);
}
