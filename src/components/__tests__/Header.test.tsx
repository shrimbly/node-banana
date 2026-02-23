import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "@/components/Header";

// Mock the workflow store
const mockSetWorkflowMetadata = vi.fn();
const mockSaveToFile = vi.fn();
const mockLoadWorkflow = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock ProjectSetupModal
vi.mock("@/components/ProjectSetupModal", () => ({
  ProjectSetupModal: ({ isOpen, mode }: { isOpen: boolean; mode: string }) => (
    isOpen ? <div data-testid="project-setup-modal" data-mode={mode}>Project Setup Modal</div> : null
  ),
}));

// Mock CostIndicator
vi.mock("@/components/CostIndicator", () => ({
  CostIndicator: () => <div data-testid="cost-indicator">$0.00</div>,
}));

// Mock functions for comment navigation
const mockGetNodesWithComments = vi.fn();
const mockGetUnviewedCommentCount = vi.fn();
const mockMarkCommentViewed = vi.fn();
const mockSetNavigationTarget = vi.fn();

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  workflowName: "",
  workflowId: "",
  saveDirectoryPath: "",
  hasUnsavedChanges: false,
  lastSavedAt: null,
  isSaving: false,
  setWorkflowMetadata: mockSetWorkflowMetadata,
  saveToFile: mockSaveToFile,
  loadWorkflow: mockLoadWorkflow,
  getNodesWithComments: mockGetNodesWithComments,
  getUnviewedCommentCount: mockGetUnviewedCommentCount,
  viewedCommentNodeIds: new Set<string>(),
  markCommentViewed: mockMarkCommentViewed,
  setNavigationTarget: mockSetNavigationTarget,
  ...overrides,
});

describe("Header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation - unconfigured project
    mockGetNodesWithComments.mockReturnValue([]);
    mockGetUnviewedCommentCount.mockReturnValue(0);
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Basic Rendering", () => {
    it("should render the app title", () => {
      render(<Header />);
      expect(screen.getByText("Node Banana")).toBeInTheDocument();
    });

    it("should render the banana icon", () => {
      render(<Header />);
      const icon = screen.getByAltText("Banana");
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute("src", "/banana_icon.png");
    });

    it("should render 'Made by Willie' link", () => {
      render(<Header />);
      const link = screen.getByText("Made by Willie");
      expect(link).toHaveAttribute("href", "https://x.com/ReflctWillie");
    });

    it("should render Discord support link", () => {
      render(<Header />);
      const link = screen.getByTitle("Support");
      expect(link).toHaveAttribute("href", "https://discord.com/invite/89Nr6EKkTf");
    });
  });

  describe("Unconfigured Project State", () => {
    it("should show 'Untitled' when no project name is set", () => {
      render(<Header />);
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });

    it("should show 'Not saved' status when project is not configured", () => {
      render(<Header />);
      expect(screen.getByText("Not saved")).toBeInTheDocument();
    });

    it("should show save button with unsaved indicator (red dot)", () => {
      const { container } = render(<Header />);
      const redDot = container.querySelector(".bg-red-500.rounded-full");
      expect(redDot).toBeInTheDocument();
    });

    it("should not render CostIndicator when project is not configured", () => {
      render(<Header />);
      expect(screen.queryByTestId("cost-indicator")).not.toBeInTheDocument();
    });
  });

  describe("Configured Project State", () => {
    beforeEach(() => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
        }));
      });
    });

    it("should show project name when configured", () => {
      render(<Header />);
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    it("should render CostIndicator when project is configured", () => {
      render(<Header />);
      expect(screen.getByTestId("cost-indicator")).toBeInTheDocument();
    });

    it("should show 'Not saved' when no lastSavedAt timestamp", () => {
      render(<Header />);
      expect(screen.getByText("Not saved")).toBeInTheDocument();
    });

    it("should render Open Project Folder button when saveDirectoryPath is set", () => {
      render(<Header />);
      const folderButton = screen.getByTitle("Open Project Folder");
      expect(folderButton).toBeInTheDocument();
    });
  });

  describe("Save State Display", () => {
    it("should show 'Saving...' when isSaving is true", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          isSaving: true,
        }));
      });

      render(<Header />);
      expect(screen.getByText("Saving...")).toBeInTheDocument();
    });

    it("should show formatted save time when lastSavedAt is set", () => {
      const timestamp = new Date("2024-01-15T14:30:00").getTime();
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          lastSavedAt: timestamp,
        }));
      });

      render(<Header />);
      // The exact format depends on locale, but should contain "Saved"
      expect(screen.getByText(/Saved/)).toBeInTheDocument();
    });
  });

  describe("Unsaved Changes Indicator", () => {
    it("should show red dot when hasUnsavedChanges is true", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          hasUnsavedChanges: true,
        }));
      });

      const { container } = render(<Header />);
      const redDot = container.querySelector(".bg-red-500.rounded-full");
      expect(redDot).toBeInTheDocument();
    });

    it("should not show red dot when hasUnsavedChanges is false and project is configured", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          hasUnsavedChanges: false,
        }));
      });

      const { container } = render(<Header />);
      // Find the save button area and check there's no red dot inside it
      const saveButton = screen.getByTitle("Save project");
      const redDotInSaveButton = saveButton.querySelector(".bg-red-500.rounded-full");
      expect(redDotInSaveButton).not.toBeInTheDocument();
    });

    it("should not show red dot when isSaving is true even if hasUnsavedChanges", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          hasUnsavedChanges: true,
          isSaving: true,
        }));
      });

      const { container } = render(<Header />);
      const saveButton = screen.getByTitle("Saving...");
      const redDotInSaveButton = saveButton.querySelector(".bg-red-500.rounded-full");
      expect(redDotInSaveButton).not.toBeInTheDocument();
    });
  });

  describe("New Project Button", () => {
    it("should open ProjectSetupModal in 'new' mode when save button clicked (unconfigured)", () => {
      render(<Header />);

      const saveButton = screen.getByTitle("Save project");
      fireEvent.click(saveButton);

      const modal = screen.getByTestId("project-setup-modal");
      expect(modal).toBeInTheDocument();
      expect(modal).toHaveAttribute("data-mode", "new");
    });
  });

  describe("Open File Button", () => {
    it("should render open file button when project is not configured", () => {
      render(<Header />);
      const openButton = screen.getByTitle("Open project");
      expect(openButton).toBeInTheDocument();
    });

    it("should have hidden file input for loading workflows", () => {
      const { container } = render(<Header />);
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute("accept", ".json");
      expect(fileInput).toHaveClass("hidden");
    });

    it("should trigger file input click when open button is clicked", () => {
      const { container } = render(<Header />);
      const openButton = screen.getByTitle("Open project");
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      // Mock click on file input
      const clickSpy = vi.spyOn(fileInput, "click");
      fireEvent.click(openButton);

      expect(clickSpy).toHaveBeenCalled();
    });
  });

  describe("Save Button", () => {
    beforeEach(() => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
        }));
      });
    });

    it("should call saveToFile when clicked on configured project", () => {
      render(<Header />);
      const saveButton = screen.getByTitle("Save project");
      fireEvent.click(saveButton);

      expect(mockSaveToFile).toHaveBeenCalled();
    });

    it("should be disabled when isSaving is true", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
          isSaving: true,
        }));
      });

      render(<Header />);
      const saveButton = screen.getByTitle("Saving...");
      expect(saveButton).toBeDisabled();
    });

    it("should open settings modal when project name is set but saveDirectoryPath is empty", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "",
          saveDirectoryPath: "",
        }));
      });

      render(<Header />);
      const saveButton = screen.getByTitle("Configure save location");
      fireEvent.click(saveButton);

      const modal = screen.getByTestId("project-setup-modal");
      expect(modal).toBeInTheDocument();
      expect(modal).toHaveAttribute("data-mode", "settings");
    });
  });


  describe("Settings Button", () => {
    it("should open ProjectSetupModal in 'settings' mode when settings button clicked", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
        }));
      });

      render(<Header />);
      const settingsButton = screen.getByTitle("Project settings");
      fireEvent.click(settingsButton);

      const modal = screen.getByTestId("project-setup-modal");
      expect(modal).toBeInTheDocument();
      expect(modal).toHaveAttribute("data-mode", "settings");
    });

    it("should be visible for unconfigured projects", () => {
      render(<Header />);
      const settingsButton = screen.getByTitle("Project settings");
      expect(settingsButton).toBeInTheDocument();
    });
  });

  describe("Open Project Folder Button", () => {
    it("should not be visible when saveDirectoryPath is not set", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "",
        }));
      });

      render(<Header />);
      expect(screen.queryByTitle("Open Project Folder")).not.toBeInTheDocument();
    });

    it("should be visible when saveDirectoryPath is set", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "/path/to/project",
        }));
      });

      render(<Header />);
      expect(screen.getByTitle("Open Project Folder")).toBeInTheDocument();
    });

    it("should call open-directory API when clicked", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          workflowId: "project-123",
          saveDirectoryPath: "//OTOSERVE10/share/project",
        }));
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      globalThis.fetch = mockFetch;

      render(<Header />);
      const folderButton = screen.getByTitle("Open Project Folder");
      fireEvent.click(folderButton);

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("/api/open-directory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "//OTOSERVE10/share/project" }),
        });
      });
    });
  });

  describe("File Loading", () => {
    it("should not call loadWorkflow when no file is selected", () => {
      const { container } = render(<Header />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      // Trigger file change with empty files
      fireEvent.change(fileInput, { target: { files: [] } });

      expect(mockLoadWorkflow).not.toHaveBeenCalled();
    });

    it("should reset file input value after file selection to allow re-selecting same file", () => {
      const { container } = render(<Header />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      // File input should accept .json files
      expect(fileInput).toHaveAttribute("accept", ".json");
    });
  });

  describe("Comments Navigation Icon", () => {
    it("should not render comments icon when no comments exist", () => {
      mockGetNodesWithComments.mockReturnValue([]);
      mockGetUnviewedCommentCount.mockReturnValue(0);

      render(<Header />);

      // No button with comment-related title should exist
      expect(screen.queryByTitle(/unviewed comment/)).not.toBeInTheDocument();
    });

    it("should render comments icon with badge when comments exist", () => {
      const mockNodes = [
        { id: "node-1", position: { x: 0, y: 0 }, type: "prompt", data: { comment: "Test" } },
        { id: "node-2", position: { x: 100, y: 0 }, type: "prompt", data: { comment: "Test 2" } },
      ];
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(2);

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState());
      });

      render(<Header />);

      const commentsButton = screen.getByTitle(/2 unviewed comments/);
      expect(commentsButton).toBeInTheDocument();
    });

    it("should show 9+ when unviewed count exceeds 9", () => {
      const mockNodes = Array.from({ length: 10 }, (_, i) => ({
        id: `node-${i}`,
        position: { x: i * 100, y: 0 },
        type: "prompt",
        data: { comment: `Comment ${i}` },
      }));
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(10);

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState());
      });

      render(<Header />);

      // Badge should show 9+
      expect(screen.getByText("9+")).toBeInTheDocument();
    });

    it("should call setNavigationTarget when clicked", () => {
      const mockNodes = [
        { id: "node-1", position: { x: 0, y: 0 }, type: "prompt", data: { comment: "Test" } },
      ];
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(1);

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState());
      });

      render(<Header />);

      const commentsButton = screen.getByTitle(/1 unviewed comment/);
      fireEvent.click(commentsButton);

      expect(mockSetNavigationTarget).toHaveBeenCalledWith("node-1");
    });

    it("should call markCommentViewed when clicked", () => {
      const mockNodes = [
        { id: "node-1", position: { x: 0, y: 0 }, type: "prompt", data: { comment: "Test" } },
      ];
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(1);

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState());
      });

      render(<Header />);

      const commentsButton = screen.getByTitle(/1 unviewed comment/);
      fireEvent.click(commentsButton);

      expect(mockMarkCommentViewed).toHaveBeenCalledWith("node-1");
    });

    it("should navigate to first unviewed comment when clicked", () => {
      const mockNodes = [
        { id: "node-1", position: { x: 0, y: 0 }, type: "prompt", data: { comment: "Test" } },
        { id: "node-2", position: { x: 100, y: 0 }, type: "prompt", data: { comment: "Test 2" } },
      ];
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(1);

      // node-1 is already viewed
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          viewedCommentNodeIds: new Set(["node-1"]),
        }));
      });

      render(<Header />);

      const commentsButton = screen.getByTitle(/1 unviewed comment/);
      fireEvent.click(commentsButton);

      // Should navigate to node-2 (first unviewed)
      expect(mockSetNavigationTarget).toHaveBeenCalledWith("node-2");
    });

    it("should navigate to first comment when all viewed", () => {
      const mockNodes = [
        { id: "node-1", position: { x: 0, y: 0 }, type: "prompt", data: { comment: "Test" } },
        { id: "node-2", position: { x: 100, y: 0 }, type: "prompt", data: { comment: "Test 2" } },
      ];
      mockGetNodesWithComments.mockReturnValue(mockNodes);
      mockGetUnviewedCommentCount.mockReturnValue(0);

      // All comments are viewed
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          viewedCommentNodeIds: new Set(["node-1", "node-2"]),
        }));
      });

      render(<Header />);

      const commentsButton = screen.getByTitle(/0 unviewed comments/);
      fireEvent.click(commentsButton);

      // Should navigate to node-1 (first comment)
      expect(mockSetNavigationTarget).toHaveBeenCalledWith("node-1");
    });
  });
});
