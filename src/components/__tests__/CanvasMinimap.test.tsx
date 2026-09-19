import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import {
  CanvasMinimap,
  MINIMAP_GEOMETRY,
  NAVIGATOR_WIDTH,
  getMiniMapNodeColor,
} from "@/components/CanvasMinimap";

const mockZoomIn = vi.fn();
const mockZoomOut = vi.fn();
const mockFitView = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({ zoomIn: mockZoomIn, zoomOut: mockZoomOut, fitView: mockFitView }),
  };
});

function renderNavigator(props: { disabled?: boolean } = {}) {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[]} edges={[]}>
        <CanvasMinimap {...props} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

describe("CanvasMinimap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the minimap inside the navigator card with the controls row beneath", () => {
    renderNavigator();

    const minimap = document.querySelector(".react-flow__minimap");
    expect(minimap).toBeInTheDocument();
    expect(minimap).toHaveStyle({
      width: `${MINIMAP_GEOMETRY.width}px`,
      height: `${MINIMAP_GEOMETRY.height}px`,
      position: "static",
    });

    const card = screen.getByTestId("canvas-navigator");
    expect(card).toHaveStyle({ margin: `${MINIMAP_GEOMETRY.margin}px` });
    for (const name of ["Zoom out", "Zoom in", "Fit view", "Lock canvas", "Hide minimap"]) {
      expect(card).toContainElement(screen.getByRole("button", { name }));
    }
  });

  it("hides and restores the minimap while the controls row stays put", () => {
    renderNavigator();

    fireEvent.click(screen.getByRole("button", { name: "Hide minimap" }));
    expect(document.querySelector(".react-flow__minimap")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show minimap" }));
    expect(document.querySelector(".react-flow__minimap")).toBeInTheDocument();
  });

  it("drives zoom and fit through React Flow", () => {
    renderNavigator();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));

    expect(mockZoomIn).toHaveBeenCalledTimes(1);
    expect(mockZoomOut).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenCalledTimes(1);
  });

  it("shows the zoom level as a whole percentage", () => {
    renderNavigator();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
  });

  it("locks and unlocks canvas interaction", () => {
    renderNavigator();

    fireEvent.click(screen.getByRole("button", { name: "Lock canvas" }));
    const unlock = screen.getByRole("button", { name: "Unlock canvas" });
    expect(unlock).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(unlock);
    expect(screen.getByRole("button", { name: "Lock canvas" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is inert while the tutorial locks features", () => {
    renderNavigator({ disabled: true });

    const card = screen.getByTestId("canvas-navigator");
    expect(card).toHaveClass("pointer-events-none");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hide minimap" })).toBeDisabled();
  });

  it("exposes the card width neighbours offset from", () => {
    expect(NAVIGATOR_WIDTH).toBe(MINIMAP_GEOMETRY.width + MINIMAP_GEOMETRY.padding * 2 + 2);
  });

  it("keeps the per-node-type minimap colours", () => {
    const colour = (type: string) => getMiniMapNodeColor({ id: "n", type, position: { x: 0, y: 0 }, data: {} } as Node);
    expect(colour("imageInput")).toBe("#3b82f6");
    expect(colour("prompt")).toBe("#f97316");
    expect(colour("nanoBanana")).toBe("#22c55e");
    expect(colour("output")).toBe("#ef4444");
    expect(colour("comfyApp")).toBe("#7dd3fc");
    expect(colour("unknown")).toBe("#94a3b8");
  });
});
