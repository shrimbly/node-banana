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

const target = { nodeId: "a", handleId: "image", type: "source" as const, position: { x: 300, y: 200 } };

describe("HandleMenu", () => {
  const onClose = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows only the count of connections on the handle", () => {
    withEdges([edge("e1"), edge("e2"), edge("e3", { sourceHandle: "text" })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getByTestId("handle-menu-count")).toHaveTextContent("2");
    expect(screen.queryByText(/connections/)).toBeNull();
  });

  it("offers Bundle, Hide and Remove all as icons", () => {
    withEdges([edge("e1"), edge("e2")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getAllByRole("menuitem").map((b) => b.getAttribute("aria-label"))).toEqual(["Bundle", "Hide", "Remove all"]);
  });

  it("bundles the connections on the handle", () => {
    withEdges([edge("e1"), edge("e2")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Bundle" }));
    expect(mockBundleEdges).toHaveBeenCalledWith(["e1", "e2"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("swaps to Unbundle once they are bundled", () => {
    withEdges([edge("e1", { data: { bundleId: "x" } }), edge("e2", { data: { bundleId: "x" } })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.queryByRole("menuitem", { name: "Bundle" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unbundle" }));
    expect(mockUnbundleEdges).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("disables Bundle for a lone connection", () => {
    withEdges([edge("e1")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getByRole("menuitem", { name: "Bundle" })).toBeDisabled();
  });

  it("hides the connections, and swaps to Show once they are all hidden", () => {
    withEdges([edge("e1"), edge("e2", { data: { createdAt: 2, hidden: true } })]);
    const { unmount } = render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1", "e2"], true);
    unmount();

    withEdges([edge("e1", { data: { hidden: true } }), edge("e2", { data: { createdAt: 2, hidden: true } })]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show" }));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1", "e2"], false);
  });

  it("removes every connection on the handle", () => {
    withEdges([edge("e1"), edge("e2")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all" }));
    expect(mockRemoveEdges).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("disables Hide and Remove all when the handle has no connections", () => {
    withEdges([]);
    render(<HandleMenu target={target} onClose={onClose} />);
    expect(screen.getByTestId("handle-menu-count")).toHaveTextContent("0");
    expect(screen.getByRole("menuitem", { name: "Hide" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Remove all" })).toBeDisabled();
  });

  it("sits above the handle", () => {
    withEdges([edge("e1")]);
    render(<HandleMenu target={target} onClose={onClose} />);
    const menu = screen.getByTestId("handle-menu");
    // jsdom reports zero size, so the bar's bottom lands 14px above the handle centre
    expect(menu.style.top).toBe("186px");
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
