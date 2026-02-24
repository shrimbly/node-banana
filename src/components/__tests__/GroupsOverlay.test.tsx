import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GroupBackgroundsPortal, GroupControlsOverlay, GroupsOverlay } from "@/components/GroupsOverlay";
import { Group } from "@/types";

// Mock ReactFlow hooks and components
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    getViewport: () => ({ zoom: 1, x: 0, y: 0 }),
  }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="viewport-portal">{children}</div>
  ),
}));

// Mock the workflow store
const mockUpdateGroup = vi.fn();
const mockDeleteGroup = vi.fn();
const mockDeleteGroupWithNodes = vi.fn();
const mockMoveGroupNodes = vi.fn();
const mockToggleGroupLock = vi.fn();
const mockSetSelectedGroupId = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
  GROUP_COLORS: {
    neutral: "#262626",
    blue: "#1e3a5f",
    green: "#1a3d2e",
    purple: "#2d2458",
    orange: "#3d2a1a",
    red: "#3d1a1a",
  },
}));

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
  selectedGroupId: null,
  setSelectedGroupId: mockSetSelectedGroupId,
  updateGroup: mockUpdateGroup,
  deleteGroup: mockDeleteGroup,
  deleteGroupWithNodes: mockDeleteGroupWithNodes,
  moveGroupNodes: mockMoveGroupNodes,
  toggleGroupLock: mockToggleGroupLock,
  ...overrides,
});

describe("GroupBackgroundsPortal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      // Check that the background style contains the blue color (computed as rgba)
      const style = background.getAttribute("style") || "";
      // Blue color #1e3a5f = rgb(30, 58, 95) with transparency
      expect(style).toContain("30, 58, 95");
      expect(style).toContain("background-color");
      expect(style).toContain("border");
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

    it("should render color picker button", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);
      const colorButton = screen.getByTitle("Change color");
      expect(colorButton).toBeInTheDocument();
    });

    it("should render lock/unlock button", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: false }) },
        }));
      });

      render(<GroupControlsOverlay />);
      const lockButton = screen.getByTitle("Lock group");
      expect(lockButton).toBeInTheDocument();
    });

    it("should render delete button", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);
      const deleteButton = screen.getByTitle("Delete group");
      expect(deleteButton).toBeInTheDocument();
    });
  });

  describe("Group Name Editing", () => {
    it("should enable editing when name is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ name: "Original Name" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Click on name to edit
      fireEvent.click(screen.getByText("Original Name"));

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

      // Click to edit
      fireEvent.click(screen.getByText("Original Name"));

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

      // Click to edit
      fireEvent.click(screen.getByText("Original Name"));

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

      // Click to edit
      fireEvent.click(screen.getByText("Original Name"));

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Blurred Name" } });
      fireEvent.blur(input);

      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { name: "Blurred Name" });
    });
  });

  describe("Lock Toggle", () => {
    it("should show unlock button when group is locked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: true }) },
        }));
      });

      render(<GroupControlsOverlay />);
      expect(screen.getByTitle("Unlock group")).toBeInTheDocument();
    });

    it("should call toggleGroupLock when lock button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ locked: false }) },
        }));
      });

      render(<GroupControlsOverlay />);

      fireEvent.click(screen.getByTitle("Lock group"));
      expect(mockToggleGroupLock).toHaveBeenCalledWith("group-1");
    });
  });

  describe("Color Picker", () => {
    it("should show color picker when color button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ color: "blue" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      fireEvent.click(screen.getByTitle("Change color"));

      // Should show color options (Gray, Blue, Green, Purple, Orange, Red)
      expect(screen.getByTitle("Gray")).toBeInTheDocument();
      expect(screen.getByTitle("Blue")).toBeInTheDocument();
      expect(screen.getByTitle("Green")).toBeInTheDocument();
      expect(screen.getByTitle("Purple")).toBeInTheDocument();
      expect(screen.getByTitle("Orange")).toBeInTheDocument();
      expect(screen.getByTitle("Red")).toBeInTheDocument();
    });

    it("should call updateGroup with new color when color is selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup({ color: "blue" }) },
        }));
      });

      render(<GroupControlsOverlay />);

      // Open color picker
      fireEvent.click(screen.getByTitle("Change color"));

      // Select green
      fireEvent.click(screen.getByTitle("Green"));

      expect(mockUpdateGroup).toHaveBeenCalledWith("group-1", { color: "green" });
    });
  });

  describe("Delete Group", () => {
    it("should call deleteGroupWithNodes when delete button is clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: { "group-1": createMockGroup() },
        }));
      });

      render(<GroupControlsOverlay />);

      fireEvent.click(screen.getByTitle("Delete group"));
      expect(mockDeleteGroupWithNodes).toHaveBeenCalledWith("group-1");
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
