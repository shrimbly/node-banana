import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MultiSelectToolbar } from "@/components/MultiSelectToolbar";
import { ReactFlowProvider } from "@xyflow/react";

// Mock JSZip
vi.mock("jszip", () => ({
  default: vi.fn().mockImplementation(() => ({
    file: vi.fn(),
    generateAsync: vi.fn().mockResolvedValue(new Blob()),
  })),
}));

// Mock the workflow store
const mockOnNodesChange = vi.fn();
const mockCreateGroup = vi.fn();
const mockRemoveNodesFromGroup = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock useReactFlow
const mockGetViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getViewport: mockGetViewport,
    }),
  };
});

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

// Create mock nodes for testing
const createMockNode = (id: string, overrides = {}) => ({
  id,
  type: "prompt",
  position: { x: 100, y: 100 },
  data: {},
  selected: true,
  measured: { width: 220, height: 200 },
  ...overrides,
});

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  nodes: [],
  onNodesChange: mockOnNodesChange,
  createGroup: mockCreateGroup,
  removeNodesFromGroup: mockRemoveNodesFromGroup,
  ...overrides,
});

describe("MultiSelectToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation - no nodes selected
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Visibility", () => {
    it("should not render when no nodes are selected", () => {
      const { container } = render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(container.firstChild).toBeNull();
    });

    it("should not render when only one node is selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [createMockNode("node-1")],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(container.firstChild).toBeNull();
    });

    it("should render when two or more nodes are selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Stack horizontally (H)")).toBeInTheDocument();
    });

    it("should not render when nodes are selected but less than 2", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1"),
            createMockNode("node-2", { selected: false }),
          ],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("Basic Rendering", () => {
    beforeEach(() => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }),
          ],
        }));
      });
    });

    it("should render stack horizontally button", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Stack horizontally (H)")).toBeInTheDocument();
    });

    it("should render stack vertically button", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Stack vertically (V)")).toBeInTheDocument();
    });

    it("should render arrange as grid button", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Arrange as grid (G)")).toBeInTheDocument();
    });

    it("should render create group button when nodes are not in a group", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Create group")).toBeInTheDocument();
    });

    it("should render download images button", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Download images as ZIP")).toBeInTheDocument();
    });
  });

  describe("Stack Horizontally", () => {
    it("should call onNodesChange when stack horizontally button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 50 } }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const stackHorizontalButton = screen.getByTitle("Stack horizontally (H)");
      fireEvent.click(stackHorizontalButton);

      // Should be called for each node
      expect(mockOnNodesChange).toHaveBeenCalled();
    });

    it("should position nodes from left to right based on their original x position", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 500, y: 100 } }),
            createMockNode("node-2", { position: { x: 100, y: 50 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      fireEvent.click(screen.getByTitle("Stack horizontally (H)"));

      // A single batched call positions all nodes; node-2 (x=100) comes first
      expect(mockOnNodesChange).toHaveBeenCalledWith([
        expect.objectContaining({
          type: "position",
          id: "node-2",
          position: expect.objectContaining({ y: 50 }), // Aligned to topmost y
        }),
        expect.objectContaining({
          type: "position",
          id: "node-1",
          position: expect.objectContaining({ y: 50 }), // Aligned to topmost y
        }),
      ]);
    });
  });

  describe("Stack Vertically", () => {
    it("should call onNodesChange when stack vertically button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 50, y: 0 } }),
            createMockNode("node-2", { position: { x: 0, y: 300 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const stackVerticalButton = screen.getByTitle("Stack vertically (V)");
      fireEvent.click(stackVerticalButton);

      expect(mockOnNodesChange).toHaveBeenCalled();
    });

    it("should position nodes from top to bottom based on their original y position", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 100, y: 500 } }),
            createMockNode("node-2", { position: { x: 50, y: 100 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      fireEvent.click(screen.getByTitle("Stack vertically (V)"));

      // A single batched call positions all nodes; node-2 (y=100) comes first
      expect(mockOnNodesChange).toHaveBeenCalledWith([
        expect.objectContaining({
          type: "position",
          id: "node-2",
          position: expect.objectContaining({ x: 50 }), // Aligned to leftmost x
        }),
        expect.objectContaining({
          type: "position",
          id: "node-1",
          position: expect.objectContaining({ x: 50 }), // Aligned to leftmost x
        }),
      ]);
    });
  });

  describe("Arrange as Grid", () => {
    it("should call onNodesChange when arrange as grid button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 100, y: 100 } }),
            createMockNode("node-3", { position: { x: 200, y: 200 } }),
            createMockNode("node-4", { position: { x: 300, y: 300 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const gridButton = screen.getByTitle("Arrange as grid (G)");
      fireEvent.click(gridButton);

      expect(mockOnNodesChange).toHaveBeenCalled();
    });

    it("should arrange nodes in a grid pattern", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 500, y: 0 } }),
            createMockNode("node-3", { position: { x: 0, y: 500 } }),
            createMockNode("node-4", { position: { x: 500, y: 500 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      fireEvent.click(screen.getByTitle("Arrange as grid (G)"));

      // With 4 nodes, should create a 2x2 grid
      expect(mockOnNodesChange).toHaveBeenCalled();
    });
  });

  describe("Spacing control", () => {
    it.each([
      ["Stack horizontally (H)", { x: 300, y: 0 }, { x: 600, y: 0 }],
      ["Stack vertically (V)", { x: 0, y: 280 }, { x: 0, y: 560 }],
      ["Arrange as grid (G)", { x: 300, y: 0 }, { x: 0, y: 280 }],
    ])("adjusts spacing live for %s", (title, secondPosition, thirdPosition) => {
      const nodes = [
        createMockNode("node-1", { position: { x: 0, y: 0 } }),
        createMockNode("node-2", { position: { x: 400, y: 400 } }),
        createMockNode("node-3", { position: { x: 800, y: 800 } }),
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);

      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTitle(title));
      const slider = screen.getByRole("slider", { name: "Node spacing" });
      expect(slider).toHaveValue("20");
      fireEvent.change(slider, { target: { value: "80" } });

      expect(mockOnNodesChange).toHaveBeenLastCalledWith([
        { type: "position", id: "node-1", position: { x: 0, y: 0 } },
        { type: "position", id: "node-2", position: secondPosition },
        { type: "position", id: "node-3", position: thirdPosition },
      ]);
      expect(slider).toHaveAttribute("aria-valuetext", "80 pixels");
    });

    it("keeps the control anchored during layout updates and clears it on selection change", () => {
      // The mocked store has no subscription to bypass React.memo on updates.
      const Toolbar = (MultiSelectToolbar as unknown as { type: typeof MultiSelectToolbar }).type;
      let nodes = [
        createMockNode("node-1", { position: { x: 0, y: 0 } }),
        createMockNode("node-2", { position: { x: 400, y: 400 } }),
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes })));
      const { container, rerender } = render(<TestWrapper><Toolbar /></TestWrapper>);
      fireEvent.click(screen.getByTitle("Stack horizontally (H)"));
      const originalLeft = (container.firstChild as HTMLElement).style.left;
      nodes = nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } }));
      rerender(<TestWrapper><Toolbar /></TestWrapper>);
      expect((container.firstChild as HTMLElement).style.left).toBe(originalLeft);
      expect(screen.getByRole("slider")).toBeInTheDocument();

      nodes = [nodes[0], createMockNode("node-3")];
      rerender(<TestWrapper><Toolbar /></TestWrapper>);
      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    });
  });

  describe("Create Group", () => {
    it("should call createGroup with selected node IDs when create group button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const createGroupButton = screen.getByTitle("Create group");
      fireEvent.click(createGroupButton);

      expect(mockCreateGroup).toHaveBeenCalledWith(["node-1", "node-2"]);
    });

    it("should show ungroup button when selected nodes are in a group", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 }, groupId: "group-1" }),
            createMockNode("node-2", { position: { x: 300, y: 0 }, groupId: "group-1" }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Remove from group")).toBeInTheDocument();
      expect(screen.queryByTitle("Create group")).not.toBeInTheDocument();
    });

    it("should call removeNodesFromGroup when ungroup button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 }, groupId: "group-1" }),
            createMockNode("node-2", { position: { x: 300, y: 0 }, groupId: "group-1" }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const ungroupButton = screen.getByTitle("Remove from group");
      fireEvent.click(ungroupButton);

      expect(mockRemoveNodesFromGroup).toHaveBeenCalledWith(["node-1", "node-2"]);
    });

    it("should show ungroup button when at least one selected node is in a group", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 }, groupId: "group-1" }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }), // Not in a group
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Remove from group")).toBeInTheDocument();
    });
  });

  describe("Download Images", () => {
    it("should render download images button", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 300, y: 0 } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByTitle("Download images as ZIP")).toBeInTheDocument();
    });

    it("should not download when no images are available", async () => {
      // Mock URL.createObjectURL and URL.revokeObjectURL
      const createObjectURLSpy = vi.fn();
      const revokeObjectURLSpy = vi.fn();
      global.URL.createObjectURL = createObjectURLSpy;
      global.URL.revokeObjectURL = revokeObjectURLSpy;

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "test" } }),
            createMockNode("node-2", { type: "prompt", position: { x: 300, y: 0 }, data: { prompt: "test2" } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download images as ZIP");
      fireEvent.click(downloadButton);

      // Should not create object URL when no images
      expect(createObjectURLSpy).not.toHaveBeenCalled();
    });
  });

  describe("Toolbar Position", () => {
    it("should position toolbar based on selected nodes bounding box", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 100, y: 200 } }),
            createMockNode("node-2", { position: { x: 400, y: 200 } }),
          ],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const toolbar = container.firstChild as HTMLElement;
      expect(toolbar).toHaveStyle({ transform: "translateX(-50%)" });
    });

    it("should account for viewport zoom in positioning", () => {
      mockGetViewport.mockReturnValue({ x: 100, y: 50, zoom: 2 });

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { position: { x: 0, y: 0 } }),
            createMockNode("node-2", { position: { x: 200, y: 0 } }),
          ],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const toolbar = container.firstChild as HTMLElement;
      expect(toolbar).toBeInTheDocument();
    });
  });
});
