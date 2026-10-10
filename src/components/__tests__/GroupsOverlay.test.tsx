import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  GroupBackgroundsPortal,
  GroupControlsOverlay,
  GroupsOverlay,
  selectViewportZoom,
} from "@/components/GroupsOverlay";
import { Group } from "@/types";

const mockViewport = vi.hoisted(() => ({ zoom: 1 }));

// Mock ReactFlow hooks and components
vi.mock("@/components/flowPortals", () => ({
  ViewportPortal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="viewport-portal">{children}</div>
  ),
}));

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    getViewport: () => ({ zoom: 1, x: 0, y: 0 }),
  }),
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, mockViewport.zoom] }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="viewport-portal">{children}</div>
  ),
}));

// Mock the workflow store
const mockUpdateGroup = vi.fn();
const mockDeleteGroup = vi.fn();
const mockMoveGroupNodes = vi.fn();
const mockToggleGroupLock = vi.fn();
const mockRunBatch = vi.fn();
const mockSetRunCount = vi.fn();
const mockUseWorkflowStore = vi.fn();
const mockGetState = vi.fn(() => ({ nodes: [] as { id: string; groupId?: string }[] }));

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  };
  useWorkflowStore.getState = () => mockGetState();
  return { useWorkflowStore };
});

// Helper to create mock group
const createMockGroup = (overrides: Partial<Group> = {}): Group => ({
  name: "Test Group",
  color: "blue",
  position: { x: 100, y: 100 },
  size: { width: 400, height: 300 },
  nodeIds: ["node-1", "node-2"],
  locked: false,
  ...overrides,
});

// Default store state factory
const createDefaultState = (overrides: { groups?: Record<string, Group> } = {}) => ({
  groups: {},
  updateGroup: mockUpdateGroup,
  deleteGroup: mockDeleteGroup,
  moveGroupNodes: mockMoveGroupNodes,
  toggleGroupLock: mockToggleGroupLock,
  runCount: 1,
  setRunCount: mockSetRunCount,
  runBatch: mockRunBatch,
  isRunning: false,
  ...overrides,
});

describe("GroupBackgroundsPortal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewport.zoom = 1;
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Empty State", () => {
    it("should not render when no groups exist", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ groups: {} }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("Group Background Rendering", () => {
    it("should render group backgrounds inside ViewportPortal", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupBackgroundsPortal />);
      expect(screen.getByTestId("viewport-portal")).toBeInTheDocument();
    });

    it("should render background for each group", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({ name: "Group 1" }),
            "group-2": createMockGroup({ name: "Group 2", position: { x: 200, y: 200 } }),
          },
        }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      // Each group renders a rounded-xl div for background
      const backgrounds = container.querySelectorAll(".rounded-xl");
      expect(backgrounds.length).toBe(2);
    });

    it("should apply group position and size to background", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({
              position: { x: 150, y: 200 },
              size: { width: 500, height: 400 },
            }),
          },
        }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      const background = container.querySelector(".rounded-xl");
      expect(background).toHaveStyle({
        left: "150px",
        top: "200px",
        width: "500px",
        height: "400px",
      });
    });

    it("should apply group color to background", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({ color: "blue" }),
          },
        }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      const background = container.querySelector(".rounded-xl") as HTMLElement;
      // A faint wash of the hue (teal #4f9d93 = rgb(79, 157, 147)) and no outline
      const style = background.getAttribute("style") || "";
      expect(style).toContain("79, 157, 147");
      expect(style).toContain("background-color");
      expect(style).not.toContain("border");
    });

    it("falls back to the neutral hue for a colour key it does not know", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({ color: "teal" as Group["color"] }),
          },
        }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      const background = container.querySelector(".rounded-xl") as HTMLElement;
      expect(background.getAttribute("style")).toContain("138, 146, 156");
    });

    it("should set pointerEvents to none on backgrounds", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      const { container } = render(<GroupBackgroundsPortal />);
      const background = container.querySelector(".rounded-xl");
      expect(background).toHaveStyle({ pointerEvents: "none" });
    });
  });
});

describe("GroupControlsOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewport.zoom = 1;
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Empty State", () => {
    it("should not render when no groups exist", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ groups: {} }));
      });

      const { container } = render(<GroupControlsOverlay />);
      expect(container.firstChild).toBeNull();
    });
  });

  it("selects only zoom from viewport state", () => {
    expect(selectViewportZoom({ transform: [125, -80, 0.4] } as never)).toBe(0.4);
  });

  it("keeps group titles but omits interactive controls at overview zoom", () => {
    mockViewport.zoom = 0.1;
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(
        createDefaultState({ groups: { "group-1": createMockGroup({ name: "Overview Group" }) } })
      );
    });

    const { container } = render(<GroupControlsOverlay />);

    expect(screen.getByText("Overview Group")).toBeInTheDocument();
    expect(screen.queryByTitle("Group options")).not.toBeInTheDocument();
    expect(container.querySelector(".group-resize-controls")).not.toBeInTheDocument();
  });

  it("keeps overview titles passive", () => {
    mockViewport.zoom = 0.1;
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(
        createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Passive Group" }) },
        })
      )
    );

    render(<GroupControlsOverlay />);
    const title = screen.getByText("Passive Group");

    fireEvent.doubleClick(title);
    fireEvent.mouseDown(title, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 30 });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mockMoveGroupNodes).not.toHaveBeenCalled();
  });

  it("commits an active rename before entering overview mode", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(
        createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        })
      )
    );

    const { rerender } = render(<GroupControlsOverlay />);
    fireEvent.doubleClick(screen.getByText("Original Name"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Renamed Group" } });

    mockViewport.zoom = 0.1;
    rerender(<GroupControlsOverlay />);

    expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { name: "Renamed Group" });
  });

  describe("Group Controls Rendering", () => {
    it("should render controls inside ViewportPortal", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByTestId("viewport-portal")).toBeInTheDocument();
    });

    it("should display group name in header", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "My Test Group" }) },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByText("My Test Group")).toBeInTheDocument();
    });

    it("should render group options menu button", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByTitle("Group options")).toBeInTheDocument();
    });

    it("should show menu items when group options button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: false }) },
        }));
      });

      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));

      expect(screen.getByText("Colour")).toBeInTheDocument();
      expect(screen.getByText("Rename")).toBeInTheDocument();
      expect(screen.getByText("Lock")).toBeInTheDocument();
      expect(screen.getByText("NBP input")).toBeInTheDocument();
      expect(screen.getByText("Delete group")).toBeInTheDocument();
    });
  });

  describe("Group Name Editing", () => {
    it("should enable editing when name is double-clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Double-click on name to edit
      fireEvent.doubleClick(screen.getByText("Original Name"));

      // Should show input
      const input = screen.getByRole("textbox");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("Original Name");
    });

    it("should submit name on Enter key", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Double-click to edit
      fireEvent.doubleClick(screen.getByText("Original Name"));

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "New Name" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { name: "New Name" });
    });

    it("should cancel editing on Escape key", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Double-click to edit
      fireEvent.doubleClick(screen.getByText("Original Name"));

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "New Name" } });
      fireEvent.keyDown(input, { key: "Escape" });

      // Should not update
      expect(mockUpdateGroup).not.toHaveBeenCalled();
      // Should show original name again
      expect(screen.getByText("Original Name")).toBeInTheDocument();
    });

    it("should submit name on blur", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Double-click to edit
      fireEvent.doubleClick(screen.getByText("Original Name"));

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Blurred Name" } });
      fireEvent.blur(input);

      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { name: "Blurred Name" });
    });
  });

  describe("Lock Toggle", () => {
    it("marks a locked group in its label and shows the Lock row switched on", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: true }) },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByLabelText("Locked")).toBeInTheDocument();
      fireEvent.click(screen.getByTitle("Group options"));
      expect(screen.getByRole("menuitemcheckbox", { name: /lock/i })).toHaveAttribute("aria-checked", "true");
    });

    it("should call toggleGroupLock when Lock is clicked in menu", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: false }) },
        }));
      });

      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));
      fireEvent.click(screen.getByText("Lock"));
      expect(mockToggleGroupLock).toHaveBeenCalledWith("group-1");
    });
  });

  describe("Color Picker", () => {
    it("shows the six hues as a swatch row at the top of the menu, the current one checked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ color: "blue" }) },
        }));
      });

      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));

      for (const label of ["Slate", "Teal", "Olive", "Plum", "Amber", "Terracotta"]) {
        expect(screen.getByTitle(label)).toBeInTheDocument();
      }
      expect(screen.getByRole("menuitemradio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "Olive" })).toHaveAttribute("aria-checked", "false");
    });

    it("should call updateGroup with new color when color is selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ color: "blue" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      fireEvent.click(screen.getByTitle("Group options"));
      // Olive is the `green` key: the stored value stays the key, not the hue
      fireEvent.click(screen.getByTitle("Olive"));

      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { color: "green" });
      // The menu stays open so colours can be tried against the canvas
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });

  describe("Delete Group", () => {
    it("should call deleteGroup when Delete is clicked in menu", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);

      fireEvent.click(screen.getByTitle("Group options"));
      fireEvent.click(screen.getByText("Delete group"));
      expect(mockDeleteGroup).toHaveBeenCalledWith("group-1");
    });
  });

  describe("Rename and NBP input", () => {
    it("Rename in the menu starts editing the name", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Shots" }) },
        }));
      });

      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));
      fireEvent.click(screen.getByText("Rename"));
      expect(screen.getByDisplayValue("Shots")).toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("NBP input toggles the flag and marks the label", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ isNbpInput: true }) },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByLabelText("NBP input")).toBeInTheDocument();
      fireEvent.click(screen.getByTitle("Group options"));
      const row = screen.getByRole("menuitemcheckbox", { name: /nbp input/i });
      expect(row).toHaveAttribute("aria-checked", "true");
      fireEvent.click(row);
      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { isNbpInput: false });
    });
  });

  describe("Run group", () => {
    it("runs the group's nodes as a batch of the workflow's run count", () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector({ ...createDefaultState({ groups: { "group-1": createMockGroup() } }), runCount: 4 })
      );
      mockGetState.mockReturnValue({
        nodes: [{ id: "node-1", groupId: "group-1" }, { id: "node-2", groupId: "group-1" }, { id: "other" }],
      });

      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));
      expect(screen.getByRole("group", { name: "Runs" })).toHaveTextContent("4");
      fireEvent.click(screen.getByRole("button", { name: "More runs" }));
      expect(mockSetRunCount).toHaveBeenCalledWith(5);

      fireEvent.click(screen.getByText("Run group 4×"));
      expect(mockRunBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["node-1", "node-2"] });
    });

    it("cannot run a locked group", () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ groups: { "group-1": createMockGroup({ locked: true }) } }))
      );
      render(<GroupControlsOverlay />);
      fireEvent.click(screen.getByTitle("Group options"));
      const row = screen.getByText("Run group").closest("button")!;
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute("title", "Unlock the group to run it");
    });
  });

  describe("Multiple Groups", () => {
    it("should render controls for each group", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({ name: "First Group" }),
            "group-2": createMockGroup({ name: "Second Group", position: { x: 500, y: 100 } }),
            "group-3": createMockGroup({ name: "Third Group", position: { x: 100, y: 500 } }),
          },
        }));
      });

      render(<GroupControlsOverlay />);

      expect(screen.getByText("First Group")).toBeInTheDocument();
      expect(screen.getByText("Second Group")).toBeInTheDocument();
      expect(screen.getByText("Third Group")).toBeInTheDocument();
    });

    it("should handle different colors for each group", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": createMockGroup({ name: "Blue Group", color: "blue" }),
            "group-2": createMockGroup({ name: "Red Group", color: "red", position: { x: 500, y: 100 } }),
          },
        }));
      });

      render(<GroupControlsOverlay />);

      expect(screen.getByText("Blue Group")).toBeInTheDocument();
      expect(screen.getByText("Red Group")).toBeInTheDocument();
    });
  });
});

describe("GroupsOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  it("should render GroupControlsOverlay (legacy compatibility)", () => {
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState({
        groups: { "group-1": createMockGroup({ name: "Legacy Group" }) },
      }));
    });

    render(<GroupsOverlay />);
    expect(screen.getByText("Legacy Group")).toBeInTheDocument();
  });
});
