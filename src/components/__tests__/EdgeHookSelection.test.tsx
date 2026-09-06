import { createRef } from "react";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeHookSelection } from "../edges/EdgeHookSelection";
import { HookBundleClamp } from "../edges/HookBundleClamp";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  useReactFlow: () => ({ screenToFlowPosition: (point: { x: number; y: number }) => point }),
  useViewport: () => ({ zoom: 1 }),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const initial = useWorkflowStore.getState();
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  useWorkflowStore.setState({
    ...initial,
    nodes: [{ id: "a", type: "prompt", data: {}, position: { x: 0, y: 0 }, selected: true } as WorkflowNode],
    edges: [
      { id: "e1", source: "a", target: "b", data: {} },
      { id: "e2", source: "c", target: "d", data: {} },
      { id: "e3", source: "a", target: "d", data: {} },
    ],
  });
});
afterEach(() => {
  cleanup();
  useWorkflowStore.setState(initial);
  vi.unstubAllGlobals();
});

function setup() {
  const canvas = createRef<HTMLDivElement>();
  const view = render(<div ref={canvas}>
    <input aria-label="Prompt" />
    <svg><g className="react-flow__edge" data-id="e1"><path className="react-flow__edge-path" /></g>
      <g className="react-flow__edge" data-id="e2"><path className="react-flow__edge-path" /></g></svg>
    <EdgeHookSelection canvas={canvas} disabled={false} />
  </div>);
  view.container.querySelectorAll("path").forEach((path, i) => Object.assign(path, {
    getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    getTotalLength: () => 100,
    getPointAtLength: (length: number) => ({ x: 30 + i * 40, y: length }),
  }));
  return view;
}

function startSweep() {
  fireEvent.keyDown(window, { key: "h" });
  const overlay = screen.getByTestId("edge-hook-selection");
  Object.assign(overlay, { setPointerCapture: vi.fn() });
  fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 0, clientY: 50 });
  fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 100, clientY: 50 });
  return overlay;
}

describe("hold-H edge selection", () => {
  it("shows a crook, collects crossed edges only and bundles on release", () => {
    setup();
    const overlay = startSweep();
    expect(overlay.style.cursor).toContain("data:image/svg+xml");
    expect(useWorkflowStore.getState().nodes[0].selected).toBe(false);
    expect(useWorkflowStore.getState().edges.filter((e) => e.selected).map((e) => e.id)).toEqual(["e1", "e2"]);
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 100, clientY: 50 });
    const [a, b, c] = useWorkflowStore.getState().edges;
    expect(a.data?.hookBundle).toEqual(b.data?.hookBundle);
    expect(a.data?.hookBundle).toMatchObject({ x: 100, y: 50 });
    expect(c.data?.hookBundle).toBeUndefined();
    fireEvent.keyUp(window, { key: "h" });
    expect(screen.queryByTestId("edge-hook-selection")).not.toBeInTheDocument();
  });

  it("finishes when H is released before the pointer", () => {
    setup();
    startSweep();
    fireEvent.keyUp(window, { key: "H" });
    expect(useWorkflowStore.getState().edges[0].data?.hookBundle).toBeDefined();
    expect(screen.queryByTestId("edge-hook-selection")).not.toBeInTheDocument();
  });

  it.each(["escape", "blur"])("cancels on %s without bundling", (reason) => {
    setup();
    startSweep();
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.blur(window);
    expect(useWorkflowStore.getState().edges.every((e) => !e.selected && !e.data?.hookBundle)).toBe(true);
    expect(screen.queryByTestId("edge-hook-selection")).not.toBeInTheDocument();
  });

  it("ignores H while typing or using a modifier shortcut", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "h" });
    fireEvent.keyDown(window, { key: "h", metaKey: true });
    expect(screen.queryByTestId("edge-hook-selection")).not.toBeInTheDocument();
  });
});

describe("hook bundle menu", () => {
  function showBundle() {
    act(() => useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 100, y: 50 }));
    const bundle = useWorkflowStore.getState().edges[0].data!.hookBundle!;
    render(<HookBundleClamp bundle={bundle} members={["e1", "e2"]} selected color="#ffffff" />);
  }
  it("removes the bundle while keeping its edges", () => {
    showBundle();
    fireEvent.click(screen.getByTitle("Remove bundle"));
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
    expect(useWorkflowStore.getState().edges.every((e) => !e.data?.hookBundle)).toBe(true);
  });
  it("deletes all bundled edges and leaves other edges alone", () => {
    showBundle();
    fireEvent.click(screen.getByTitle("Delete 2 connections"));
    expect(useWorkflowStore.getState().edges.map((e) => e.id)).toEqual(["e3"]);
    act(() => useWorkflowStore.getState().undo());
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
  });
});
