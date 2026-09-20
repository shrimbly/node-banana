import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { EdgeMarqueeSelection } from "../edges/EdgeMarqueeSelection";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";

const initial = useWorkflowStore.getState();
let flow: ReturnType<typeof useStoreApi>;
function Capture() { flow = useStoreApi(); return null; }
beforeEach(() => useWorkflowStore.setState({ ...initial, nodes: [{ id: "a", type: "prompt", data: {}, position: { x: 0, y: 0 } } as WorkflowNode], edges: [
  { id: "e1", source: "a", target: "b" }, { id: "e2", source: "a", target: "c", data: { hidden: true } },
] }));
afterEach(() => { cleanup(); useWorkflowStore.setState(initial); });
function setup() {
  const canvas = createRef<HTMLDivElement>();
  const view = render(<ReactFlowProvider><Capture /><div ref={canvas}>
    <svg>{["e1", "e2"].map((id) => <g key={id} className="react-flow__edge" data-id={id}><path className="react-flow__edge-path" /></g>)}</svg>
    <EdgeMarqueeSelection canvas={canvas} disabled={false} />
  </div></ReactFlowProvider>);
  view.container.querySelectorAll("path").forEach((path) => Object.assign(path, {
    getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 }),
    getTotalLength: () => 100,
    getPointAtLength: (length: number) => ({ x: length, y: 30 }),
  }));
  act(() => flow.setState({ domNode: canvas.current }));
}
function select() {
  act(() => flow.setState({ userSelectionActive: true, userSelectionRect: { x: 50, y: 60, width: 40, height: 20, startX: 50, startY: 60 } }));
}
it("selects visible curves with pan/zoom applied, and keeps selection on release", () => {
  setup(); select();
  expect(useWorkflowStore.getState().edges.map((e) => Boolean(e.selected))).toEqual([true, false]);
  act(() => flow.setState({ userSelectionActive: false, userSelectionRect: null }));
  expect(useWorkflowStore.getState().edges[0].selected).toBe(true);
});
it("gives nodes priority, and restores noodle selection when the box moves off the node", () => {
  setup(); select();
  act(() => useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]));
  select();
  expect(useWorkflowStore.getState().edges.some((e) => e.selected)).toBe(false);
  expect(useWorkflowStore.getState().nodes[0].selected).toBe(true);
  act(() => useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }]));
  select();
  expect(useWorkflowStore.getState().edges[0].selected).toBe(true);
});
it("edge clicks clear node selections without marking the workflow dirty", () => {
  useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: true }]);
  useWorkflowStore.getState().onEdgesChange([{ type: "select", id: "e1", selected: true }]);
  expect(useWorkflowStore.getState().nodes[0].selected).toBe(false);
  expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(initial.hasUnsavedChanges);
});
