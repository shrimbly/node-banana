import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
import { useAddMediaNode } from "../useAddMediaNode";

describe("useAddMediaNode", () => {
  it("makes the new node the only selection in the store (React Flow may not hold the other nodes)", () => {
    const prompt = { id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "" }, selected: true } as unknown as WorkflowNode;
    useWorkflowStore.setState({ nodes: [prompt], edges: [] });
    const wrapper = ({ children }: { children: ReactNode }) => <ReactFlowProvider>{children}</ReactFlowProvider>;
    const { result } = renderHook(() => useAddMediaNode(), { wrapper });
    let id = "";
    act(() => {
      id = result.current({ kind: "video", src: "data:video/mp4;base64,AA==", filename: "clip.mp4" });
    });
    const selected = useWorkflowStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
    expect(selected).toEqual([id]);
  });
});
