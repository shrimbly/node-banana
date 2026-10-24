"use client";

/**
 * The painter's sheet: a real <ReactFlow> at the zoom of the tier being
 * painted, holding a batch of real nodes with their floating headers,
 * rendered inside the scene's <canvas layoutsubtree> (content="drawable" from Chromium 155): laid out like the page,
 * never shown, and painted into a texture in one call. The nodes read the
 * real workflow store, as they do on the canvas, but render read-only
 * (PaintedNodes): nothing a painted copy does writes to the store.
 */
import { startTransition, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useStoreApi, type Node, type NodeTypes, type ReactFlowState } from "@xyflow/react";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { PaintedNodes } from "@/components/nodes/paintMode";
import { StoreSocketConnections } from "@/components/nodes/ui/socketConnections";
import { markDrawable } from "@/lib/gpuCanvas/htmlInCanvas";
import { nextFrame, noop, settleNodes, type HeaderProps } from "./nodeSheets";

// Transitions and animations would be painted mid-way; the pane is transparent so the margins are.
// The agent's shimmer (an attribute on a shown node) is never painted.
const SHEET_STYLE = `
  [data-gpu-canvas-sheet] [data-agent-shimmer] :is([data-media-card], [data-controls-card])::after { content: none !important; }
  [data-gpu-canvas-sheet] *, [data-gpu-canvas-sheet] *::before, [data-gpu-canvas-sheet] *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
  [data-gpu-canvas-sheet], [data-gpu-canvas-sheet] * { overflow-anchor: none !important; }
  [data-gpu-canvas-sheet] .react-flow__pane, [data-gpu-canvas-sheet] .react-flow__renderer, [data-gpu-canvas-sheet] .react-flow { background: transparent !important; }
`;

interface SheetState {
  nodes: Node[];
  zoom: number;
  done: () => void;
}

/** What the sheet's React tree hands its owner once mounted. */
interface SheetConnection {
  set?: (next: SheetState) => void;
  flow?: () => ReactFlowState;
}

function FlowStoreProbe({ connect }: { connect: (connection: SheetConnection) => void }) {
  const store = useStoreApi();
  useLayoutEffect(() => connect({ flow: () => store.getState() }), [connect, store]);
  return null;
}

function Sheet({ connect, nodeTypes, headers }: { connect: (connection: SheetConnection) => void; nodeTypes: NodeTypes; headers: HeaderProps }) {
  const [state, setState] = useState<SheetState>({ nodes: [], zoom: 1, done: noop });
  useLayoutEffect(() => connect({ set: (next) => startTransition(() => setState(next)) }), [connect]);
  useLayoutEffect(() => state.done(), [state]);
  return (
    <PaintedNodes>
      {/* Its flow holds no edges: connected sockets come from the store, as the paint key does. */}
      <StoreSocketConnections>
        <ReactFlowProvider>
          <style>{SHEET_STYLE}</style>
          <ReactFlow nodes={state.nodes} edges={[]} nodeTypes={nodeTypes} viewport={{ x: 0, y: 0, zoom: state.zoom }} minZoom={0.01} maxZoom={4}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false}
            zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}
            // Its keys would be the page's: React Flow's default Backspace and Space handlers preventDefault them on the document.
            deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} panActivationKeyCode={null} zoomActivationKeyCode={null}>
            <FlowStoreProbe connect={connect} />
            <FloatingNodeHeaders nodes={state.nodes} {...headers} />
          </ReactFlow>
        </ReactFlowProvider>
      </StoreSocketConnections>
    </PaintedNodes>
  );
}

/** React Flow's node transform, as the style reads it back. */
const TRANSLATE = /^translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)$/;

export class PainterSheet {
  readonly element: HTMLDivElement;
  private root: Root;
  private set: (next: SheetState) => void = noop;
  private flowState: () => ReactFlowState | null = () => null;

  constructor(canvas: HTMLCanvasElement, public width: number, public height: number, nodeTypes: NodeTypes, headers: HeaderProps) {
    this.element = document.createElement("div");
    this.element.dataset.gpuCanvasSheet = "";
    this.element.inert = true;
    markDrawable(this.element);
    this.resize(width, height);
    canvas.appendChild(this.element);
    this.root = createRoot(this.element);
    const connect = (connection: SheetConnection) => {
      if (connection.set) this.set = connection.set;
      if (connection.flow) this.flowState = connection.flow;
    };
    this.root.render(<Sheet connect={connect} nodeTypes={nodeTypes} headers={headers} />);
  }

  /** The sheet's css size; its texture is this times the canvas's backing scale. */
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    // Laid out at its size; never takes the pointer from the scene.
    this.element.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none;contain:strict;`;
  }

  /** Renders the nodes at a zoom (the painted tier over the backing scale) and resolves once React has committed them. */
  render(nodes: Node[], zoom = 1): Promise<void> {
    return new Promise((resolve) => this.set({ nodes, zoom, done: resolve }));
  }

  settle(ids: readonly string[], timeoutMs = 5000, cancelled?: () => boolean) {
    return settleNodes(this.element, ids, performance.now() + timeoutMs, cancelled);
  }

  /**
   * Waits until React Flow has moved each node to its position (it applies
   * new positions a render after ours), so the sheet is not painted with a
   * node still where the previous pass put it. False if the deadline passed.
   */
  async positioned(at: ReadonlyMap<string, { x: number; y: number }>, timeoutMs = 2000, cancelled?: () => boolean) {
    const until = performance.now() + timeoutMs;
    for (;;) {
      let ready = true;
      for (const [id, { x, y }] of at) {
        const shown = TRANSLATE.exec(this.nodeElement(id)?.style.transform ?? "");
        if (!shown || Math.abs(Number(shown[1]) - x) > 0.01 || Math.abs(Number(shown[2]) - y) > 0.01) {
          ready = false;
          break;
        }
      }
      if (ready) return true;
      if (performance.now() > until || cancelled?.()) return false;
      await nextFrame();
    }
  }

  /** The sheet's React Flow state (for handle positions). */
  flow() {
    return this.flowState();
  }

  /**
   * Scrolls everything on the sheet back to its start: a painted node shows
   * its content from the top, as a node does when it mounts. Something on a
   * big sheet (focus, scroll anchoring) can scroll a node's clipped card or
   * the sheet's flow, which would paint the card shifted or empty. Returns
   * how many elements had moved.
   */
  resetScroll(): number {
    let moved = 0;
    for (const element of [this.element, ...this.element.querySelectorAll<HTMLElement>("*")]) {
      if (element.scrollTop || element.scrollLeft) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
        moved++;
      }
    }
    return moved;
  }

  nodeElement(id: string): HTMLElement | null {
    return this.element.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  }

  dispose() {
    this.root.unmount();
    this.element.remove();
  }
}
