import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useEdgeHoverStore } from "@/store/edgeHoverStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings } from "@/types/canvas";
import { GridIndex, SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { Editor, type GpuEditing } from "../editor";
import { LIVE_STYLE, liveButtonPress, pressGoesToScene, rightPressPansFromHeader, selectionKeyTakesPress, type LiveLayer } from "../LiveLayer";

function node(id: string, x: number, y: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, height: 200, selected } as unknown as WorkflowNode;
}

const noop = () => {};
let editor: Editor;
let host: HTMLDivElement;
let settings: GpuEditing;
let edgeHit: number;
let stems: { segment: number[]; width: number }[];
/** Nodes the editor holds live for a press. */
let pressed: string[];

/** A pointer event at a css point (the fake scene's css and flow coordinates are the same). */
function pointer(x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent("pointerdown", { clientX: x, clientY: y, button: 0, ...init }) as unknown as PointerEvent;
}

function click(x: number, y: number, init: MouseEventInit = {}) {
  const gesture = editor.press(pointer(x, y, init));
  gesture?.up(pointer(x, y, init));
}

function drag(from: [number, number], to: [number, number], init: MouseEventInit = {}) {
  const gesture = editor.press(pointer(...from, init));
  gesture?.move(pointer(...to, init));
  gesture?.up(pointer(...to, init));
}

/** The fake scene's nodes with their 30-unit floating header bands, as the scene's own index finds them. */
function withHeaderBands() {
  const index = new GridIndex(editor["scene"].graph.nodes, 512, 30);
  (editor["scene"] as unknown as Record<string, unknown>).nodeAt = (x: number, y: number, header = true) => index.at(x, y, header);
}

const selectedEdges = () => useWorkflowStore.getState().edges.filter((e) => e.selected).map((e) => e.id);
const frame = () => host.querySelector<HTMLElement>("[data-gpu-canvas-selection-frame]")!;
const selected = () => useWorkflowStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);

beforeEach(() => {
  const nodes = [node("a", 0, 0, true), node("b", 400, 0, true), node("c", 800, 0)];
  // A connection whose route runs along y = 1000, below the nodes.
  const edges = [{ id: "ac", source: "a", target: "c", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge];
  useWorkflowStore.setState({ nodes, edges, edgeMenuAnchor: null });
  const graph = new SceneGraph(nodes, edges, {});
  const index = new GridIndex(graph.nodes);
  edgeHit = -1;
  stems = [];
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 5000, bottom: 5000, x: 0, y: 0, width: 5000, height: 5000, toJSON: noop }) as DOMRect;
  const scene = {
    graph, canvas, view: { x: 0, y: 0, zoom: 1 },
    local: (event: MouseEvent) => ({ x: event.clientX, y: event.clientY }),
    toWorld: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    nodeAt: (x: number, y: number) => index.at(x, y),
    drawnAtOrAbove: (i: number, top: number) => i >= top,
    nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1),
    edgeAt: () => edgeHit,
    edgesWithin: () => [0],
    edgeRoute: () => ({ segments: [[0, 1000, 400, 1000, 800, 1000, 1200, 1000]], stems }),
    capture: noop, input: noop, nodesMoved: noop, setHeldEdge: noop, setHoveredEdge: noop, panGesture: () => ({ move: noop, up: noop, cancel: noop }),
    onViewChanged: () => noop, onLayoutChanged: () => noop, visible: () => graph.nodes.map((_, i) => i),
  } as unknown as Scene;
  pressed = [];
  const live = {
    refresh: noop, wantOnly: noop, live: new Set<string>(), element: document.createElement("div"),
    want: (id: string, reason: string, on: boolean) => {
      if (reason === "press") pressed = on ? [...pressed, id] : pressed.filter((p) => p !== id);
    },
  } as unknown as LiveLayer;
  host = document.createElement("div");
  document.body.appendChild(host);
  settings = {
    navigation: defaultCanvasNavigationSettings, locked: false, disabled: false, tutorial: false,
    isValidConnection: () => true, onConnect: noop, onReconnect: noop, onConnectEnd: noop, onHandleClick: noop, onNodeDragStop: noop,
    onPaneClick: vi.fn(), onPaneMenu: vi.fn(), onEdgeClick: noop, onEdgeContextMenu: noop,
  };
  editor = new Editor(scene, live, host, () => settings);
});

afterEach(() => {
  editor.dispose();
  host.remove();
});

describe("presses on the GPU canvas", () => {
  it("a click on empty canvas in select mode clears the selection and is a pane click", () => {
    click(2000, 2000, { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
  });

  it("a press on empty canvas that neither pans nor draws a marquee clicks the pane however far it travels, if released over it", () => {
    // Control held where the press would pan (off the Mac).
    drag([2000, 2000], [2040, 2030], { ctrlKey: true });
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
    settings.tutorial = true;
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "always" };
    drag([2000, 2000], [2040, 2030]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(2);
    expect(selected()).toEqual([]);
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
    drag([2000, 2000], [6000, 2000]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(2);
    expect(selected()).toEqual(["a"]);
  });

  it("with the pane panning on the left button, a 2px drag pans and keeps the selection", () => {
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "always" };
    const moves: number[] = [];
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = () => ({ move: (e: PointerEvent) => moves.push(e.clientX), up: noop, cancel: noop });
    drag([2000, 2000], [2002, 2000]);
    expect(moves).toEqual([2002]);
    expect(selected()).toEqual(["a", "b"]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
  });

  it("a middle press on a node or connection pans in any pan mode, even under a dialog; on empty canvas only where the mode pans", () => {
    const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    settings.disabled = true;
    expect(editor.press(pointer(100, 100, { button: 1 }))).not.toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(1);
    edgeHit = 0;
    expect(editor.press(pointer(500, 1000, { button: 1 }))).not.toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(2);
    edgeHit = -1;
    expect(editor.press(pointer(2000, 2000, { button: 1 }))).toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(2);
  });

  it("in the middleMouse mode a right drag pans only from empty canvas, and not with the selection key held", () => {
    const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    expect(editor.press(pointer(2000, 2000, { button: 2 }))).not.toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(1);
    expect(editor.press(pointer(2000, 2000, { button: 2, shiftKey: true }))).toBeNull();
    expect(editor.press(pointer(100, 100, { button: 2 }))).toBeNull();
    edgeHit = 0;
    expect(editor.press(pointer(500, 1000, { button: 2 }))).toBeNull();
    edgeHit = -1;
    // A locked canvas's nodes are not draggable, so not nopan: a right drag pans from them.
    settings.locked = true;
    expect(editor.press(pointer(100, 100, { button: 2 }))).not.toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(2);
  });

  it("in the middleMouse mode a right drag pans from a floating header (live or painted), not from a nopan element in it", () => {
    const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    withHeaderBands();
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    const live = editor["live"].element;
    live.setAttribute("data-gpu-canvas-live", "");
    document.body.appendChild(live);
    const header = document.createElement("div");
    header.setAttribute("data-node-header", "c");
    const title = document.createElement("input");
    title.className = "nodrag nopan";
    header.appendChild(title);
    live.appendChild(header);
    const on = (target: Element) => {
      const event = pointer(900, 100, { button: 2 });
      Object.defineProperty(event, "target", { value: target });
      return event;
    };
    // The live header, over the node's body on screen: still the pane's.
    expect(editor.press(on(header))).not.toBeNull();
    expect(editor.press(on(title))).toBeNull();
    // A painted header band.
    expect(editor.press(pointer(900, -10, { button: 2 }))).not.toBeNull();
    // The node's body stays nopan.
    expect(editor.press(pointer(900, 100, { button: 2 }))).toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(2);
    live.remove();
  });

  it("in the middleMouse mode a still right press on empty canvas opens the add-node menu at the release; a moved one pans only", () => {
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    let gesture = editor.press(pointer(2000, 2000, { button: 2 }))!;
    gesture.move(pointer(2000, 2000, { button: 2 }));
    gesture.up(pointer(2000, 2000, { button: 2 }));
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
    expect(settings.onPaneMenu).toHaveBeenCalledWith(2000, 2000);
    gesture = editor.press(pointer(2000, 2000, { button: 2 }))!;
    gesture.move(pointer(2001, 2000, { button: 2 }));
    gesture.up(pointer(2001, 2000, { button: 2 }));
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
    gesture = editor.press(pointer(2000, 2000, { button: 2 }))!;
    gesture.cancel();
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
    // The browser's own contextmenu event opens nothing in this mode (the release did).
    const menu = new MouseEvent("contextmenu", { clientX: 2000, clientY: 2000, cancelable: true });
    editor.contextMenu(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
  });

  it("a middle press on a floating header, or on a locked canvas's node, pans only where the pan mode does", () => {
    const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    withHeaderBands();
    const live = editor["live"].element;
    live.setAttribute("data-gpu-canvas-live", "");
    document.body.appendChild(live);
    const header = document.createElement("div");
    header.setAttribute("data-node-header", "c");
    live.appendChild(header);
    const onHeader = () => {
      const event = pointer(900, -10, { button: 1 });
      Object.defineProperty(event, "target", { value: header });
      return event;
    };
    for (const panMode of ["middleMouse", defaultCanvasNavigationSettings.panMode] as const) {
      settings.navigation = { ...defaultCanvasNavigationSettings, panMode };
      const pans = panMode !== "middleMouse" && editor.press(pointer(2000, 2000, { button: 1 })) != null;
      panGesture.mockClear();
      expect(editor.press(onHeader()) != null).toBe(pans);
      expect(editor.press(pointer(900, -10, { button: 1 })) != null).toBe(pans);
      settings.locked = true;
      expect(editor.press(pointer(900, 100, { button: 1 })) != null).toBe(pans);
      settings.locked = false;
      // An unlocked node's body pans in every mode.
      expect(editor.press(pointer(900, 100, { button: 1 }))).not.toBeNull();
    }
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    panGesture.mockClear();
    editor.press(onHeader());
    expect(panGesture).not.toHaveBeenCalled();
    live.remove();
  });

  it("a pressed node stays live until the press ends, clicked, dragged or cancelled", () => {
    let gesture = editor.press(pointer(900, 100))!;
    expect(pressed).toEqual(["c"]);
    gesture.move(pointer(901, 100));
    expect(pressed).toEqual(["c"]);
    gesture.up(pointer(901, 100));
    expect(pressed).toEqual([]);
    drag([100, 100], [200, 100]);
    expect(pressed).toEqual([]);
    gesture = editor.press(pointer(500, 100))!;
    expect(pressed).toEqual(["b"]);
    gesture.cancel();
    expect(pressed).toEqual([]);
  });

  it("a drag on empty canvas in select mode still selects by marquee", () => {
    drag([780, -20], [1200, 400], { shiftKey: true });
    expect(selected()).toEqual(["c"]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
  });

  it("a plain click on a member of a multi-selection keeps the selection; Shift takes it out", () => {
    click(100, 100);
    expect(selected()).toEqual(["a", "b"]);
    click(900, 100);
    expect(selected()).toEqual(["c"]);
    editor.clickNode("a", true);
    expect(selected()).toEqual(["a", "c"]);
    editor.clickNode("a", true);
    expect(selected()).toEqual(["c"]);
  });

  it("a marquee replaces the selection: over empty canvas it leaves none, across a connection it takes that one", () => {
    drag([2000, 2000], [2100, 2100], { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(selectedEdges()).toEqual([]);
    editor.selectNodes(["a", "b"], false);
    drag([500, 950], [600, 1050], { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(selectedEdges()).toEqual(["ac"]);
    expect(useWorkflowStore.getState().edgeMenuAnchor?.edgeId).toBe("ac");
  });

  it("Shift+click on a connection while nodes are selected changes nothing", () => {
    settings.onEdgeClick = vi.fn();
    edgeHit = 0;
    click(500, 1000, { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onEdgeClick).not.toHaveBeenCalled();
  });

  it("a click on a handle selects its node and opens the handle menu", () => {
    settings.onHandleClick = vi.fn();
    useWorkflowStore.getState().onEdgesChange([{ type: "select", id: "ac", selected: true }]);
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 100 }]]);
    click(1100, 100);
    expect(selected()).toEqual(["c"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onHandleClick).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "c", handleId: "text", type: "source" }));
  });

  it("a marquee that takes nodes frames them until a click", () => {
    drag([-20, -20], [750, 250], { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(frame().style.display).toBe("block");
    expect([frame().style.left, frame().style.top, frame().style.width, frame().style.height]).toEqual(["0px", "0px", "700px", "200px"]);
    expect(frame().style.transform).toBe(`translate(0px, 0px) scale(${editor["scene"].view.zoom})`);
    // Taking a node out of the selection reframes the rest.
    editor.selectNodes(["b"], true);
    expect(frame().style.display).toBe("block");
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }]);
    expect(frame().style.display).toBe("none");
    drag([-20, -20], [750, 250], { shiftKey: true });
    expect(frame().style.display).toBe("block");
    click(2000, 2000, { shiftKey: true });
    expect(frame().style.display).toBe("none");
  });

  it("a marquee across only a bundle's stem takes the connection that draws it", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    stems = [{ segment: [300, 1500, 320, 1500, 340, 1500, 360, 1500], width: 4 }];
    drag([310, 1450], [350, 1550], { shiftKey: true });
    expect(selectedEdges()).toEqual(["ac"]);
  });

  it("on a locked canvas a pane click keeps the selection and a connection click still moves its toolbar", () => {
    settings = { ...settings, locked: true, onEdgeClick: vi.fn() };
    click(2000, 2000);
    expect(selected()).toEqual(["a", "b"]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
    edgeHit = 0;
    click(500, 1000);
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onEdgeClick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "ac" }));
  });

  it("on a locked canvas a press on a node is the pane's: a click is a pane click, a drag pans", () => {
    settings = { ...settings, locked: true, navigation: { ...defaultCanvasNavigationSettings, panMode: "always" } };
    const moves: number[] = [];
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = () => ({ move: (e: PointerEvent) => moves.push(e.clientX), up: noop, cancel: noop });
    click(850, 100);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(["a", "b"]);
    drag([850, 100], [852, 100]);
    expect(moves).toEqual([852]);
    expect(useWorkflowStore.getState().nodes.find((n) => n.id === "c")!.position).toEqual({ x: 800, y: 0 });
  });

  it("empty canvas shows the pointer while a drag there would draw a marquee, following the selection key", () => {
    (editor["scene"] as unknown as Record<string, unknown>).setHoveredEdge = noop;
    const canvas = editor["scene"].canvas;
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "always" };
    editor.idleMove(pointer(2000, 2000) as PointerEvent);
    expect(canvas.style.cursor).toBe("grab");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    expect(canvas.style.cursor).toBe("pointer");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(canvas.style.cursor).toBe("grab");
    // Over a node the key leaves the node's cursor alone.
    editor.idleMove(pointer(850, 100) as PointerEvent);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    expect(canvas.style.cursor).toBe("grab");
  });

  it("empty canvas shows grab where a left drag pans (not in the tutorial or the middleMouse mode), grabbing while it pans", () => {
    (editor["scene"] as unknown as Record<string, unknown>).setHoveredEdge = noop;
    const canvas = editor["scene"].canvas;
    // Off a Mac the default "space" mode pans on the left button.
    editor.idleMove(pointer(2000, 2000) as PointerEvent);
    expect(canvas.style.cursor).toBe("grab");
    const gesture = editor.press(pointer(2000, 2000));
    expect(canvas.style.cursor).toBe("grabbing");
    gesture?.move(pointer(2010, 2000));
    gesture?.up(pointer(2010, 2000));
    expect(canvas.style.cursor).toBe("grab");
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    editor.idleMove(pointer(2000, 2000) as PointerEvent);
    expect(canvas.style.cursor).toBe("");
    settings = { ...settings, tutorial: true, navigation: { ...defaultCanvasNavigationSettings, panMode: "always" } };
    editor.idleMove(pointer(2000, 2000) as PointerEvent);
    expect(canvas.style.cursor).toBe("");
  });

  it("a node shows grab, and grabbing on the canvas and live nodes while a drag moves it; the arrow under a dialog", () => {
    (editor["scene"] as unknown as Record<string, unknown>).setHoveredEdge = noop;
    const canvas = editor["scene"].canvas, liveElement = editor["live"].element;
    editor.idleMove(pointer(850, 100) as PointerEvent);
    expect(canvas.style.cursor).toBe("grab");
    const gesture = editor.press(pointer(850, 100));
    gesture?.move(pointer(870, 100));
    expect(canvas.style.cursor).toBe("grabbing");
    expect(liveElement.hasAttribute("data-gpu-dragging")).toBe(true);
    gesture?.up(pointer(870, 100));
    expect(canvas.style.cursor).toBe("grab");
    expect(liveElement.hasAttribute("data-gpu-dragging")).toBe(false);
    settings.disabled = true;
    editor.idleMove(pointer(850, 100) as PointerEvent);
    expect(canvas.style.cursor).toBe("");
  });

  it("the connection under the pointer is the live connections' hovered one, until the pointer leaves the canvas", () => {
    (editor["scene"] as unknown as Record<string, unknown>).setHoveredEdge = noop;
    edgeHit = 0;
    editor.idleMove(pointer(600, 1000) as PointerEvent);
    expect(useEdgeHoverStore.getState().edgeId).toBe("ac");
    editor["scene"].canvas.dispatchEvent(new MouseEvent("pointerleave"));
    expect(useEdgeHoverStore.getState().edgeId).toBe(null);
    editor.idleMove(pointer(600, 1000) as PointerEvent);
    edgeHit = -1;
    editor.idleMove(pointer(2000, 2000) as PointerEvent);
    expect(useEdgeHoverStore.getState().edgeId).toBe(null);
  });

  it("with the selection key held a drag from a handle draws a marquee; without it, it starts a connection", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 200 }]]);
    settings.onConnectEnd = vi.fn();
    // From the handle at the card's corner back across the card.
    drag([1100, 200], [780, -20], { shiftKey: true });
    expect(settings.onConnectEnd).not.toHaveBeenCalled();
    expect(selected()).toEqual(["c"]);
    // jsdom has no hit testing: nothing under the dropped wire.
    document.elementsFromPoint ??= () => [];
    drag([1100, 200], [1300, 300]);
    expect(settings.onConnectEnd).toHaveBeenCalledTimes(1);
  });

  it("with the selection key held a click on a socket's half outside its node's box is a click on that node", () => {
    editor["scene"].graph.nodes[2].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    // Shift adds node c to a and b; no connection is selected and the pane is not clicked.
    click(796, 100, { shiftKey: true });
    expect(selected()).toEqual(["a", "b", "c"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
    // The same with a connection ending there: the socket's node, not the connection.
    edgeHit = 0;
    click(796, 100, { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
  });

  it("a live socket takes the pointer again (React Flow's connectionindicator), hidden ones still do not", () => {
    expect(LIVE_STYLE).toMatch(/\.react-flow__handle\.connectable \{ pointer-events: all;/);
  });

  it("a marquee's start stays on the same canvas spot when the view pans under it", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    let panX = 0;
    const listeners = new Set<() => void>();
    Object.assign(scene, {
      toWorld: (x: number, y: number) => ({ x: x - panX, y }),
      toScreen: (x: number, y: number) => ({ x: x + panX, y }),
      onViewChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    // Around "a" only.
    const gesture = editor.press(pointer(-20, -20, { shiftKey: true }))!;
    gesture.move(pointer(320, 250, { shiftKey: true }));
    expect(selected()).toEqual(["a"]);
    // The view pans 500px left: the box now reaches past "b", its start still left of "a".
    panX = -500;
    for (const listener of listeners) listener();
    expect(selected()).toEqual(["a", "b"]);
    gesture.up(pointer(320, 250, { shiftKey: true }));
    expect(listeners.size).toBe(0);
  });

  it("a right-click on a painted handle is not the pane's: no add-node menu, the browser's own menu", () => {
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 100 }]]);
    const event = new MouseEvent("contextmenu", { clientX: 1102, clientY: 100, cancelable: true });
    editor.contextMenu(event);
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a right-click on a connection opens its menu in the middleMouse pan mode; on the pane it shows no menu", () => {
    settings = { ...settings, navigation: { ...settings.navigation, panMode: "middleMouse" }, onEdgeContextMenu: vi.fn() };
    edgeHit = 0;
    editor.contextMenu(new MouseEvent("contextmenu", { clientX: 2000, clientY: 2000, cancelable: true }));
    expect(settings.onEdgeContextMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "ac" }));
    edgeHit = -1;
    const pane = new MouseEvent("contextmenu", { clientX: 2000, clientY: 2000, cancelable: true });
    editor.contextMenu(pane);
    expect(pane.defaultPrevented).toBe(true);
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
  });

  it("under a dialog a right-click on the pane shows neither menu", () => {
    settings = { ...settings, disabled: true };
    const pane = new MouseEvent("contextmenu", { clientX: 2000, clientY: 2000, cancelable: true });
    editor.contextMenu(pane);
    expect(pane.defaultPrevented).toBe(true);
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
  });

  it("on a locked canvas a right-click on a node's body is the pane's, but not on its header band or a painted handle", () => {
    settings = { ...settings, locked: true };
    withHeaderBands();
    const body = new MouseEvent("contextmenu", { clientX: 100, clientY: 100, cancelable: true });
    editor.contextMenu(body);
    expect(body.defaultPrevented).toBe(true);
    expect(settings.onPaneMenu).toHaveBeenCalledWith(100, 100);
    const header = new MouseEvent("contextmenu", { clientX: 100, clientY: -10, cancelable: true });
    editor.contextMenu(header);
    expect(header.defaultPrevented).toBe(false);
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 100 }]]);
    const handle = new MouseEvent("contextmenu", { clientX: 1102, clientY: 100, cancelable: true });
    editor.contextMenu(handle);
    expect(handle.defaultPrevented).toBe(false);
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
    // Unlocked, the node's body is its own.
    settings = { ...settings, locked: false };
    const unlocked = new MouseEvent("contextmenu", { clientX: 100, clientY: 100, cancelable: true });
    editor.contextMenu(unlocked);
    expect(unlocked.defaultPrevented).toBe(false);
    expect(settings.onPaneMenu).toHaveBeenCalledTimes(1);
  });

  it("a double-click on a node's body is the pane's only on a locked canvas, and never on its header band", () => {
    withHeaderBands();
    expect(editor.nodeIsPane(100, 100)).toBe(false);
    settings = { ...settings, locked: true };
    expect(editor.nodeIsPane(100, 100)).toBe(true);
    expect(editor.nodeIsPane(100, -10)).toBe(false);
    expect(editor.nodeIsPane(2000, 2000)).toBe(true);
    editor.paneDoubleClick(100, 100, { x: 1, y: 1 });
    expect(settings.onPaneMenu).toHaveBeenCalledWith(1, 1);
  });

  it("a double-click opens the add-node menu on empty canvas only, not on a connection", () => {
    edgeHit = 0;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
    edgeHit = -1;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).toHaveBeenCalledWith(1, 1);
  });
});

describe("connection ends on the GPU canvas", () => {
  beforeEach(() => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    const nodes = editor["scene"].graph.nodes;
    nodes[0].handles = new Map([["source:text", { x: 300, y: 100, position: "right" }]]);
    nodes[1].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    nodes[2].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    // jsdom has no hit testing: no live handle under the pointer.
    document.elementsFromPoint ??= () => [];
  });

  it("a drag from a connection's end moves that end to another handle, the connection hidden meanwhile", () => {
    settings.onReconnect = vi.fn();
    const held: number[] = [];
    (editor["scene"] as unknown as Record<string, unknown>).setHeldEdge = (e: number) => held.push(e);
    // c's input is at x = 800; its reconnect anchor is 10 to the left of it.
    drag([788, 100], [400, 100]);
    expect(settings.onReconnect).toHaveBeenCalledWith(expect.objectContaining({ id: "ac" }), { source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
    expect(held).toEqual([0, -1]);
  });

  it("on a locked canvas a connection's end still reconnects, drawing no line", () => {
    settings = { ...settings, locked: true, onReconnect: vi.fn() };
    const gesture = editor.press(pointer(788, 100))!;
    gesture.move(pointer(500, 100));
    expect(host.querySelector("path")).toBeNull();
    gesture.move(pointer(400, 100));
    gesture.up(pointer(400, 100));
    expect(settings.onReconnect).toHaveBeenCalledWith(expect.objectContaining({ id: "ac" }), { source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
  });

  it("a click on a connection's end selects the connection; dropped on nothing it goes to handleConnectEnd from the other end", () => {
    settings.onConnectEnd = vi.fn();
    click(788, 100);
    expect(selectedEdges()).toEqual(["ac"]);
    drag([788, 100], [2000, 2000]);
    expect(settings.onConnectEnd).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromHandle: { id: "text", type: "source" } }), null);
  });

  it("a wire dropped on a socket just outside a node's box names that node", () => {
    settings.onConnectEnd = vi.fn();
    // The image wire is refused at the socket, so the drop falls to handleConnectEnd.
    settings.isValidConnection = () => false;
    drag([300, 100], [795, 100]);
    expect(settings.onConnectEnd).toHaveBeenCalledWith(expect.anything(), expect.anything(), "c");
  });

  it("on a locked canvas a wire released on a node's body names no node (the add-node menu); on its socket it does", () => {
    settings = { ...settings, locked: true, onConnectEnd: vi.fn(), isValidConnection: () => false };
    drag([300, 100], [600, 100]);
    expect(settings.onConnectEnd).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), null);
    drag([300, 100], [795, 100]);
    expect(settings.onConnectEnd).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "c");
    // Unlocked, the body names its node.
    settings = { ...settings, locked: false };
    drag([300, 100], [600, 100]);
    expect(settings.onConnectEnd).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "b");
  });

  it("on a locked canvas a socket still connects, drawing no line, and the pressed socket's ghosts drop", () => {
    settings = { ...settings, locked: true, onConnect: vi.fn() };
    useWorkflowStore.getState().setHoveredHandle({ nodeId: "a", handleId: "text", type: "source" });
    const gesture = editor.press(pointer(300, 100))!;
    gesture.move(pointer(500, 100));
    expect(host.querySelector("path")).toBeNull();
    expect(useWorkflowStore.getState().hoveredHandle).toBeNull();
    gesture.move(pointer(398, 100));
    gesture.up(pointer(398, 100));
    expect(settings.onConnect).toHaveBeenCalledWith({ source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
  });

  it("a node on top covers the sockets of a node under it: a press there takes the top node", () => {
    settings.onConnectEnd = vi.fn();
    const graph = editor["scene"].graph;
    // b moved over a's output socket (b is drawn above a).
    graph.nodes[1].x = 250;
    (editor["scene"] as unknown as Record<string, unknown>).nodeAt = (x: number, y: number) => (x >= 250 && x <= 550 && y >= 0 && y <= 200 ? 1 : -1);
    drag([300, 100], [320, 100]);
    expect(settings.onConnectEnd).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().nodes.find((n) => n.id === "b")?.position.x).not.toBe(400);
  });

  it("a wire released within 4px of its press is a click on the handle: its menu, not the add-node menu", () => {
    settings.onConnectEnd = vi.fn();
    settings.onHandleClick = vi.fn();
    const gesture = editor.press(pointer(300, 100))!;
    // The line shows after a pixel of travel.
    gesture.move(pointer(302, 100));
    expect(host.querySelector("path")).not.toBeNull();
    gesture.move(pointer(380, 100));
    gesture.move(pointer(303, 100));
    gesture.up(pointer(303, 100));
    expect(host.querySelector("path")).toBeNull();
    expect(settings.onConnectEnd).not.toHaveBeenCalled();
    expect(settings.onHandleClick).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "a", handleId: "text", type: "source" }));
  });

  it("the line follows its socket when the view moves mid-drag", () => {
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    let panX = 0;
    const listeners = new Set<() => void>();
    Object.assign(scene, {
      toScreen: (x: number, y: number) => ({ x: x + panX, y }),
      toWorld: (x: number, y: number) => ({ x: x - panX, y }),
      onViewChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    const gesture = editor.press(pointer(300, 100))!;
    gesture.move(pointer(1500, 600));
    const d = () => host.querySelector("path")!.getAttribute("d")!;
    expect(d().startsWith("M300,100") || d().startsWith("M 300")).toBe(true);
    panX = -100;
    for (const listener of listeners) listener();
    expect(d().startsWith("M200,100") || d().startsWith("M 200")).toBe(true);
    gesture.up(pointer(1500, 600));
    expect(listeners.size).toBe(0);
  });

  it("a connection holds its nodes by id: a node added mid-drag does not change what it connects", () => {
    settings.onConnect = vi.fn();
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    const gesture = editor.press(pointer(300, 100))!;
    gesture.move(pointer(398, 100));
    // A node inserted first renumbers the graph.
    const nodes = [node("z", 5000, 5000), ...useWorkflowStore.getState().nodes];
    useWorkflowStore.setState({ nodes });
    const graph = new SceneGraph(nodes, useWorkflowStore.getState().edges, {});
    graph.nodes[1].handles = new Map([["source:text", { x: 300, y: 100, position: "right" }]]);
    graph.nodes[2].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    const index = new GridIndex(graph.nodes);
    Object.assign(scene, { graph, nodeAt: (x: number, y: number) => index.at(x, y), nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1) });
    gesture.move(pointer(399, 100));
    gesture.up(pointer(399, 100));
    expect(settings.onConnect).toHaveBeenCalledWith({ source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
  });

  it("the line, the marquee and the selection frame sit in the live flow, under its panels", () => {
    const flow = document.createElement("div");
    flow.innerHTML = '<div class="react-flow"><div class="react-flow__renderer"><div class="react-flow__viewport"></div></div><div class="react-flow__panel"></div></div>';
    host.appendChild(flow);
    (editor["live"] as unknown as { element: HTMLElement }).element = flow;
    const wrapper = flow.querySelector(".react-flow")!, viewport = flow.querySelector(".react-flow__viewport")!;
    const gesture = editor.press(pointer(300, 100))!;
    gesture.move(pointer(500, 100));
    const line = viewport.querySelector("svg")!;
    expect(line.querySelector("path")).not.toBeNull();
    expect(line.style.zIndex).toBe("1001");
    gesture.up(pointer(500, 100));
    drag([-20, -20], [750, 250], { shiftKey: true });
    expect(wrapper.querySelector("[data-gpu-canvas-marquee]")?.parentElement).toBe(wrapper);
    expect(wrapper.querySelector<HTMLElement>("[data-gpu-canvas-selection-frame]")?.style.display).toBe("block");
  });
});

describe("node drags on the GPU canvas", () => {
  const position = (id: string) => useWorkflowStore.getState().nodes.find((n) => n.id === id)!.position;
  const sceneNode = (id: string) => editor["scene"].graph.nodes[editor["scene"].graph.indexOf.get(id)!];

  it("starts from where the pointer is once past the threshold: no jump", () => {
    const gesture = editor.press(pointer(900, 100))!;
    gesture.move(pointer(906, 100));
    expect(sceneNode("c").x).toBe(800);
    gesture.move(pointer(916, 103));
    gesture.up(pointer(916, 103));
    expect(position("c")).toEqual({ x: 810, y: 3 });
  });

  it("an unselected node clears the selection and moves alone; a selected one carries the selection", () => {
    useWorkflowStore.getState().onEdgesChange([{ type: "select", id: "ac", selected: true }]);
    drag([900, 100], [920, 100]);
    expect(selected()).toEqual([]);
    expect(selectedEdges()).toEqual([]);
    expect([position("a").x, position("b").x, position("c").x]).toEqual([0, 400, 800]);
    editor.selectNodes(["a", "b"], false);
    const gesture = editor.press(pointer(100, 100))!;
    gesture.move(pointer(110, 100));
    gesture.move(pointer(130, 100));
    gesture.up(pointer(130, 100));
    expect([position("a").x, position("b").x, position("c").x]).toEqual([20, 420, 800]);
  });

  it("Shift (when it is not the selection key) drags an unselected node with the selection", () => {
    settings.navigation = { ...defaultCanvasNavigationSettings, selectionMode: "altDrag" };
    const gesture = editor.press(pointer(900, 100, { shiftKey: true }))!;
    gesture.move(pointer(910, 100, { shiftKey: true }));
    gesture.move(pointer(930, 100, { shiftKey: true }));
    gesture.up(pointer(930, 100, { shiftKey: true }));
    expect(selected()).toEqual(["a", "b"]);
    expect([position("a").x, position("b").x, position("c").x]).toEqual([20, 420, 820]);
  });

  it("with Space held a press on a node drags it and one on a handle connects; only empty canvas pans", () => {
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "space" };
    settings.onConnect = vi.fn();
    document.elementsFromPoint ??= () => [];
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    const pan = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    scene.panGesture = pan;
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
    const gesture = editor.press(pointer(900, 100))!;
    gesture.move(pointer(910, 100));
    gesture.move(pointer(930, 100));
    gesture.up(pointer(930, 100));
    expect(position("c").x).toBe(820);
    editor["scene"].graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 100, position: "right" }]]);
    editor["scene"].graph.nodes[1].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    drag([300, 100], [400, 100]);
    expect(settings.onConnect).toHaveBeenCalledWith({ source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
    expect(pan).not.toHaveBeenCalled();
    drag([2000, 2000], [2100, 2000]);
    expect(pan).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " }));
  });

  it("a store write to a dragged node mid-drag leaves it where the drag holds it", () => {
    const gesture = editor.press(pointer(900, 100))!;
    gesture.move(pointer(910, 100));
    gesture.move(pointer(950, 100));
    const graph = editor["scene"].graph;
    // A run's status reaches the store with the position of the drag's first move.
    const nodes = useWorkflowStore.getState().nodes.map((n) => n.id === "c" ? { ...n, position: { x: 800, y: 0 }, data: { prompt: "running" } } : n) as WorkflowNode[];
    graph.updateNodes(nodes, ["c"]);
    expect(sceneNode("c").x).toBe(840);
    graph.sync([node("z", 5000, 5000), ...nodes], useWorkflowStore.getState().edges, {});
    expect(sceneNode("c").x).toBe(840);
    gesture.up(pointer(950, 100));
    expect(position("c").x).toBe(840);
    expect(graph.hold).toBeNull();
  });

  it("near the canvas's edge the view pans every frame and the dragged node moves with it", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const scene = editor["scene"] as unknown as { view: { x: number; y: number; zoom: number }; canvas: HTMLCanvasElement } & Record<string, unknown>;
      Object.defineProperty(scene.canvas, "clientWidth", { value: 1200 });
      Object.defineProperty(scene.canvas, "clientHeight", { value: 800 });
      Object.assign(scene, {
        toWorld: (x: number, y: number) => ({ x: x - scene.view.x, y: y - scene.view.y }),
        setView: (view: { x: number; y: number }) => Object.assign(scene.view, view),
      });
      const gesture = editor.press(pointer(900, 100))!;
      gesture.move(pointer(910, 100));
      gesture.move(pointer(1200, 100));
      expect(sceneNode("c").x).toBe(1090);
      vi.advanceTimersToNextFrame();
      expect(scene.view.x).toBe(-15);
      expect(sceneNode("c").x).toBe(1105);
      gesture.up(pointer(1200, 100));
      vi.advanceTimersToNextFrame();
      expect(scene.view.x).toBe(-15);
      expect(position("c").x).toBe(1105);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a floating header's drag on the GPU canvas", () => {
  const position = (id: string) => useWorkflowStore.getState().nodes.find((n) => n.id === id)!.position;
  beforeEach(() => {
    // Node c's header band, 30 flow units above it (the scene's index files it; the test's does not).
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    const nodeAt = scene.nodeAt as (x: number, y: number) => number;
    scene.nodeAt = (x: number, y: number) => (y < 0 && y >= -30 && x >= 800 && x < 1100 ? 2 : nodeAt(x, y));
  });

  it("does not pan the view near the canvas's edge, as FloatingNodeHeader's own drag", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const scene = editor["scene"] as unknown as { view: { x: number; y: number; zoom: number }; canvas: HTMLCanvasElement } & Record<string, unknown>;
      Object.defineProperty(scene.canvas, "clientWidth", { value: 1200 });
      Object.defineProperty(scene.canvas, "clientHeight", { value: 800 });
      scene.setView = (view: { x: number; y: number }) => Object.assign(scene.view, view);
      const gesture = editor.press(pointer(900, -10))!;
      gesture.move(pointer(1195, -10));
      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();
      expect(scene.view).toEqual({ x: 0, y: 0, zoom: 1 });
      gesture.up(pointer(1195, -10));
      expect(position("c").x).toBe(1095);
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects an unselected node on the press, whatever the keys but the selection key, and moves it alone past 5px on an axis", () => {
    const stops: string[] = [];
    settings.onNodeDragStop = (_event, node) => stops.push(node.id);
    useWorkflowStore.getState().onEdgesChange([{ type: "select", id: "ac", selected: true }]);
    const gesture = editor.press(pointer(900, -10, { altKey: true, ctrlKey: true }))!;
    expect(selected()).toEqual(["c"]);
    expect(selectedEdges()).toEqual([]);
    // 4px on each axis: not yet a drag (FloatingNodeHeader's per-axis threshold).
    gesture.move(pointer(904, -6, { altKey: true, ctrlKey: true }));
    expect(position("c")).toEqual({ x: 800, y: 0 });
    gesture.move(pointer(920, -10, { altKey: true, ctrlKey: true }));
    gesture.up(pointer(920, -10, { altKey: true, ctrlKey: true }));
    // Measured from the press, as the header's drag is.
    expect([position("a").x, position("b").x, position("c").x]).toEqual([0, 400, 820]);
    expect(selected()).toEqual(["c"]);
    expect(stops).toEqual(["c"]);
  });

  it("an already selected node carries the selection, and every moved node is regrouped", () => {
    const stops: string[] = [];
    settings.onNodeDragStop = (_event, node) => stops.push(node.id);
    editor.selectNodes(["a", "b", "c"], false);
    const gesture = editor.press(pointer(900, -10))!;
    gesture.move(pointer(930, -10));
    gesture.up(pointer(930, -10));
    expect([position("a").x, position("b").x, position("c").x]).toEqual([30, 430, 830]);
    expect(stops.sort()).toEqual(["a", "b", "c"]);
  });

  it("on a locked canvas the header still selects and moves its node, while a press on the body is the pane's", () => {
    settings.locked = true;
    const stops: string[] = [];
    settings.onNodeDragStop = (_event, node) => stops.push(node.id);
    const gesture = editor.press(pointer(900, -10))!;
    expect(selected()).toEqual(["c"]);
    gesture.move(pointer(920, -10));
    gesture.up(pointer(920, -10));
    expect([position("a").x, position("b").x, position("c").x]).toEqual([0, 400, 820]);
    expect(stops).toEqual(["c"]);
    // Already selected, with the others: the header carries the selection.
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
    const again = editor.press(pointer(900, -10))!;
    again.move(pointer(910, -10));
    again.up(pointer(910, -10));
    expect([position("a").x, position("c").x]).toEqual([10, 830]);
    click(900, 100);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(["a", "c"]);
  });

  it("a click changes nothing past the press's selection", () => {
    click(900, -10);
    expect(selected()).toEqual(["c"]);
    click(900, -10, { shiftKey: true });
    expect(selected()).toEqual(["c"]);
  });
});

describe("presses on a connection (React Flow's nopan)", () => {
  const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
  beforeEach(() => {
    panGesture.mockClear();
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    edgeHit = 0;
  });

  it.each([
    ["the always pan mode", { panMode: "always" as const }, {}],
    ["Space held in the space mode", { panMode: "space" as const }, { space: true }],
  ])("a left drag from a connection pans nothing in %s; a release still on it clicks it", (_name, navigation, flags) => {
    settings.navigation = { ...defaultCanvasNavigationSettings, ...navigation };
    (editor as unknown as { space: boolean }).space = "space" in flags;
    drag([500, 1000], [520, 1000]);
    expect(panGesture).not.toHaveBeenCalled();
    expect(selectedEdges()).toEqual(["ac"]);
  });

  it("a drag that ends off the connection does nothing", () => {
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "always" };
    const gesture = editor.press(pointer(500, 1000))!;
    edgeHit = -1;
    gesture.move(pointer(500, 1100));
    gesture.up(pointer(500, 1100));
    expect(panGesture).not.toHaveBeenCalled();
    expect(selectedEdges()).toEqual([]);
  });

  it("on a locked canvas a left drag from a connection pans nothing either", () => {
    settings = { ...settings, locked: true, onEdgeClick: vi.fn(), navigation: { ...defaultCanvasNavigationSettings, panMode: "always" } };
    drag([500, 1000], [530, 1000]);
    expect(panGesture).not.toHaveBeenCalled();
    expect(settings.onEdgeClick).toHaveBeenCalledTimes(1);
  });
});

describe("canvas-interacting during a node drag", () => {
  it("is held for the whole drag, and the canvas hears when it is let go", () => {
    const ended = vi.fn();
    editor.onInteractingEnd = ended;
    const classes = document.documentElement.classList;
    const gesture = editor.press(pointer(900, 100))!;
    gesture.move(pointer(920, 100));
    expect(editor.holdsInteracting).toBe(true);
    expect(classes.contains("canvas-interacting")).toBe(true);
    gesture.up(pointer(920, 100));
    expect(editor.holdsInteracting).toBe(false);
    expect(classes.contains("canvas-interacting")).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe("pressGoesToScene", () => {
  it("sends a node's body, buttons and handles to the scene, and keeps its fields and .nodrag", () => {
    document.body.innerHTML = `<div class="react-flow__node"><div id="body"><button id="button"><span id="label"></span></button><a id="link"></a><button class="nodrag" id="kept"></button><div class="react-flow__handle nodrag" id="handle"></div><textarea id="field"></textarea></div></div>`;
    const at = (id: string) => document.getElementById(id)!;
    expect(pressGoesToScene(at("body"))).toBe(true);
    expect(pressGoesToScene(at("handle"))).toBe(true);
    expect(pressGoesToScene(at("label"))).toBe(true);
    expect(pressGoesToScene(at("link"))).toBe(true);
    expect(pressGoesToScene(at("kept"))).toBe(false);
    expect(pressGoesToScene(at("field"))).toBe(false);
  });

  it("keeps a floating header's buttons and links for the header", () => {
    document.body.innerHTML = `<div data-node-header="a"><span id="title"></span><button id="button"></button><a id="link"></a></div>`;
    const at = (id: string) => document.getElementById(id)!;
    expect(pressGoesToScene(at("title"))).toBe(true);
    expect(pressGoesToScene(at("button"))).toBe(false);
    expect(pressGoesToScene(at("link"))).toBe(false);
  });

  it("sends a right press on a floating header's button to the scene unless it is nopan", () => {
    document.body.innerHTML = `<div data-node-header="a"><button id="run"></button><button class="nodrag nopan" id="menu"></button></div><div class="react-flow__node"><button id="inner"></button></div>`;
    const press = (id: string, button = 2) => ({ button, target: document.getElementById(id) });
    expect(rightPressPansFromHeader(press("run"))).toBe(true);
    expect(rightPressPansFromHeader(press("run", 0))).toBe(false);
    expect(rightPressPansFromHeader(press("menu"))).toBe(false);
    expect(rightPressPansFromHeader(press("inner"))).toBe(false);
  });
});

describe("presses held through a rebuilt graph", () => {
  /** Renumbers the scene's graph as GpuCanvas's sync does: a node (and a connection) added ahead of the rest. */
  function rebuild() {
    const state = useWorkflowStore.getState();
    const nodes = [node("z", 0, 600), ...state.nodes];
    const edges = [{ id: "ab", source: "a", target: "b", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge, ...state.edges];
    useWorkflowStore.setState({ nodes, edges });
    (editor["scene"] as unknown as Record<string, unknown>).graph = new SceneGraph(nodes, edges, {});
  }
  const position = (id: string) => useWorkflowStore.getState().nodes.find((n) => n.id === id)!.position;

  it("a drag that starts after the rebuild moves the pressed node", () => {
    const gesture = editor.press(pointer(900, 100))!;
    rebuild();
    // The drag starts past its threshold, from where the pointer is then.
    gesture.move(pointer(910, 100));
    gesture.move(pointer(1010, 150));
    gesture.up(pointer(1010, 150));
    expect(position("c")).toEqual({ x: 900, y: 50 });
    expect(position("b")).toEqual({ x: 400, y: 0 });
  });

  it("a selection-key click released after the rebuild takes the pressed node", () => {
    const gesture = editor.press(pointer(900, 100, { shiftKey: true }))!;
    rebuild();
    gesture.up(pointer(900, 100, { shiftKey: true }));
    expect(selected().sort()).toEqual(["a", "b", "c"]);
  });

  it("a connection click released after the rebuild selects the pressed connection", () => {
    settings.onEdgeClick = vi.fn();
    edgeHit = 0;
    const gesture = editor.press(pointer(500, 1000))!;
    rebuild();
    // The release is still on that connection, renumbered behind the added one.
    edgeHit = 1;
    gesture.up(pointer(500, 1000));
    expect(selectedEdges()).toEqual(["ac"]);
    expect(settings.onEdgeClick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "ac" }));
  });
});

describe("a click on a live node's socket", () => {
  function livePress(x: number, y: number, handle: HTMLElement) {
    const event = pointer(x, y);
    Object.defineProperty(event, "target", { value: handle });
    return event;
  }

  it("that moves a little opens the handle menu from the editor (the capture took the native click); a still one leaves it to the click", () => {
    document.elementsFromPoint ??= () => [];
    settings.onHandleClick = vi.fn();
    const live = editor["live"].element;
    live.setAttribute("data-gpu-canvas-live", "");
    document.body.appendChild(live);
    const handle = document.createElement("div");
    handle.className = "react-flow__handle source connectable connectableend";
    handle.dataset.nodeid = "c";
    handle.dataset.handleid = "text";
    handle.getBoundingClientRect = () => ({ left: 1095, top: 95, width: 10, height: 10, right: 1105, bottom: 105, x: 1095, y: 95, toJSON: noop });
    live.appendChild(handle);
    let gesture = editor.press(livePress(1100, 100, handle))!;
    gesture.up(pointer(1100, 100));
    expect(settings.onHandleClick).not.toHaveBeenCalled();
    gesture = editor.press(livePress(1100, 100, handle))!;
    gesture.move(pointer(1103, 100));
    gesture.up(pointer(1103, 100));
    expect(settings.onHandleClick).toHaveBeenCalledTimes(1);
    expect(settings.onHandleClick).toHaveBeenCalledWith({ nodeId: "c", handleId: "text", type: "source", position: { x: 1100, y: 100 } });
    live.remove();
  });
});

describe("a still press on a live node's button", () => {
  function liveNodeWith(child: HTMLElement) {
    const live = editor["live"].element;
    live.setAttribute("data-gpu-canvas-live", "");
    document.body.appendChild(live);
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node";
    wrapper.dataset.id = "c";
    wrapper.appendChild(child);
    live.appendChild(wrapper);
    return live;
  }

  function pressOn(target: Element, x: number, y: number) {
    const event = pointer(x, y);
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  it("leaves the selection to the node's own click (which the button may stop); its body still selects", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    const live = liveNodeWith(button);
    expect(liveButtonPress(icon)).toBe(true);
    let gesture = editor.press(pressOn(icon, 900, 100))!;
    gesture.up(pointer(900, 100));
    expect(selected()).toEqual(["a", "b"]);
    const body = button.parentElement!;
    expect(liveButtonPress(body)).toBe(false);
    gesture = editor.press(pressOn(body, 900, 100))!;
    gesture.up(pointer(900, 100));
    expect(selected()).toEqual(["c"]);
    live.remove();
  });

  it("with Shift held leaves the toggle to the node's own click, so it toggles once", () => {
    const button = document.createElement("button");
    const live = liveNodeWith(button);
    const clickNode = vi.spyOn(editor as unknown as { clickNode: (id: string, additive: boolean) => void }, "clickNode");
    const event = pressOn(button, 900, 100);
    Object.defineProperty(event, "shiftKey", { value: true });
    const gesture = editor.press(event)!;
    gesture.up(pointer(900, 100, { shiftKey: true }));
    expect(clickNode).not.toHaveBeenCalled();
    expect(selected()).toEqual(["a", "b"]);
    // Its body still toggles from the scene.
    const body = button.parentElement!;
    const onBody = pressOn(body, 900, 100);
    Object.defineProperty(onBody, "shiftKey", { value: true });
    editor.press(onBody)!.up(pointer(900, 100, { shiftKey: true }));
    expect(clickNode).toHaveBeenCalledTimes(1);
    live.remove();
  });

  it("is not a button press on a .nodrag button, a handle, or a button outside a node", () => {
    const nodrag = document.createElement("button");
    nodrag.className = "nodrag";
    const live = liveNodeWith(nodrag);
    expect(liveButtonPress(nodrag)).toBe(false);
    const loose = document.createElement("button");
    expect(liveButtonPress(loose)).toBe(false);
    live.remove();
  });
});

describe("the GPU canvas against classic's pane and zoom pane", () => {
  /** The live layer's root, with React Flow's pane in it, and an element built from `html` inside the pane. */
  function liveElement(html: string, id: string) {
    const live = editor["live"].element;
    live.setAttribute("data-gpu-canvas-live", "");
    live.innerHTML = `<div class="react-flow__pane">${html}</div>`;
    document.body.appendChild(live);
    return live.querySelector<HTMLElement>(`#${id}`)!;
  }
  function on(target: Element, x: number, y: number, init: MouseEventInit = {}) {
    const event = pointer(x, y, init);
    Object.defineProperty(event, "target", { value: target });
    return event;
  }
  afterEach(() => editor["live"].element.remove());

  it("a click on a connection reads Shift and its point at the release, as the browser's click", () => {
    settings.onEdgeClick = vi.fn();
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    edgeHit = 0;
    const gesture = editor.press(pointer(500, 1000))!;
    gesture.up(pointer(700, 1000, { shiftKey: true }));
    expect(settings.onEdgeClick).toHaveBeenCalledWith(expect.objectContaining({ clientX: 700, clientY: 1000, shiftKey: true }), expect.objectContaining({ id: "ac" }));
  });

  it("hands the editor every left press with the selection key held inside the pane, except .nokey ones", () => {
    const field = liveElement(`<div class="react-flow__node"><textarea id="field"></textarea></div><div class="nokey"><input id="kept"></div><div class="edge-overlay"><span id="label"></span></div>`, "field");
    const keyActive = (event: PointerEvent) => editor["selectionKeyTakes"](event);
    const label = document.getElementById("label")!, kept = document.getElementById("kept")!;
    expect(selectionKeyTakesPress(on(field, 100, 100, { shiftKey: true }), keyActive)).toBe(true);
    expect(selectionKeyTakesPress(on(label, 100, 100, { shiftKey: true }), keyActive)).toBe(true);
    expect(selectionKeyTakesPress(on(kept, 100, 100, { shiftKey: true }), keyActive)).toBe(false);
    expect(selectionKeyTakesPress(on(field, 100, 100), keyActive)).toBe(false);
    // Alt is the key only in the "altDrag" mode.
    expect(selectionKeyTakesPress(on(field, 100, 100, { altKey: true }), keyActive)).toBe(false);
    settings.navigation = { ...defaultCanvasNavigationSettings, selectionMode: "altDrag" };
    expect(selectionKeyTakesPress(on(field, 100, 100, { altKey: true }), keyActive)).toBe(true);
    // Not under a dialog, nor on a locked canvas (React Flow's elementsSelectable off).
    settings.disabled = true;
    expect(selectionKeyTakesPress(on(field, 100, 100, { altKey: true }), keyActive)).toBe(false);
    settings.disabled = false;
    settings.locked = true;
    expect(selectionKeyTakesPress(on(field, 100, 100, { altKey: true }), keyActive)).toBe(false);
  });

  it("with Shift held, a live node's field selects only through the node's click, and a drag from it draws a marquee", () => {
    const field = liveElement(`<div class="react-flow__node" data-id="c"><textarea id="field"></textarea></div>`, "field");
    let gesture = editor.press(on(field, 900, 100, { shiftKey: true }))!;
    gesture.up(on(field, 900, 100, { shiftKey: true }));
    // LiveFlow's nodeClick (React Flow's NodeWrapper click on classic) does the toggling: the scene leaves it.
    expect(selected()).toEqual(["a", "b"]);
    gesture = editor.press(on(field, 780, -20, { shiftKey: true }))!;
    gesture.move(on(field, 1200, 400, { shiftKey: true }));
    gesture.up(on(field, 1200, 400, { shiftKey: true }));
    expect(selected()).toEqual(["c"]);
  });

  it("with Shift held, a floating header (live or painted) or a connection's label selects nothing on a click and draws a marquee on a drag", () => {
    withHeaderBands();
    const header = liveElement(`<div data-node-header="c"><button id="header"></button></div><div class="edge-overlay"><span id="label"></span></div>`, "header");
    const label = document.getElementById("label")!;
    edgeHit = 0;
    for (const target of [header, label]) {
      const gesture = editor.press(on(target, 900, -10, { shiftKey: true }))!;
      gesture.up(on(target, 900, -10, { shiftKey: true }));
    }
    // The painted header band.
    click(900, -10, { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
    const gesture = editor.press(on(header, 380, -20, { shiftKey: true }))!;
    gesture.move(on(header, 1200, 400, { shiftKey: true }));
    gesture.up(on(header, 1200, 400, { shiftKey: true }));
    expect(selected()).toEqual(["b", "c"]);
    // Without the key the header still drags its node.
    expect(editor.press(on(header, 900, -10))).not.toBeNull();
  });

  it("a group's title or grip pans wherever classic's zoom pane would take the press", () => {
    const panGesture = vi.fn(() => ({ move: noop, up: noop, cancel: noop }));
    (editor["scene"] as unknown as Record<string, unknown>).panGesture = panGesture;
    const title = liveElement(`<div class="group-controls-overlay"><div data-group-label="g"><span id="title"></span><input class="nopan" id="rename"></div><div class="group-resize-controls"><div id="grip"></div></div></div>`, "title");
    const grip = document.getElementById("grip")!, rename = document.getElementById("rename")!;
    // Off the Mac the default ("space") mode pans on the left and middle buttons.
    expect(editor.groupChromePans(on(title, 0, 0))).toBe(true);
    expect(editor.groupChromePans(on(grip, 0, 0, { button: 1 }))).toBe(true);
    expect(editor.groupChromePans(on(rename, 0, 0))).toBe(false);
    expect(editor.groupChromePans(on(title, 0, 0, { ctrlKey: true }))).toBe(false);
    expect(editor.groupChromePans(on(title, 0, 0, { shiftKey: true }))).toBe(false);
    expect(editor.press(on(title, 0, 0))).not.toBeNull();
    expect(panGesture).toHaveBeenCalledTimes(1);
    // The "middleMouse" mode pans on the right button only.
    settings.navigation = { ...defaultCanvasNavigationSettings, panMode: "middleMouse" };
    expect(editor.groupChromePans(on(grip, 0, 0))).toBe(false);
    expect(editor.groupChromePans(on(grip, 0, 0, { button: 2 }))).toBe(true);
    settings.tutorial = true;
    expect(editor.groupChromePans(on(grip, 0, 0, { button: 2 }))).toBe(false);
  });
});
