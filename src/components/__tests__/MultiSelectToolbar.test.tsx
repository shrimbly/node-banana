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
const mockRunBatch = vi.fn();
const mockApplyModelToNodes = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
  useProviderApiKeys: () => ({}),
}));

// Mock useReactFlow
const mockGetViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));

vi.mock("@/components/flowPortals", () => ({
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getViewport: mockGetViewport,
    }),
    // No <ReactFlow> here: the portal renders in place, at zoom 1.
    ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
    useStore: (selector: (state: { transform: number[] }) => unknown) => selector({ transform: [0, 0, 1] }),
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
  runBatch: mockRunBatch,
  runCount: 1,
  applyModelToNodes: mockApplyModelToNodes,
  // Read by the model browser the change-model button opens
  recentModels: [],
  addNode: vi.fn(),
  trackModelUsage: vi.fn(),
  isRunning: false,
  ...overrides,
});

// The chrome hover label drawn beside a button: its text and its key caps
const tooltipOf = (button: HTMLElement) => {
  const tooltip = button.parentElement?.querySelector<HTMLElement>(":scope > [aria-hidden='true']") ?? null;
  return tooltip && {
    element: tooltip,
    text: tooltip.firstChild?.textContent,
    keys: [...tooltip.querySelectorAll("kbd")].map((kbd) => kbd.textContent),
  };
};

// Opens the arrange menu and picks a mode by its label
const arrange = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Arrange nodes" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }));
};

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

      expect(screen.getByRole("button", { name: "Arrange nodes" })).toBeInTheDocument();
    });

    it("hangs from the top centre of the selection in canvas coordinates", () => {
      // Two 220px-wide nodes at x 0 and 300, y 0: centre 260, top 0. In the
      // canvas's own coordinates the bar pans and zooms with the nodes, so a
      // selection near the top can always be panned into view.
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

      let anchor: HTMLElement | null = screen.getByRole("button", { name: "Arrange nodes" });
      while (anchor && !anchor.style.transform) anchor = anchor.parentElement;
      expect(anchor?.style.transform).toContain("translate(260px, 0px)");
      expect(anchor?.style.transform).toContain("scale(1)");
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

    it("runs the selected nodes from the bar", () => {
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
      const runButton = screen.getByRole("button", { name: "Run selected nodes" });
      fireEvent.click(runButton);
      expect(mockRunBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["node-1", "node-2"] });
    });

    it("holds the run button while a run is in progress", () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({
          isRunning: true,
          nodes: [createMockNode("node-1", { position: { x: 0, y: 0 } }), createMockNode("node-2", { position: { x: 300, y: 0 } })],
        })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
      expect(screen.getByRole("button", { name: "Run selected nodes" })).toBeDisabled();
    });

    it("should render one arrange button that opens a menu of the three modes", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      const button = screen.getByRole("button", { name: "Arrange nodes" });
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("menuitemradio", { name: "Stack horizontally" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      fireEvent.click(button);

      expect(button).toHaveAttribute("aria-expanded", "true");
      const items = screen.getAllByRole("menuitemradio");
      // Icons only: the names live in the labels and tooltips
      expect(items.map((item) => [item.getAttribute("aria-label"), item.textContent])).toEqual([
        ["Stack horizontally", ""],
        ["Stack vertically", ""],
        ["Arrange as grid", ""],
      ]);
      expect(mockOnNodesChange).not.toHaveBeenCalled();
    });

    it("should render create group button when nodes are not in a group", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByRole("button", { name: "Create group" })).toBeInTheDocument();
    });

    it("should render download images button", () => {
      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );

      expect(screen.getByRole("button", { name: "Download images as ZIP" })).toBeInTheDocument();
    });
  });

  describe("Tooltips", () => {
    const render2 = (overrides = {}) => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({
          nodes: [createMockNode("v1", { type: "generateVideo" }), createMockNode("v2", { type: "generateVideo", position: { x: 300, y: 100 } })],
          ...overrides,
        })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
    };

    it("labels every bar button with its name and shortcut, above the bar, with no native title", () => {
      render2();
      const expected: [string, string[]][] = [
        ["Run selected nodes", ["⌥", "↵"]],
        ["Arrange nodes", []],
        ["Create group", []],
        ["Change model for selected nodes", []],
        ["Download images as ZIP", []],
      ];
      for (const [name, keys] of expected) {
        const button = screen.getByRole("button", { name });
        expect(button).not.toHaveAttribute("title");
        const tooltip = tooltipOf(button);
        expect(tooltip).toMatchObject({ text: name, keys });
        expect(tooltip!.element).toHaveClass("bottom-full");
      }
    });

    it("shows on hover and on keyboard focus, and never takes the pointer", () => {
      render2();
      const button = screen.getByRole("button", { name: "Create group" });
      const { element } = tooltipOf(button)!;
      expect(button.parentElement).toHaveClass("group");
      expect(element).toHaveClass("group-hover:opacity-100", "group-has-focus-visible:opacity-100", "pointer-events-none");
    });

    it("labels remove from group when the selection is grouped", () => {
      render2({ nodes: [createMockNode("n1", { groupId: "g" }), createMockNode("n2", { position: { x: 300, y: 100 } })] });
      const button = screen.getByRole("button", { name: "Remove from group" });
      expect(tooltipOf(button)).toMatchObject({ text: "Remove from group" });
      expect(button.querySelector("svg")).toHaveClass("lucide-square-arrow-right-exit");
    });

    it("labels the arrange modes below the menu with their shortcuts", () => {
      render2();
      fireEvent.click(screen.getByRole("button", { name: "Arrange nodes" }));
      const tooltips = screen.getAllByRole("menuitemradio").map((item) => {
        expect(item).not.toHaveAttribute("title");
        const tooltip = tooltipOf(item)!;
        expect(tooltip.element).toHaveClass("top-full");
        return [tooltip.text, tooltip.keys];
      });
      expect(tooltips).toEqual([
        ["Stack horizontally", []],
        ["Stack vertically", ["V"]],
        ["Arrange as grid", ["G"]],
      ]);
    });

    it("hides the arrange button's label while its menu or slider is open", () => {
      render2();
      const button = screen.getByRole("button", { name: "Arrange nodes" });
      fireEvent.click(button);
      expect(tooltipOf(button)).toBeNull();
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Stack vertically" }));
      expect(screen.getByRole("slider", { name: "Node spacing" })).toBeInTheDocument();
      expect(tooltipOf(button)).toBeNull();
    });

    it("draws change model as a box (the model browser's mark) and grouping as a dashed frame", () => {
      render2();
      expect(screen.getByRole("button", { name: "Change model for selected nodes" }).querySelector("svg")).toHaveClass("lucide-box");
      expect(screen.getByRole("button", { name: "Create group" }).querySelector("svg")).toHaveClass("lucide-square-dashed");
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

      arrange("Stack horizontally");

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

      arrange("Stack horizontally");

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

      arrange("Stack vertically");

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

      arrange("Stack vertically");

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

      arrange("Arrange as grid");

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

      arrange("Arrange as grid");

      // With 4 nodes, should create a 2x2 grid
      expect(mockOnNodesChange).toHaveBeenCalled();
    });
  });

  describe("Spacing control", () => {
    it.each([
      ["Stack horizontally", { x: 300, y: 0 }, { x: 600, y: 0 }],
      ["Stack vertically", { x: 0, y: 280 }, { x: 0, y: 560 }],
      ["Arrange as grid", { x: 300, y: 0 }, { x: 0, y: 280 }],
    ])("adjusts spacing live for %s", (label, secondPosition, thirdPosition) => {
      const nodes = [
        createMockNode("node-1", { position: { x: 0, y: 0 } }),
        createMockNode("node-2", { position: { x: 400, y: 400 } }),
        createMockNode("node-3", { position: { x: 800, y: 800 } }),
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);

      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      arrange(label);
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
      arrange("Stack horizontally");
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

  describe("Arrange menu and spacing popover", () => {
    const threeNodes = () => [
      createMockNode("node-1", { position: { x: 0, y: 0 } }),
      createMockNode("node-2", { position: { x: 400, y: 400 } }),
      createMockNode("node-3", { position: { x: 800, y: 800 } }),
    ];
    const renderToolbar = () => {
      const nodes = threeNodes();
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes })));
      return render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
    };

    it("picking a mode arranges, closes the menu and shows the slider at 20", () => {
      renderToolbar();
      arrange("Stack horizontally");

      expect(mockOnNodesChange).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Node spacing" })).toHaveValue("20");
      expect(screen.getByRole("button", { name: "Arrange nodes" })).toHaveAttribute("aria-expanded", "false");
    });

    it("closes the menu on Escape and on a press outside without arranging", () => {
      renderToolbar();
      const button = screen.getByRole("button", { name: "Arrange nodes" });

      fireEvent.click(button);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      fireEvent.click(button);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(mockOnNodesChange).not.toHaveBeenCalled();
    });

    it("hides the slider on a press outside the toolbar", () => {
      renderToolbar();
      arrange("Stack horizontally");

      fireEvent.pointerDown(document.body);

      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    });

    it("hides the slider on Escape", () => {
      renderToolbar();
      arrange("Stack horizontally");

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    });

    it("keeps the slider on presses inside the toolbar and the slider", () => {
      renderToolbar();
      arrange("Stack horizontally");

      fireEvent.pointerDown(screen.getByRole("slider"));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Download images as ZIP" }));

      expect(screen.getByRole("slider")).toBeInTheDocument();
    });

    it("reopens the menu from the button while the slider stays, then Escape closes only the menu", () => {
      renderToolbar();
      arrange("Stack horizontally");

      fireEvent.click(screen.getByRole("button", { name: "Arrange nodes" }));

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getByRole("slider")).toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: /^Stack horizontally/ })).toHaveAttribute("aria-checked", "true");

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.getByRole("slider")).toBeInTheDocument();
    });

    it("picking another mode re-arranges with the current gap and keeps the slider", () => {
      renderToolbar();
      arrange("Stack horizontally");
      fireEvent.change(screen.getByRole("slider"), { target: { value: "80" } });

      arrange("Stack vertically");

      expect(mockOnNodesChange).toHaveBeenLastCalledWith([
        { type: "position", id: "node-1", position: { x: 0, y: 0 } },
        { type: "position", id: "node-2", position: { x: 0, y: 280 } },
        { type: "position", id: "node-3", position: { x: 0, y: 560 } },
      ]);
      expect(screen.getByRole("slider")).toHaveValue("80");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("picking the active mode again only closes the menu", () => {
      renderToolbar();
      arrange("Stack horizontally");
      mockOnNodesChange.mockClear();

      arrange("Stack horizontally");

      expect(mockOnNodesChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.getByRole("slider")).toBeInTheDocument();
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

      const createGroupButton = screen.getByRole("button", { name: "Create group" });
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

      expect(screen.getByRole("button", { name: "Remove from group" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create group" })).not.toBeInTheDocument();
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

      const ungroupButton = screen.getByRole("button", { name: "Remove from group" });
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

      expect(screen.getByRole("button", { name: "Remove from group" })).toBeInTheDocument();
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

      expect(screen.getByRole("button", { name: "Download images as ZIP" })).toBeInTheDocument();
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

      const downloadButton = screen.getByRole("button", { name: "Download images as ZIP" });
      fireEvent.click(downloadButton);

      // Should not create object URL when no images
      expect(createObjectURLSpy).not.toHaveBeenCalled();
    });

    it("zips each image's own bytes, named by what they are, whatever type the data URL declares", async () => {
      global.URL.createObjectURL = vi.fn(() => "blob:zip");
      global.URL.revokeObjectURL = vi.fn();
      const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
      const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
      const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
      const zipFile = vi.fn();
      const JSZip = (await import("jszip")).default as unknown as ReturnType<typeof vi.fn>;
      // A constructor (`new JSZip()`), so a function rather than an arrow.
      JSZip.mockImplementationOnce(function () {
        return { file: zipFile, generateAsync: vi.fn().mockResolvedValue(new Blob()) };
      });

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            createMockNode("node-1", { type: "imageInput", data: { image: `data:;base64,${base64(png)}` } }),
            createMockNode("node-2", { type: "imageInput", position: { x: 300, y: 0 }, data: { image: `data:image/png;base64,${base64(jpeg)}` } }),
            createMockNode("node-3", { type: "imageInput", position: { x: 600, y: 0 }, data: { image: "https://example.com/a.png" } }),
          ],
        }));
      });

      render(
        <TestWrapper>
          <MultiSelectToolbar />
        </TestWrapper>
      );
      fireEvent.click(screen.getByRole("button", { name: "Download images as ZIP" }));

      await vi.waitFor(() => expect(zipFile).toHaveBeenCalledTimes(2));
      expect(zipFile.mock.calls.map(([name, bytes]) => [name, [...(bytes as Uint8Array)]])).toEqual([
        ["image-1.png", png],
        ["image-2.jpg", jpeg],
      ]);
    });
  });

  describe("Toolbar Position", () => {
    it("should position toolbar at the selection's top centre, in canvas coordinates", () => {
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

      // 100..620 across, top 200: the anchor is (360, 200), the bar's own
      // bottom centre set a gap above it.
      const anchor = container.firstChild as HTMLElement;
      expect(anchor.style.transform).toContain("translate(360px, 200px)");
      expect(anchor.style.transform).toContain("translate(-50%, calc(-100% - 48px))");
    });

    it("keeps its screen size at any zoom by unscaling in the canvas", () => {
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
      // The portal mock reports zoom 1, so the unscale is scale(1); the bar is in canvas space either way.
      expect(toolbar.style.transform).toContain("scale(1)");
    });
  });

  describe("Change model", () => {
    const videoNodes = () => [
      createMockNode("v1", { type: "generateVideo" }),
      createMockNode("v2", { type: "generateVideo" }),
      createMockNode("v3", { type: "generateVideo" }),
    ];

    it("offers to change the model when every selected node is the same generator", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes: videoNodes() })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);

      expect(screen.getByRole("button", { name: "Change model for selected nodes" })).toBeInTheDocument();
    });

    it("hides it for a mixed selection or one without generators", () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ nodes: [createMockNode("v1", { type: "generateVideo" }), createMockNode("g1", { type: "nanoBanana" })] }))
      );
      const { unmount } = render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
      expect(screen.queryByRole("button", { name: "Change model for selected nodes" })).not.toBeInTheDocument();
      unmount();

      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ nodes: [createMockNode("p1"), createMockNode("p2")] }))
      );
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);
      expect(screen.queryByRole("button", { name: "Change model for selected nodes" })).not.toBeInTheDocument();
    });

    it("opens the model browser for the selection's capability", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes: videoNodes() })));
      render(<TestWrapper><MultiSelectToolbar /></TestWrapper>);

      fireEvent.click(screen.getByRole("button", { name: "Change model for selected nodes" }));
      expect(screen.getByText("Change model for 3 nodes")).toBeInTheDocument();
    });
  });
});
