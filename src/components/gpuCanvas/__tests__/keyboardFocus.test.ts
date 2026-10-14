import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene, View } from "@/lib/gpuCanvas/scene";
import type { LiveLayer, LiveReason } from "../LiveLayer";
import { KeyboardFocus } from "../keyboardFocus";

function node(id: string, x: number, y: number): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, height: 200, measured: { width: 300, height: 200 } } as unknown as WorkflowNode;
}

const edge = { id: "e", source: "a", target: "b", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge;

let host: HTMLDivElement, before: HTMLButtonElement, after: HTMLButtonElement;
let focusRing: KeyboardFocus;
let view: View;
let hovered: number;
let wanted: Map<string, Set<LiveReason>>;
let live: Pick<LiveLayer, "element" | "live" | "want" | "settled" | "nodeElement">;

/** A live node as React Flow renders it: a focusable wrapper holding a field. */
function mount(id: string) {
  const viewport = live.element.querySelector(".react-flow__viewport")!;
  const wrapper = document.createElement("div");
  wrapper.className = "react-flow__node react-flow__node-prompt";
  wrapper.dataset.id = id;
  wrapper.tabIndex = 0;
  wrapper.appendChild(document.createElement("textarea"));
  viewport.appendChild(wrapper);
  live.live.add(id);
}

function tab(shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  const nodes = [node("a", 0, 0), node("b", 3000, 2000)];
  useWorkflowStore.setState({ nodes, edges: [edge] });
  const graph = new SceneGraph(nodes, [edge], {});
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 1000 });
  Object.defineProperty(canvas, "clientHeight", { value: 800 });
  view = { x: 0, y: 0, zoom: 0.5 };
  hovered = -1;
  const scene = {
    graph, canvas, view,
    setView: (next: Partial<View>) => void Object.assign(view, next),
    setHoveredEdge: (e: number) => void (hovered = e),
  } as unknown as Scene;
  before = document.createElement("button");
  after = document.createElement("button");
  host = document.createElement("div");
  const layer = document.createElement("div");
  layer.setAttribute("data-gpu-canvas-live", "");
  layer.innerHTML = '<div class="react-flow__viewport"></div>';
  host.appendChild(layer);
  document.body.append(before, host, after);
  wanted = new Map();
  let pending = Promise.resolve();
  live = {
    element: layer,
    live: new Set<string>(),
    want: (id: string, reason: LiveReason, on: boolean) => {
      const reasons = wanted.get(id) ?? new Set();
      if (on) reasons.add(reason);
      else reasons.delete(reason);
      wanted.set(id, reasons);
      // The node mounts a little later, as the live layer swaps it in.
      if (on && !live.live.has(id)) pending = Promise.resolve().then(() => mount(id));
    },
    settled: () => pending,
    nodeElement: (id: string) => layer.querySelector(`.react-flow__node[data-id="${id}"]`),
  } as unknown as typeof live;
  mount("a");
  focusRing = new KeyboardFocus(scene, live, host, () => false);
});

afterEach(() => {
  focusRing.dispose();
  document.body.innerHTML = "";
});

describe("the GPU canvas's keyboard focus", () => {
  it("tabs from a live node's last field to an off-screen painted node, mounting, focusing and centring it", async () => {
    const a = live.nodeElement("a")!;
    a.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a.querySelector("textarea"));
    expect(tab().defaultPrevented).toBe(true);
    await live.settled();
    await Promise.resolve();
    expect(wanted.get("b")?.has("focus")).toBe(true);
    expect(live.live.has("b")).toBe(true);
    expect(document.activeElement).toBe(live.nodeElement("b"));
    // Centred at the same zoom: (3000 + 150, 2000 + 100) at the middle of a 1000×800 canvas.
    expect(view).toEqual({ x: 500 - 3150 * 0.5, y: 400 - 2100 * 0.5, zoom: 0.5 });
  });

  it("steps through the connections before the nodes, and Shift+Tab lands on a node's last field", async () => {
    before.focus();
    // The browser moves focus onto the sentry; the step into the canvas takes the first stop.
    tab();
    focusRing.sentry.focus();
    expect(document.activeElement).toBe(focusRing.sentry);
    expect(focusRing.edgeId).toBe("e");
    // Classic draws a focused connection unchanged: it is named, not hovered.
    expect(hovered).toBe(-1);
    expect(focusRing.sentry.getAttribute("aria-label")).toBe("Edge from a to b");

    tab();
    expect(document.activeElement).toBe(live.nodeElement("a"));
    expect(focusRing.edgeId).toBeNull();
    expect(hovered).toBe(-1);
    expect(focusRing.sentry.getAttribute("aria-label")).toBe("Workflow canvas");

    tab(true);
    expect(document.activeElement).toBe(focusRing.sentry);
    expect(focusRing.edgeId).toBe("e");
    tab();
    tab();
    tab();
    await live.settled();
    await Promise.resolve();
    expect(document.activeElement).toBe(live.nodeElement("b"));
    tab(true);
    expect(document.activeElement).toBe(live.nodeElement("a")!.querySelector("textarea"));
  });

  it("leaves the canvas past its last stop, and selects a focused connection with Enter", () => {
    mount("b");
    live.nodeElement("b")!.querySelector("textarea")!.focus();
    tab();
    expect(document.activeElement).toBe(after);

    focusRing.go({ kind: "edge", id: "e" });
    focusRing.sentry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(useWorkflowStore.getState().edges[0].selected).toBe(true);
    focusRing.sentry.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(useWorkflowStore.getState().edges[0].selected).toBe(false);
    expect(document.activeElement).not.toBe(focusRing.sentry);
  });
});
