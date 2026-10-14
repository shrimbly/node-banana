import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useNodeUiStore } from "@/store/nodeUiStore";
import { HoldLiveProvider, PaintedNodes, useNodeUiState } from "@/components/nodes/paintMode";

const live = ({ children }: { children: ReactNode }) => <HoldLiveProvider hold={() => () => {}}>{children}</HoldLiveProvider>;
const painted = ({ children }: { children: ReactNode }) => <PaintedNodes>{children}</PaintedNodes>;

describe("useNodeUiState", () => {
  beforeEach(() => useNodeUiStore.getState().forget());

  it("is local state on the classic canvas", () => {
    const { result } = renderHook(() => useNodeUiState("n1", "expanded", true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(useNodeUiStore.getState().byNode).toEqual({});
  });

  it("is shared between a live node and its painted copy on the GPU canvas", () => {
    const liveNode = renderHook(() => useNodeUiState("n1", "expanded", true), { wrapper: live });
    const copy = renderHook(() => useNodeUiState("n1", "expanded", true), { wrapper: painted });
    expect(copy.result.current[0]).toBe(true);
    act(() => liveNode.result.current[1]((open) => !open));
    expect(liveNode.result.current[0]).toBe(false);
    expect(copy.result.current[0]).toBe(false);
  });

  it("forgets the nodes that went, or every node", () => {
    const { set, forget } = useNodeUiStore.getState();
    set("n1", "expanded", false);
    set("n2", "settingsTab", "fallback");
    forget(["n1"]);
    expect(useNodeUiStore.getState().byNode).toEqual({ n2: { settingsTab: "fallback" } });
    forget();
    expect(useNodeUiStore.getState().byNode).toEqual({});
  });
});
