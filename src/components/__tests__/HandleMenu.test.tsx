import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HandleMenu } from "@/components/HandleMenu";
import type { WorkflowEdge } from "@/types";

const mockBundleEdges = vi.fn();
const mockUnbundleEdges = vi.fn();
const mockSetEdgesHidden = vi.fn();
const mockRemoveEdges = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) return mockUseWorkflowStore(selector);
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: `t-${id}`,
  targetHandle: "image",
  data: { createdAt: Number(id.replace(/\D/g, "")) || 0 },
  ...overrides,
});

const withEdges = (edges: WorkflowEdge[]) => {
  mockUseWorkflowStore.mockImplementation((selector) =>
    selector({
      edges,
      bundleEdges: mockBundleEdges,
      unbundleEdges: mockUnbundleEdges,
      setEdgesHidden: mockSetEdgesHidden,
      removeEdges: mockRemoveEdges,
    })
  );
};

const target = { nodeId: "a", handleId: "image", type: "source" as const, position: { x: 10, y: 20 } };

describe("HandleMenu", () => {
  const onClose = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("describes the handle and its connections", () => {
    withEdges([edge("e1"), edge("e2"), edge("e3", { sourceHandle: "text" })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getByText(/Image output · 2 connections/)).toBeInTheDocument();
  });

  it("bundles the connections on the handle", () => {
    withEdges([edge("e1"), edge("e2")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Bundle connections" }));
    expect(mockBundleEdges).toHaveBeenCalledWith(["e1", "e2"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers unbundle instead once they are bundled", () => {
    withEdges([edge("e1", { data: { bundleId: "x" } }), edge("e2", { data: { bundleId: "x" } })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.queryByRole("menuitem", { name: "Bundle connections" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unbundle" }));
    expect(mockUnbundleEdges).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("does not offer to bundle a lone connection", () => {
    withEdges([edge("e1")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.queryByRole("menuitem", { name: "Bundle connections" })).toBeNull();
  });

  it("hides and shows the connections", () => {
    withEdges([edge("e1"), edge("e2", { data: { createdAt: 2, hidden: true } })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide 1 visible" }));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1", "e2"], true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show 1 hidden" }));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1", "e2"], false);
  });

  it("removes every connection on the handle", () => {
    withEdges([edge("e1"), edge("e2")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all connections" }));
    expect(mockRemoveEdges).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("disables removal when the handle has no connections", () => {
    withEdges([]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getByText(/No connections/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove all connections" })).toBeDisabled();
  });

  it("closes on Escape and on a click outside", () => {
    withEdges([edge("e1")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
