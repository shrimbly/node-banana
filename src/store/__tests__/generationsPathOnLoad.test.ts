/**
 * The generations folder a loaded workflow browses its history from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { STORAGE_KEY } from "../utils/localStorage";

const initial = useWorkflowStore.getState();

const file = (overrides: Record<string, unknown> = {}) => ({
  version: 1 as const,
  id: "wf-1",
  name: "Mannequin",
  nodes: [],
  edges: [],
  edgeStyle: "angular" as const,
  ...overrides,
});

describe("generations path on load", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [], groups: {}, generationsPath: null, saveDirectoryPath: null });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("derives the folder from the workflow's own directory when no config was saved", async () => {
    await useWorkflowStore.getState().loadWorkflow(file({ directoryPath: "/projects/mannequin" }));

    expect(useWorkflowStore.getState().saveDirectoryPath).toBe("/projects/mannequin");
    expect(useWorkflowStore.getState().generationsPath).toBe("/projects/mannequin/generations");
  });

  it("remembers the derived folder so the next open does not start from nothing", async () => {
    await useWorkflowStore.getState().loadWorkflow(file({ directoryPath: "/projects/mannequin" }));

    const configs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(configs["wf-1"]).toMatchObject({
      directoryPath: "/projects/mannequin",
      generationsPath: "/projects/mannequin/generations",
    });
  });

  it("prefers the folder the saved config names", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "wf-1": { workflowId: "wf-1", name: "Mannequin", directoryPath: "/projects/mannequin", generationsPath: "/elsewhere/out", lastSavedAt: 5 } })
    );
    await useWorkflowStore.getState().loadWorkflow(file({ directoryPath: "/projects/mannequin" }));

    expect(useWorkflowStore.getState().generationsPath).toBe("/elsewhere/out");
  });

  it("repairs a config that recorded no folder", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "wf-1": { workflowId: "wf-1", name: "Mannequin", directoryPath: "/projects/mannequin", generationsPath: null, lastSavedAt: 5 } })
    );
    await useWorkflowStore.getState().loadWorkflow(file());

    expect(useWorkflowStore.getState().generationsPath).toBe("/projects/mannequin/generations");
    const configs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(configs["wf-1"].generationsPath).toBe("/projects/mannequin/generations");
    expect(configs["wf-1"].lastSavedAt).toBe(5);
  });

  it("stays unset for a workflow with no folder at all", async () => {
    await useWorkflowStore.getState().loadWorkflow(file());

    expect(useWorkflowStore.getState().generationsPath).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("drops carousel entries whose files are gone from the folder", async () => {
    const entry = (id: string) => ({ id, timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" });
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success: true, ids: ["kept-1", "kept-2"] }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await useWorkflowStore.getState().loadWorkflow(
        file({
          directoryPath: "/projects/mannequin",
          nodes: [
            {
              id: "gen-1",
              type: "nanoBanana",
              position: { x: 0, y: 0 },
              data: { imageHistory: [entry("kept-1"), entry("missing"), entry("kept-2")], selectedHistoryIndex: 2, status: "idle" },
            } as never,
          ],
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledWith(`/api/list-generations?path=${encodeURIComponent("/projects/mannequin/generations")}`);
    const data = useWorkflowStore.getState().nodes.find((n) => n.id === "gen-1")!.data as { imageHistory: { id: string }[]; selectedHistoryIndex: number };
    expect(data.imageHistory.map((e) => e.id)).toEqual(["kept-1", "kept-2"]);
    expect(data.selectedHistoryIndex).toBe(1);
  });

  it("keeps the history when the folder cannot be listed", async () => {
    const entry = (id: string) => ({ id, timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      await useWorkflowStore.getState().loadWorkflow(
        file({
          directoryPath: "/projects/mannequin",
          nodes: [{ id: "gen-1", type: "nanoBanana", position: { x: 0, y: 0 }, data: { imageHistory: [entry("a")], selectedHistoryIndex: 0, status: "idle" } } as never],
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
    const data = useWorkflowStore.getState().nodes.find((n) => n.id === "gen-1")!.data as { imageHistory: { id: string }[] };
    expect(data.imageHistory.map((e) => e.id)).toEqual(["a"]);
  });
});
