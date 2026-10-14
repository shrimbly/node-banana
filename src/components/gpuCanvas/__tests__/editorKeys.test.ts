import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import type { WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings } from "@/types/canvas";
import { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { Editor, type GpuEditing } from "../editor";
import type { LiveLayer } from "../LiveLayer";

function node(id: string, x: number, y: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, selected } as unknown as WorkflowNode;
}

const noop = () => {};
const editing: GpuEditing = {
  navigation: defaultCanvasNavigationSettings,
  locked: false,
  disabled: false,
  tutorial: false,
  isValidConnection: () => true,
  onConnect: noop,
  onReconnect: noop,
  onConnectEnd: noop,
  onHandleClick: noop,
  onNodeDragStop: noop,
  onPaneClick: noop,
  onPaneMenu: noop,
  onEdgeClick: noop,
  onEdgeContextMenu: noop,
};

let editor: Editor;
let host: HTMLDivElement;
let settings: GpuEditing;

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const ids = (filter: (n: WorkflowNode) => boolean) => useWorkflowStore.getState().nodes.filter(filter).map((n) => n.id);

beforeEach(() => {
  const nodes = [node("a", 0, 0, true), node("b", 400, 0)];
  useWorkflowStore.setState({ nodes, edges: [] });
  useAssetStore.setState({ appView: "canvas" });
  const graph = new SceneGraph(nodes, [], {});
  const canvas = document.createElement("canvas");
  const scene = { graph, canvas, nodesMoved: noop, setHoveredEdge: noop, onViewChanged: () => noop, onLayoutChanged: () => noop } as unknown as Scene;
  const live = { refresh: noop } as unknown as LiveLayer;
  host = document.createElement("div");
  document.body.appendChild(host);
  settings = { ...editing };
  editor = new Editor(scene, live, host, () => settings);
});

afterEach(() => {
  editor.dispose();
  host.remove();
  document.body.innerHTML = "";
});

describe("the GPU canvas's keys", () => {
  it("deletes the selection with Delete alone, even with a menu open, but not with a modifier or inside .nokey", () => {
    press("Delete", { shiftKey: true });
    press("Backspace", { metaKey: true });
    expect(ids(() => true)).toEqual(["a", "b"]);

    const toolbar = document.createElement("div");
    toolbar.className = "nokey";
    const button = document.createElement("button");
    toolbar.appendChild(button);
    document.body.appendChild(toolbar);
    press("Backspace", {}, button);
    expect(ids(() => true)).toEqual(["a", "b"]);

    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.appendChild(listbox);
    expect(press("Delete").defaultPrevented).toBe(true);
    expect(ids(() => true)).toEqual(["b"]);
  });

  it("deletes with focus in a non-modal dialog (the recent-generations drop-down), but not inside .nokey", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("div");
    inner.className = "nokey";
    const kept = document.createElement("button");
    inner.appendChild(kept);
    const button = document.createElement("button");
    dialog.append(inner, button);
    document.body.appendChild(dialog);
    press("Delete", {}, kept);
    expect(ids(() => true)).toEqual(["a", "b"]);
    press("Delete", {}, button);
    expect(ids(() => true)).toEqual(["b"]);
  });

  it("deletes while the navigator lock is on, but not while disabled (a modal open)", () => {
    settings = { ...editing, locked: true };
    press("Delete");
    expect(ids(() => true)).toEqual(["b"]);
    useWorkflowStore.setState({ nodes: [node("a", 0, 0, true)] });
    settings = { ...editing, disabled: true };
    press("Delete");
    expect(ids(() => true)).toEqual(["a"]);
  });

  it("moves the selection 5px with an arrow key and 20px with Shift, unless locked", () => {
    // A click on the node focuses it, as classic's wrapper takes focus.
    editor.clickNode("a", false);
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    press("ArrowDown", { shiftKey: true });
    const moved = useWorkflowStore.getState().nodes;
    expect(moved[0].position).toEqual({ x: 5, y: 20 });
    expect(moved[1].position).toEqual({ x: 400, y: 0 });
    settings = { ...editing, locked: true };
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 5, y: 20 });
  });

  it("moves nothing with focus on nothing: a selection made in the store, or after a pane click", () => {
    // Selected straight in the store (paste, select-all, the agent): classic's focus is on the page.
    press("ArrowRight");
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    // A click on the selected node focuses it: the arrows move it.
    editor.clickNode("a", false);
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 5, y: 0 });
    // A pane click (on a locked-free canvas it clears the selection; reselect to keep one) leaves focus on nothing.
    editor["paneClick"]();
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 5, y: 0 });
  });

  it("a focused node moves the selection only while it is selected, and focus elsewhere drops it", () => {
    editor.clickNode("a", false);
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: true }]);
    press("ArrowRight");
    expect(useWorkflowStore.getState().nodes[1].position).toEqual({ x: 400, y: 0 });
    // Selected again with b (select-all): the focused node carries the selection.
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
    press("ArrowRight");
    expect(useWorkflowStore.getState().nodes.map((n) => n.position.x)).toEqual([5, 405]);
    // Focus moved to a button and back to the page: no node holds it any more.
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    button.blur();
    press("ArrowRight");
    expect(useWorkflowStore.getState().nodes.map((n) => n.position.x)).toEqual([5, 405]);
  });

  it("leaves arrow keys to a focused field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press("ArrowRight", {}, input);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("selects a focused live node with Enter and unselects it with Escape", () => {
    const layer = document.createElement("div");
    layer.setAttribute("data-gpu-canvas-live", "");
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node react-flow__node-prompt";
    wrapper.setAttribute("data-id", "b");
    wrapper.tabIndex = 0;
    layer.appendChild(wrapper);
    host.appendChild(layer);
    wrapper.focus();
    press("Enter", {}, wrapper);
    expect(ids((n) => !!n.selected)).toEqual(["b"]);
    press("Escape", {}, wrapper);
    expect(ids((n) => !!n.selected)).toEqual([]);
  });

  it("unselects a pressed painted node with Escape, then leaves it to nothing", () => {
    // A press on a painted node: focus stays on the page, as the node's wrapper would hold it on classic.
    editor.clickNode("a", false);
    press("Escape");
    expect(ids((n) => !!n.selected)).toEqual([]);
    // Classic blurs the unselected node: Enter, and the arrows, then do nothing.
    press("Enter");
    expect(ids((n) => !!n.selected)).toEqual([]);
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
    press("ArrowRight");
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("selects a pressed painted node with Enter, and a Shift click that unselects it drops the keys", () => {
    editor.clickNode("b", false);
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "b", selected: false }]);
    press("Enter");
    expect(ids((n) => !!n.selected)).toEqual(["b"]);
    editor.clickNode("b", true);
    expect(ids((n) => !!n.selected)).toEqual([]);
    press("Enter");
    expect(ids((n) => !!n.selected)).toEqual([]);
  });

  it("a clicked connection takes the keys from a node pressed earlier", () => {
    useWorkflowStore.setState({
      nodes: [node("a", 0, 0), node("b", 400, 0)],
      edges: [{ id: "e", source: "a", target: "b" }] as never,
    });
    editor.clickNode("a", false);
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }]);
    const click = new MouseEvent("pointerup") as unknown as PointerEvent;
    editor["clickEdge"](click, "e");
    expect(useWorkflowStore.getState().edges[0].selected).toBe(true);
    expect(document.activeElement).toBe(editor.keyboard.sentry);
    expect(editor.keyboard.edgeId).toBe("e");
    // Enter keeps the connection selected; Escape unselects it, and node a stays unselected.
    press("Enter");
    expect(useWorkflowStore.getState().edges[0].selected).toBe(true);
    expect(ids((n) => !!n.selected)).toEqual([]);
    press("Escape");
    expect(useWorkflowStore.getState().edges[0].selected).toBe(false);
    expect(ids((n) => !!n.selected)).toEqual([]);
    expect(editor.keyboard.edgeId).toBe(null);
  });
});
