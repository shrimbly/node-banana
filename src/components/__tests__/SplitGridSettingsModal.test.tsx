import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitGridSettingsModal } from "@/components/SplitGridSettingsModal";
import { SplitGridNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockAddNode = vi.fn(() => "new-node-id");
const mockOnConnect = vi.fn();
const mockAddEdgeWithType = vi.fn();
const mockGetNodeById = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: () => mockUseWorkflowStore(),
}));

// Default node data
const createDefaultNodeData = (): SplitGridNodeData => ({
  targetCount: 6,
  defaultPrompt: "",
  generateSettings: {
    aspectRatio: "1:1",
    resolution: "1K",
    model: "nano-banana",
    useGoogleSearch: false,
  },
  sourceImage: null,
  childNodeIds: [],
  gridRows: 2,
  gridCols: 3,
  isConfigured: false,
  status: "idle",
  error: null,
});

describe("SplitGridSettingsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNodeById.mockReturnValue({
      id: "test-node",
      position: { x: 100, y: 100 },
    });
    mockUseWorkflowStore.mockReturnValue({
      updateNodeData: mockUpdateNodeData,
      addNode: mockAddNode,
      onConnect: mockOnConnect,
      addEdgeWithType: mockAddEdgeWithType,
      getNodeById: mockGetNodeById,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Visibility and Title", () => {
    it("should render with correct title", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Split Grid Settings")).toBeInTheDocument();
    });
  });

  describe("Grid Layout Selection", () => {
    it("should render all layout options", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("1x2")).toBeInTheDocument();
      expect(screen.getByText("1x3")).toBeInTheDocument();
      expect(screen.getByText("1x4")).toBeInTheDocument();
      expect(screen.getByText("2x1")).toBeInTheDocument();
      expect(screen.getByText("2x2")).toBeInTheDocument();
      expect(screen.getByText("2x3")).toBeInTheDocument();
      expect(screen.getByText("3x2")).toBeInTheDocument();
      expect(screen.getByText("2x4")).toBeInTheDocument();
      expect(screen.getByText("3x3")).toBeInTheDocument();
      expect(screen.getByText("3x4")).toBeInTheDocument();
      expect(screen.getByText("4x3")).toBeInTheDocument();
      expect(screen.getByText("4x4")).toBeInTheDocument();
    });

    it("should highlight selected layout", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Default is 2x3, check its button has the selected styling
      const buttons = screen.getAllByRole("button");
      const selectedButton = buttons.find(btn => btn.textContent?.includes("2x3"));
      expect(selectedButton).toHaveClass("border-blue-500");
    });

    it("should update layout when option is clicked", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Click on 3x3
      const buttons = screen.getAllByRole("button");
      const threeByThreeButton = buttons.find(btn => btn.textContent?.includes("3x3"));
      fireEvent.click(threeByThreeButton!);

      // The custom input area should show target count
      expect(screen.getByText(/= 9 images/)).toBeInTheDocument();
    });

    it("should display grid dimensions description", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Default is 2x3
      expect(screen.getByText(/= 6 images/)).toBeInTheDocument();
    });

    it("should allow selecting 3x2 layout (6 images, portrait orientation)", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Click on 3x2
      const buttons = screen.getAllByRole("button");
      const threeByTwoButton = buttons.find(btn => btn.textContent?.includes("3x2"));
      fireEvent.click(threeByTwoButton!);

      // Should show 3x2 = 6 images
      expect(screen.getByText(/= 6 images/)).toBeInTheDocument();
    });
  });

  describe("Default Prompt", () => {
    it("should render default prompt textarea", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByPlaceholderText(/Enter prompt that will be applied/)).toBeInTheDocument();
    });

    it("should display initial default prompt value", () => {
      const nodeData = createDefaultNodeData();
      nodeData.defaultPrompt = "Test default prompt";

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={nodeData}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter prompt that will be applied/);
      expect(textarea).toHaveValue("Test default prompt");
    });

    it("should update default prompt when typing", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter prompt that will be applied/);
      fireEvent.change(textarea, { target: { value: "New prompt text" } });

      expect(textarea).toHaveValue("New prompt text");
    });

    it("should display helper text about individual editing", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText(/Each prompt node can be edited individually/)).toBeInTheDocument();
    });
  });

  describe("Generate Settings", () => {
    it("should render model select with options", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("Nano Banana")).toBeInTheDocument();
    });

    it("should render aspect ratio select", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Aspect Ratio")).toBeInTheDocument();
    });

    it("should update model when selection changes", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Find model select and change it
      const modelSelects = screen.getAllByRole("combobox");
      const modelSelect = modelSelects[0]; // First select is model
      fireEvent.change(modelSelect, { target: { value: "nano-banana-pro" } });

      expect(modelSelect).toHaveValue("nano-banana-pro");
    });

    it("should show resolution and Google Search options for nano-banana-pro", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Switch to nano-banana-pro
      const modelSelects = screen.getAllByRole("combobox");
      fireEvent.change(modelSelects[0], { target: { value: "nano-banana-pro" } });

      // Resolution and Google Search should now appear
      expect(screen.getByText("Resolution")).toBeInTheDocument();
      expect(screen.getByText("Google Search")).toBeInTheDocument();
    });

    it("should not show resolution and Google Search for nano-banana", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Default is nano-banana
      expect(screen.queryByText("Resolution")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Search")).not.toBeInTheDocument();
    });

    it("should update aspect ratio when selection changes", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      const modelSelects = screen.getAllByRole("combobox");
      const aspectSelect = modelSelects[1]; // Second select is aspect ratio
      fireEvent.change(aspectSelect, { target: { value: "16:9" } });

      expect(aspectSelect).toHaveValue("16:9");
    });

    it("should toggle Google Search checkbox", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Switch to nano-banana-pro first
      const modelSelects = screen.getAllByRole("combobox");
      fireEvent.change(modelSelects[0], { target: { value: "nano-banana-pro" } });

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });
  });

  describe("Cancel Button", () => {
    it("should render Cancel button", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("should call onClose when Cancel is clicked", () => {
      const onClose = vi.fn();

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByText("Cancel"));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Create Button", () => {
    it("should render Create button with target count", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText("Create 6 Generate Sets")).toBeInTheDocument();
    });

    it("should update Create button text when layout changes", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // Click on 3x3
      const buttons = screen.getAllByRole("button");
      const threeByThreeButton = buttons.find(btn => btn.textContent?.includes("3x3") && !btn.textContent?.includes("Create"));
      fireEvent.click(threeByThreeButton!);

      expect(screen.getByText("Create 9 Generate Sets")).toBeInTheDocument();
    });

    it("should create nodes and edges when Create is clicked", () => {
      const onClose = vi.fn();

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByText("Create 6 Generate Sets"));

      // Should create 6 sets of 3 nodes each (imageInput, nanoBanana, prompt)
      expect(mockAddNode).toHaveBeenCalledTimes(18); // 6 * 3 nodes
      expect(mockOnConnect).toHaveBeenCalledTimes(12); // 6 * 2 connections per set
      expect(mockAddEdgeWithType).toHaveBeenCalledTimes(6); // 6 reference edges
      expect(mockUpdateNodeData).toHaveBeenCalled(); // Update split node data
      expect(onClose).toHaveBeenCalled();
    });

    it("should not create nodes if node is not found", () => {
      mockGetNodeById.mockReturnValue(null);
      const onClose = vi.fn();

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={onClose}
        />
      );

      fireEvent.click(screen.getByText("Create 6 Generate Sets"));

      expect(mockAddNode).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("should close modal when Escape is pressed", () => {
      const onClose = vi.fn();

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={onClose}
        />
      );

      // The modal renders via createPortal to document.body, so use document.querySelector
      const modal = document.querySelector(".bg-neutral-800.rounded-lg");
      fireEvent.keyDown(modal!, { key: "Escape" });

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Grid Preview", () => {
    it("should display visual grid preview for each target count option", () => {
      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={createDefaultNodeData()}
          onClose={vi.fn()}
        />
      );

      // The modal renders via createPortal to document.body, so use document.querySelectorAll
      const gridPreviews = document.querySelectorAll(".aspect-video");
      expect(gridPreviews.length).toBe(12); // 12 layout options
    });
  });

  describe("Initial Values", () => {
    it("should use node data values as initial state", () => {
      const nodeData = createDefaultNodeData();
      nodeData.targetCount = 9;
      nodeData.gridRows = 3;
      nodeData.gridCols = 3;
      nodeData.defaultPrompt = "Existing prompt";
      nodeData.generateSettings = {
        aspectRatio: "16:9",
        resolution: "2K",
        model: "nano-banana-pro",
        useGoogleSearch: true,
      };

      render(
        <SplitGridSettingsModal
          nodeId="test-node"
          nodeData={nodeData}
          onClose={vi.fn()}
        />
      );

      // Check target count
      expect(screen.getByText(/= 9 images/)).toBeInTheDocument();

      // Check prompt
      const textarea = screen.getByPlaceholderText(/Enter prompt that will be applied/);
      expect(textarea).toHaveValue("Existing prompt");

      // Check model
      const modelSelects = screen.getAllByRole("combobox");
      expect(modelSelects[0]).toHaveValue("nano-banana-pro");

      // Check aspect ratio
      expect(modelSelects[1]).toHaveValue("16:9");

      // Check Google Search
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeChecked();
    });
  });
});
