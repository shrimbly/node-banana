/**
 * Edge appearance settings: store action, undo, file round-trip, and the
 * user default in localStorage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { defaultEdgeAppearance } from "@/types";
import { EDGE_DEFAULTS_KEY } from "../utils/localStorage";

const initial = useWorkflowStore.getState();

describe("edge appearance", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkflowStore.setState({
      ...initial,
      nodes: [],
      edges: [],
      groups: {},
      edgeStyle: "curved",
      edgeAppearance: { ...defaultEdgeAppearance },
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("starts from the built-in defaults", () => {
    expect(useWorkflowStore.getState().edgeAppearance).toEqual(defaultEdgeAppearance);
  });

  it("merges a partial update into the current appearance", () => {
    useWorkflowStore.getState().setEdgeAppearance({ thickness: "thick" });
    expect(useWorkflowStore.getState().edgeAppearance).toEqual({
      ...defaultEdgeAppearance,
      thickness: "thick",
    });
    useWorkflowStore.getState().setEdgeAppearance({ gradient: false, fadedOpacity: 0.5 });
    expect(useWorkflowStore.getState().edgeAppearance).toEqual({
      thickness: "thick",
      fadedOpacity: 0.5,
      gradient: false,
      loadingPulse: true,
      labels: "hover",
    });
  });

  it("is restored by undo and redo", () => {
    const store = useWorkflowStore.getState();
    store.setEdgeAppearance({ thickness: "thin" });
    expect(useWorkflowStore.getState().edgeAppearance.thickness).toBe("thin");

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edgeAppearance.thickness).toBe("regular");

    useWorkflowStore.getState().redo();
    expect(useWorkflowStore.getState().edgeAppearance.thickness).toBe("thin");
  });

  it("loads the appearance saved in a workflow file", async () => {
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "Test",
      nodes: [],
      edges: [],
      edgeStyle: "angular",
      edgeAppearance: { thickness: "thick", fadedOpacity: 0.6, gradient: false, loadingPulse: false, labels: "always" },
    });
    expect(useWorkflowStore.getState().edgeAppearance).toEqual({
      thickness: "thick",
      fadedOpacity: 0.6,
      gradient: false,
      loadingPulse: false,
      labels: "always",
    });
  });

  it("repairs an invalid appearance in a workflow file", async () => {
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "Test",
      nodes: [],
      edges: [],
      edgeStyle: "curved",
      // Hand-edited file: bad thickness, out-of-range opacity, missing flags
      edgeAppearance: { thickness: "huge", fadedOpacity: 4 } as never,
    });
    expect(useWorkflowStore.getState().edgeAppearance).toEqual({
      ...defaultEdgeAppearance,
      fadedOpacity: 1,
    });
  });

  it("falls back to the user default when a file carries no appearance", async () => {
    localStorage.setItem(
      EDGE_DEFAULTS_KEY,
      JSON.stringify({ edgeStyle: "straight", appearance: { ...defaultEdgeAppearance, thickness: "thin" } })
    );
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "Old",
      nodes: [],
      edges: [],
      edgeStyle: "angular",
    });
    const state = useWorkflowStore.getState();
    expect(state.edgeAppearance.thickness).toBe("thin");
    // The file's own line style still wins over the default
    expect(state.edgeStyle).toBe("angular");
  });

  it("starts a cleared workflow from the user default", () => {
    localStorage.setItem(
      EDGE_DEFAULTS_KEY,
      JSON.stringify({ edgeStyle: "straight", appearance: { ...defaultEdgeAppearance, gradient: false } })
    );
    useWorkflowStore.getState().setEdgeAppearance({ thickness: "thick" });
    useWorkflowStore.getState().clearWorkflow();
    const state = useWorkflowStore.getState();
    expect(state.edgeStyle).toBe("straight");
    expect(state.edgeAppearance).toEqual({ ...defaultEdgeAppearance, gradient: false });
  });

  it("captures and reverts the appearance with the AI change snapshot", () => {
    useWorkflowStore.getState().captureSnapshot();
    useWorkflowStore.getState().setEdgeAppearance({ loadingPulse: false });
    expect(useWorkflowStore.getState().edgeAppearance.loadingPulse).toBe(false);
    useWorkflowStore.getState().revertToSnapshot();
    expect(useWorkflowStore.getState().edgeAppearance.loadingPulse).toBe(true);
  });
});
