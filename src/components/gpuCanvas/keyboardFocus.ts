/**
 * Keyboard focus on the GPU canvas. On the classic canvas every node and
 * connection is a tab stop (React Flow's nodesFocusable and edgesFocusable):
 * Tab steps through the connections, then the nodes in the store's order,
 * each node's own fields after it, and a node focused off screen is centred
 * at the same zoom (autoPanOnNodeFocus). Here painted nodes are pictures and
 * connections are strokes, so Tab is stepped by hand along that order:
 *
 * - a node is made live, centred when it is off screen, and its element
 *   focused once mounted (Shift+Tab lands on its last field, as on classic);
 *   inside a live node Tab walks its fields, then moves on;
 * - a connection has no element: a sentry at the head of the canvas holds
 *   focus for it, named as React Flow names an edge; the stroke is left as it
 *   is, as classic draws a focused edge unchanged. Enter or Space selects it,
 *   Escape unselects it, Delete removes it once selected, as a focused edge
 *   does;
 * - past either end, focus leaves the canvas for the page around it.
 */
import type { EdgeChange, NodeChange } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import type { Scene } from "@/lib/gpuCanvas/scene";
import type { LiveLayer } from "./LiveLayer";

type Item = { kind: "edge" | "node"; id: string };

const TABBABLE = "a[href], button, input, select, textarea, [tabindex], [contenteditable='true'], audio[controls], video[controls], summary";
/** How many changes of live nodes a focus step waits through for its node to mount. */
const MOUNT_TRIES = 5;

function isTabbable(element: HTMLElement) {
  if (element.tabIndex < 0 || (element as HTMLButtonElement).disabled || element.closest("[inert], [hidden]")) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  return typeof element.checkVisibility === "function" ? element.checkVisibility({ visibilityProperty: true }) : true;
}

/** The tab stops inside `root` (itself first when it is one), in document order. */
function tabbables(root: ParentNode): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(TABBABLE)];
  if (root instanceof HTMLElement && root.matches(TABBABLE)) found.unshift(root);
  return found.filter(isTabbable);
}

function focus(element: HTMLElement) {
  // The live layer clips and must not scroll: the scene owns the view.
  element.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
}

export class KeyboardFocus {
  /** Holds focus while a connection has it, and takes Tab from the page into the canvas. */
  readonly sentry: HTMLDivElement;
  /** The connection holding keyboard focus. */
  edgeId: string | null = null;
  /** The direction of a Tab the browser is carrying out, while it does. */
  private tabbing: "forward" | "back" | null = null;
  private placing = false;
  private step = 0;
  private offs: (() => void)[] = [];

  constructor(
    private scene: Pick<Scene, "graph" | "view" | "canvas" | "setView">,
    private live: Pick<LiveLayer, "element" | "live" | "want" | "settled" | "nodeElement">,
    host: HTMLElement,
    private locked: () => boolean,
  ) {
    const sentry = (this.sentry = document.createElement("div"));
    sentry.tabIndex = 0;
    sentry.dataset.gpuCanvasFocus = "";
    sentry.setAttribute("role", "group");
    sentry.setAttribute("aria-label", "Workflow canvas");
    sentry.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;outline:none;";
    host.prepend(sentry);
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, listener: (event: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, listener as EventListener);
      this.offs.push(() => target.removeEventListener(type, listener as EventListener));
    };
    // On the window, after React's handlers: a field that keeps Tab for itself prevents it.
    on(window, "keydown", (event) => this.keyDown(event));
    on(host, "focusin", (event) => this.focusIn(event));
    on(sentry, "focusout", (event) => {
      if (event.relatedTarget !== sentry) this.setEdge(null);
    });
  }

  dispose() {
    for (const off of this.offs) off();
    this.sentry.remove();
  }

  /** Tab stops in the classic canvas's order: connections (React Flow renders them first), then nodes. */
  private items(): Item[] {
    const { nodes, edges } = useWorkflowStore.getState();
    const graph = this.scene.graph;
    const items: Item[] = [];
    for (const e of edges) if (!e.hidden && e.focusable !== false && graph.edgeIndexOf.has(e.id)) items.push({ kind: "edge", id: e.id });
    for (const n of nodes) if (!n.hidden && n.focusable !== false && graph.indexOf.has(n.id)) items.push({ kind: "node", id: n.id });
    return items;
  }

  /** The live node element holding focus, or holding the focused field. */
  private focusedNode(): HTMLElement | null {
    const active = document.activeElement;
    if (!(active instanceof Element) || !this.live.element.contains(active)) return null;
    return active.closest<HTMLElement>(".react-flow__node:not(.react-flow__node-gpuGhost)");
  }

  private keyDown(event: KeyboardEvent) {
    const active = document.activeElement;
    if (active === this.sentry && this.edgeId && !event.defaultPrevented) this.edgeKey(event);
    if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const back = event.shiftKey;
    let from: Item | null = null;
    if (active === this.sentry) from = this.edgeId ? { kind: "edge", id: this.edgeId } : null;
    else {
      const element = this.focusedNode();
      const id = element?.getAttribute("data-id");
      if (!element || !id) {
        // The browser moves focus: one landing in the canvas from outside it is redirected (focusIn).
        this.tabbing = back ? "back" : "forward";
        setTimeout(() => { this.tabbing = null; });
        return;
      }
      // Within the node, its own tab stops in order.
      const stops = tabbables(element);
      const at = stops.indexOf(active as HTMLElement);
      if (at < 0) return;
      const next = stops[at + (back ? -1 : 1)];
      if (next) {
        event.preventDefault();
        focus(next);
        return;
      }
      from = { kind: "node", id };
    }
    event.preventDefault();
    const items = this.items();
    const at = from ? items.findIndex((item) => item.kind === from.kind && item.id === from.id) : back ? items.length : -1;
    const next = items[at + (back ? -1 : 1)];
    if (next) void this.go(next, back);
    else this.leave(back);
  }

  /** React Flow's keys on a focused edge: Enter and Space select it alone, Escape unselects it and lets go. */
  private edgeKey(event: KeyboardEvent) {
    if (!["Enter", " ", "Escape"].includes(event.key) || this.locked()) return;
    const store = useWorkflowStore.getState();
    const edge = store.edges.find((e) => e.id === this.edgeId);
    if (!edge || edge.selectable === false) return;
    if (event.key === "Escape") {
      this.sentry.blur();
      if (edge.selected) store.onEdgesChange([{ type: "select", id: edge.id, selected: false }]);
      return;
    }
    const edges = store.edges.filter((e) => !!e.selected !== (e.id === edge.id)).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: e.id === edge.id }));
    const nodes = store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
    if (edges.length) store.onEdgesChange(edges);
    if (nodes.length) store.onNodesChange(nodes);
  }

  /** Focus arriving by Tab from the page: into the first stop going forward, the last going back. */
  private focusIn(event: FocusEvent) {
    if (this.placing || !this.tabbing) return;
    const target = event.target as Element;
    const from = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    const viewport = this.viewport();
    const entering = target === this.sentry || (viewport.contains(target) && !(from && (viewport.contains(from) || from === this.sentry)));
    if (!entering) return;
    const back = this.tabbing === "back";
    this.tabbing = null;
    const items = this.items();
    const item = back ? items[items.length - 1] : items[0];
    if (item) void this.go(item, back);
  }

  private viewport(): Element {
    return this.live.element.querySelector(".react-flow__viewport") ?? this.live.element;
  }

  private setEdge(id: string | null) {
    if (id === this.edgeId) return;
    this.edgeId = id;
    const e = id == null ? undefined : this.scene.graph.edgeIndexOf.get(id);
    const edge = e == null ? undefined : this.scene.graph.edges[e];
    if (edge) {
      this.sentry.setAttribute("aria-roledescription", "edge");
      this.sentry.setAttribute("aria-label", edge.edge.ariaLabel || `Edge from ${edge.edge.source} to ${edge.edge.target}`);
    } else {
      this.sentry.removeAttribute("aria-roledescription");
      this.sentry.setAttribute("aria-label", "Workflow canvas");
    }
  }

  /** Moves keyboard focus to a connection or a node (`back`: onto the node's last field). */
  async go(item: Item, back = false) {
    const step = ++this.step;
    if (item.kind === "edge") {
      this.setEdge(item.id);
      if (document.activeElement !== this.sentry) {
        this.placing = true;
        focus(this.sentry);
        this.placing = false;
      }
      return;
    }
    const scene = this.scene, i = scene.graph.indexOf.get(item.id);
    if (i == null) return;
    // Off screen, the node is centred at the same zoom, as React Flow's setCenter on focus.
    const n = scene.graph.nodes[i], { x, y, zoom } = scene.view;
    const w = scene.canvas.clientWidth, h = scene.canvas.clientHeight;
    const left = n.x * zoom + x, top = n.y * zoom + y;
    if (left > w || top > h || left + n.w * zoom < 0 || top + n.h * zoom < 0) scene.setView({ x: w / 2 - (n.x + n.w / 2) * zoom, y: h / 2 - (n.y + n.h / 2) * zoom });
    this.live.want(item.id, "focus", true);
    for (let tries = 0; tries < MOUNT_TRIES && !this.live.live.has(item.id) && step === this.step; tries++) await this.live.settled();
    const element = this.live.live.has(item.id) ? this.live.nodeElement(item.id) : null;
    if (step !== this.step || !element) {
      // Superseded or never mounted: the focus reason goes, unless focus reached the node meanwhile.
      if (this.focusedNode()?.getAttribute("data-id") !== item.id) this.live.want(item.id, "focus", false);
      return;
    }
    // Focusing it hands the reason over to the live layer's own focus tracking.
    const stops = tabbables(element);
    focus((back ? stops[stops.length - 1] : undefined) ?? element);
  }

  /** Past the first or last stop: focus goes to the page before or after the canvas. */
  private leave(back: boolean) {
    this.step++;
    const viewport = this.viewport(), sentry = this.sentry;
    const outside = tabbables(document).filter((element) => element !== sentry && !viewport.contains(element));
    const target = back
      ? outside.filter((element) => element.compareDocumentPosition(sentry) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      : outside.find((element) => viewport.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (target) focus(target);
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }
}
