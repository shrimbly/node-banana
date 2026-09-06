import { describe, it, expect } from "vitest";
import { useLayoutEffect, useState } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi, Position } from "@xyflow/react";
import { mountedArea, useNodeMounted, NodePlaceholder, CULL_STEP } from "@/components/nodes/nodeCulling";

describe("mountedArea", () => {
  it("covers the view plus a viewport on every side, snapped to the grid", () => {
    // view of 1000x800 at zoom 1 with its top-left at flow (0, 0)
    const [minX, minY, maxX, maxY] = mountedArea([0, 0, 1], 1000, 800);
    expect(minX).toBe(-1000);
    expect(minY).toBe(-1000);
    expect(maxX).toBeGreaterThanOrEqual(2000);
    expect(maxY).toBeGreaterThanOrEqual(1600);
    expect(maxX % CULL_STEP).toBe(0);
  });

  it("grows with the zoom, since the view shows more of the flow when zoomed out", () => {
    const [, , maxAt1] = mountedArea([0, 0, 1], 1000, 800);
    const [, , maxAtHalf] = mountedArea([0, 0, 0.5], 1000, 800);
    expect(maxAtHalf).toBeGreaterThan(maxAt1);
  });
});

function Probe({ id, type = "prompt", selected = false, dragging = false }: { id: string; type?: string; selected?: boolean; dragging?: boolean }) {
  const mounted = useNodeMounted(id, type, selected, dragging);
  return <div data-testid={`probe-${id}`}>{mounted ? "component" : "placeholder"}</div>;
}

/** Puts two measured nodes in the store, one in view and one four viewports away, then renders the probes. */
function Seed({ children }: { children: React.ReactNode }) {
  const store = useStoreApi();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    store.setState({ width: 1000, height: 800, transform: [0, 0, 1] });
    store.getState().setNodes([
      { id: "near", position: { x: 100, y: 100 }, data: {}, measured: { width: 200, height: 100 } },
      { id: "far", position: { x: 4000, y: 4000 }, data: {}, measured: { width: 200, height: 100 } },
      { id: "unmeasured", position: { x: 4000, y: 4000 }, data: {} },
    ]);
    setReady(true);
  }, [store]);
  return ready ? <>{children}</> : null;
}

const renderProbes = (probes: React.ReactNode) =>
  render(
    <ReactFlowProvider>
      <Seed>{probes}</Seed>
    </ReactFlowProvider>
  );

describe("useNodeMounted", () => {
  it("renders a node in view and replaces one a viewport or more away", () => {
    renderProbes(
      <>
        <Probe id="near" />
        <Probe id="far" />
      </>
    );
    expect(screen.getByTestId("probe-near")).toHaveTextContent("component");
    expect(screen.getByTestId("probe-far")).toHaveTextContent("placeholder");
  });

  it("keeps a node that has not been measured yet", () => {
    renderProbes(<Probe id="unmeasured" />);
    expect(screen.getByTestId("probe-unmeasured")).toHaveTextContent("component");
  });

  it("keeps a far node while it is selected", () => {
    renderProbes(<Probe id="far" selected />);
    expect(screen.getByTestId("probe-far")).toHaveTextContent("component");
  });

  it("keeps a far node while it is dragging", () => {
    renderProbes(<Probe id="far" dragging />);
    expect(screen.getByTestId("probe-far")).toHaveTextContent("component");
  });

  it("keeps a far node of a type that must stay mounted", () => {
    renderProbes(<Probe id="far" type="glbViewer" />);
    expect(screen.getByTestId("probe-far")).toHaveTextContent("component");
  });

  it("keeps a far node while it holds the focused element, so an edit can commit on blur", () => {
    const host = document.createElement("div");
    host.className = "react-flow__node";
    host.setAttribute("data-id", "far");
    const input = document.createElement("input");
    host.appendChild(input);
    document.body.appendChild(host);
    try {
      renderProbes(<Probe id="far" />);
      expect(screen.getByTestId("probe-far")).toHaveTextContent("placeholder");
      act(() => {
        input.focus();
        fireEvent.focusIn(input);
      });
      expect(screen.getByTestId("probe-far")).toHaveTextContent("component");
      act(() => {
        input.blur();
        fireEvent.focusOut(input);
      });
      expect(screen.getByTestId("probe-far")).toHaveTextContent("placeholder");
    } finally {
      host.remove();
    }
  });
});

describe("NodePlaceholder", () => {
  /** Puts a measured node with one handle per side in the store, then renders its placeholder. */
  function SeededPlaceholder() {
    const store = useStoreApi();
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => {
      store.getState().setNodes([{ id: "far", position: { x: 4000, y: 4000 }, data: {}, measured: { width: 200, height: 100 } }]);
      store.getState().nodeLookup.get("far")!.internals.handleBounds = {
        source: [{ id: "image", type: "source", nodeId: "far", position: Position.Right, x: 196, y: 42, width: 8, height: 8 }],
        target: [{ id: "text", type: "target", nodeId: "far", position: Position.Left, x: -4, y: 20, width: 8, height: 8 }],
      };
      setReady(true);
    }, [store]);
    return ready ? <NodePlaceholder id="far" width={200} height={100} /> : null;
  }

  it("carries an element per measured handle with what React Flow's re-measure reads, so the edges keep their ends", () => {
    const { container } = render(
      <ReactFlowProvider>
        <SeededPlaceholder />
      </ReactFlowProvider>
    );
    expect(container.firstElementChild).toHaveStyle({ width: "200px", height: "100px" });

    const source = container.querySelector(".source");
    expect(source).toHaveAttribute("data-handleid", "image");
    expect(source).toHaveAttribute("data-handlepos", "right");
    expect(source).toHaveStyle({ position: "absolute", left: "196px", top: "42px", width: "8px", height: "8px" });

    const target = container.querySelector(".target");
    expect(target).toHaveAttribute("data-handleid", "text");
    expect(target).toHaveAttribute("data-handlepos", "left");
    expect(target).toHaveStyle({ left: "-4px", top: "20px" });
  });
});
