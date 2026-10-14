import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings } from "@/types/canvas";
import { GridIndex, SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import type { GpuEditing } from "../editor";
import type { LiveLayer } from "../LiveLayer";

const noop = () => {};
const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

function node(id: string, x: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y: 0 }, data: { prompt: "" }, width: 300, height: 200, selected } as unknown as WorkflowNode;
}

function pointer(x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent("pointerdown", { clientX: x, clientY: y, button: 0, ...init }) as unknown as PointerEvent;
}

let Editor: typeof import("../editor").Editor;
let edgeHit = -1;
let settings: GpuEditing;
let editor: InstanceType<typeof Editor>;

beforeAll(async () => {
  // The editor reads the platform once, as it loads.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  vi.resetModules();
  ({ Editor } = await import("../editor"));
});

afterAll(() => {
  delete (navigator as unknown as Record<string, unknown>).platform;
  if (platform) Object.defineProperty(Navigator.prototype, "platform", platform);
});

beforeEach(() => {
  const nodes = [node("a", 0, true), node("b", 400, true), node("c", 800)];
  const edges = [{ id: "ac", source: "a", target: "c", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge];
  // The editor's own store module (loaded afresh above).
  return import("@/store/workflowStore").then(({ useWorkflowStore: store }) => {
    store.setState({ nodes, edges, edgeMenuAnchor: null });
    const graph = new SceneGraph(nodes, edges, {});
    const index = new GridIndex(graph.nodes);
    edgeHit = -1;
    const scene = {
      graph, canvas: document.createElement("canvas"), view: { x: 0, y: 0, zoom: 1 },
      local: (event: MouseEvent) => ({ x: event.clientX, y: event.clientY }),
      toWorld: (x: number, y: number) => ({ x, y }),
      nodeAt: (x: number, y: number) => index.at(x, y),
      drawnAtOrAbove: (i: number, top: number) => i >= top,
      nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1),
      edgeAt: () => edgeHit,
      edgeRoute: () => ({ segments: [[0, 1000, 1200, 1000]], stems: [] }),
      capture: noop, input: noop, nodesMoved: noop, setHeldEdge: noop, setHoveredEdge: noop, panGesture: () => ({ move: noop, up: noop, cancel: noop }),
      onViewChanged: () => noop, onLayoutChanged: () => noop,
    } as unknown as Scene;
    const live = { refresh: noop, wantOnly: noop, want: noop, live: new Set<string>(), element: document.createElement("div") } as unknown as LiveLayer;
    settings = {
      navigation: defaultCanvasNavigationSettings, locked: false, disabled: false, tutorial: false,
      isValidConnection: () => true, onConnect: noop, onReconnect: noop, onConnectEnd: noop, onHandleClick: noop, onNodeDragStop: noop,
      onPaneClick: vi.fn(), onPaneMenu: vi.fn(), onEdgeClick: vi.fn(), onEdgeContextMenu: noop,
    };
    editor?.dispose();
    editor = new Editor(scene, live, document.createElement("div"), () => settings);
  });
});

describe("a Control+click on the Mac (a secondary click)", () => {
  it.each([
    ["a node", 900, 100, -1],
    ["a connection", 500, 1000, 0],
    ["empty canvas", 2000, 2000, -1],
  ])("on %s starts nothing and leaves the selection", async (_name, x, y, edge) => {
    const { useWorkflowStore: store } = await import("@/store/workflowStore");
    edgeHit = edge;
    const gesture = editor.press(pointer(x, y, { ctrlKey: true }));
    expect(gesture).toBeNull();
    expect(store.getState().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["a", "b"]);
    expect(store.getState().edges.filter((e) => e.selected)).toEqual([]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
    expect(settings.onEdgeClick).not.toHaveBeenCalled();
  });

  it("a plain click still selects", async () => {
    const { useWorkflowStore: store } = await import("@/store/workflowStore");
    const gesture = editor.press(pointer(900, 100));
    gesture?.up(pointer(900, 100));
    expect(store.getState().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["c"]);
  });
});
