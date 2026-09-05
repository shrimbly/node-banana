/**
 * Workflow tabs: parking one workflow while another is live in the canvas.
 * Runs against the real store; media hydration is mocked out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkflowStore, type WorkflowFile } from "../workflowStore";
import {
  summarizeWorkflowTabs,
  tabToActivateAfterClose,
  anyWorkflowTabUnsaved,
  isWorkflowTabPristine,
  type WorkflowTab,
} from "../utils/workflowTabs";
import type { WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));

const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  }),
});

const store = () => useWorkflowStore.getState();

const promptNode = (id: string): WorkflowNode =>
  ({
    id,
    type: "prompt",
    position: { x: 0, y: 0 },
    data: { prompt: `prompt ${id}` },
  }) as unknown as WorkflowNode;

const workflowFile = (name: string, nodeIds: string[]): WorkflowFile => ({
  version: 1,
  name,
  nodes: nodeIds.map(promptNode),
  edges: [],
  edgeStyle: "angular",
});

/** Back to a single, empty tab regardless of what the last test left behind. */
function resetTabs() {
  const s = store();
  useWorkflowStore.setState({
    isRunning: false,
    isSaving: false,
    tabs: [{ id: s.activeTabId, snapshot: null }],
  });
  s.clearWorkflow();
}

describe("workflow tabs (store)", () => {
  beforeEach(() => {
    resetTabs();
  });

  it("starts with one live tab", () => {
    const { tabs, activeTabId } = store();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(activeTabId);
    expect(tabs[0].snapshot).toBeNull();
  });

  it("newTab parks the live workflow and opens an empty one", () => {
    useWorkflowStore.setState({ nodes: [promptNode("prompt-1")], workflowName: "First", hasUnsavedChanges: true });
    const firstId = store().activeTabId;

    const id = store().newTab();

    expect(id).not.toBeNull();
    const { tabs, activeTabId, nodes, workflowName, hasUnsavedChanges } = store();
    expect(activeTabId).toBe(id);
    expect(tabs.map((tab) => tab.id)).toEqual([firstId, id]);
    expect(nodes).toEqual([]);
    expect(workflowName).toBeNull();
    expect(hasUnsavedChanges).toBe(false);

    const parked = tabs[0].snapshot;
    expect(parked?.workflowName).toBe("First");
    expect(parked?.nodes.map((node) => node.id)).toEqual(["prompt-1"]);
    expect(parked?.hasUnsavedChanges).toBe(true);
  });

  it("switchTab brings a parked workflow back, with its ids clear for new nodes", () => {
    useWorkflowStore.setState({ nodes: [promptNode("prompt-7")], workflowName: "First" });
    const firstId = store().activeTabId;
    store().newTab();
    useWorkflowStore.setState({ workflowName: "Second" });

    expect(store().switchTab(firstId)).toBe(true);

    expect(store().activeTabId).toBe(firstId);
    expect(store().workflowName).toBe("First");
    expect(store().nodes.map((node) => node.id)).toEqual(["prompt-7"]);
    expect(store().tabs[0].snapshot).toBeNull();
    expect(store().tabs[1].snapshot?.workflowName).toBe("Second");

    // A node added now must not reuse prompt-7
    const newId = store().addNode("prompt", { x: 10, y: 10 });
    expect(newId).toBe("prompt-8");
  });

  it("switchTab is a no-op for the active tab or an unknown id", () => {
    const active = store().activeTabId;
    expect(store().switchTab(active)).toBe(false);
    expect(store().switchTab("tab-nope")).toBe(false);
  });

  it("refuses to switch, open or close while a run is in flight", () => {
    store().newTab();
    const [first] = store().tabs;
    useWorkflowStore.setState({ isRunning: true });

    expect(store().switchTab(first.id)).toBe(false);
    expect(store().newTab()).toBeNull();
    expect(store().closeTab(first.id)).toBe(false);
    expect(store().tabs).toHaveLength(2);
  });

  it("closing a parked tab drops it and keeps the live one", () => {
    useWorkflowStore.setState({ workflowName: "First" });
    const firstId = store().activeTabId;
    const secondId = store().newTab();

    expect(store().closeTab(firstId)).toBe(true);

    expect(store().tabs.map((tab) => tab.id)).toEqual([secondId]);
    expect(store().activeTabId).toBe(secondId);
  });

  it("closing the active tab activates its right neighbour, else its left", () => {
    const a = store().activeTabId;
    const b = store().newTab()!;
    const c = store().newTab()!;
    useWorkflowStore.setState({ workflowName: "C" });

    store().switchTab(b);
    expect(store().closeTab(b)).toBe(true);
    expect(store().activeTabId).toBe(c);
    expect(store().workflowName).toBe("C");

    expect(store().closeTab(c)).toBe(true);
    expect(store().activeTabId).toBe(a);
    expect(store().tabs.map((tab) => tab.id)).toEqual([a]);
  });

  it("closing the only tab leaves a fresh empty tab", () => {
    useWorkflowStore.setState({ nodes: [promptNode("prompt-1")], workflowName: "Only", hasUnsavedChanges: true });
    const before = store().activeTabId;

    expect(store().closeTab(before)).toBe(true);

    const { tabs, activeTabId, nodes, workflowName, hasUnsavedChanges } = store();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).not.toBe(before);
    expect(nodes).toEqual([]);
    expect(workflowName).toBeNull();
    expect(hasUnsavedChanges).toBe(false);
  });

  it("openWorkflowInNewTab loads into the current tab when it is untouched", async () => {
    const initial = store().activeTabId;
    await store().openWorkflowInNewTab(workflowFile("Loaded", ["prompt-1"]));

    expect(store().tabs).toHaveLength(1);
    expect(store().activeTabId).toBe(initial);
    expect(store().workflowName).toBe("Loaded");
  });

  it("openWorkflowInNewTab opens a new tab when the current one has content", async () => {
    useWorkflowStore.setState({ nodes: [promptNode("prompt-1")], workflowName: "Busy" });
    const initial = store().activeTabId;

    await store().openWorkflowInNewTab(workflowFile("Loaded", ["prompt-2"]));

    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).not.toBe(initial);
    expect(store().workflowName).toBe("Loaded");
    expect(store().tabs[0].snapshot?.workflowName).toBe("Busy");
  });

  it("a switch clears undo history and the AI snapshot follows its tab", () => {
    useWorkflowStore.setState({ workflowName: "First" });
    store().addNode("prompt", { x: 0, y: 0 });
    expect(store().canUndo).toBe(true);
    const firstId = store().activeTabId;

    store().newTab();
    expect(store().canUndo).toBe(false);

    store().switchTab(firstId);
    expect(store().canUndo).toBe(false);
    expect(store().nodes).toHaveLength(1);
  });
});

describe("workflow tabs (pure helpers)", () => {
  const snapshot = (name: string | null, unsaved = false) =>
    ({ workflowName: name, hasUnsavedChanges: unsaved }) as unknown as NonNullable<WorkflowTab["snapshot"]>;

  it("summarizes parked tabs from their snapshot and the active one from live state", () => {
    const tabs: WorkflowTab[] = [
      { id: "a", snapshot: snapshot("A", true) },
      { id: "b", snapshot: null },
    ];
    expect(summarizeWorkflowTabs(tabs, "b", { workflowName: "Live", hasUnsavedChanges: false })).toEqual([
      { id: "a", name: "A", hasUnsavedChanges: true, isActive: false },
      { id: "b", name: "Live", hasUnsavedChanges: false, isActive: true },
    ]);
  });

  it("picks the right neighbour after a close, then the left, then nothing", () => {
    const tabs: WorkflowTab[] = [
      { id: "a", snapshot: null },
      { id: "b", snapshot: null },
      { id: "c", snapshot: null },
    ];
    expect(tabToActivateAfterClose(tabs, "b")).toBe("c");
    expect(tabToActivateAfterClose(tabs, "c")).toBe("b");
    expect(tabToActivateAfterClose([tabs[0]], "a")).toBeNull();
    expect(tabToActivateAfterClose(tabs, "zzz")).toBeNull();
  });

  it("reports unsaved work in any tab", () => {
    const tabs: WorkflowTab[] = [
      { id: "a", snapshot: snapshot("A", false) },
      { id: "b", snapshot: null },
    ];
    expect(anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges: false })).toBe(false);
    expect(anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges: true })).toBe(true);
    tabs[0].snapshot!.hasUnsavedChanges = true;
    expect(anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges: false })).toBe(true);
  });

  it("calls a tab pristine only with no nodes, no name and no edits", () => {
    expect(isWorkflowTabPristine({ nodes: [], workflowName: null, hasUnsavedChanges: false })).toBe(true);
    expect(isWorkflowTabPristine({ nodes: [promptNode("p")], workflowName: null, hasUnsavedChanges: false })).toBe(false);
    expect(isWorkflowTabPristine({ nodes: [], workflowName: "X", hasUnsavedChanges: false })).toBe(false);
    expect(isWorkflowTabPristine({ nodes: [], workflowName: null, hasUnsavedChanges: true })).toBe(false);
  });
});
