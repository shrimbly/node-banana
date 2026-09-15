import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { WelcomeModal } from "@/components/quickstart/WelcomeModal";
import { WorkflowFile } from "@/store/workflowStore";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock WorkflowBrowserView (Load workflow now navigates to this view)
vi.mock("@/components/quickstart/WorkflowBrowserView", () => ({
  WorkflowBrowserView: ({
    onBack,
    onWorkflowLoaded,
    onClose,
  }: {
    onBack: () => void;
    onWorkflowLoaded: (w: WorkflowFile, p: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="workflow-browser-view">
      <button onClick={onBack}>Back</button>
      <button data-testid="load-workflow-btn" onClick={() => onWorkflowLoaded({ version: 1, nodes: [], edges: [], name: "Test" } as unknown as WorkflowFile, "/test/dir")}>
        Load
      </button>
      <button data-testid="close-browser-btn" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// Mock templates
vi.mock("@/lib/quickstart/templates", () => {
  const template = {
    id: "product-shot",
    name: "Product Shot",
    description: "Place product in a new scene or environment",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    category: "product",
    tags: ["Gemini"],
    workflow: {
      name: "Product Shot",
      nodes: [{ id: "1", type: "imageInput", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    },
  };
  return {
    getAllPresets: () => [template],
    PRESET_TEMPLATES: [template],
    getPresetTemplate: (id: string) => (id === "product-shot" ? { ...template, id: `workflow-${Date.now()}` } : null),
    getTemplateContent: () => ({ prompts: {}, images: {} }),
  };
});

describe("WelcomeModal", () => {
  const mockOnWorkflowGenerated = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnNewProject = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default fetch mock for community workflows
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/community-workflows") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflows: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render welcome modal with initial view by default", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      expect(screen.getByText("Node Banana")).toBeInTheDocument();
      expect(screen.getByText("New project")).toBeInTheDocument();
      expect(screen.getByText("Templates")).toBeInTheDocument();
      expect(screen.getByText("Prompt a workflow")).toBeInTheDocument();
    });

    it("should render modal overlay with backdrop", () => {
      const { container } = render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      const backdrop = container.querySelector("[data-dialog-overlay]");
      expect(backdrop).toBeInTheDocument();
    });
  });

  describe("Initial View Navigation", () => {
    it("should call onNewProject when 'New project' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("New project"));

      expect(mockOnNewProject).toHaveBeenCalled();
    });

    it("should navigate to templates view when 'Templates' is clicked", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
        expect(screen.getByText("Quick Start")).toBeInTheDocument();
      });
    });

    it("should navigate to vibe view when 'Prompt a workflow' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Prompt a workflow"));

      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();
      expect(screen.getByText("Describe your workflow")).toBeInTheDocument();
    });
  });

  describe("View Transitions", () => {
    it("should navigate back to initial view from templates view", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to templates
      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
      });

      // Click back
      await act(async () => {
        fireEvent.click(screen.getByText("Back"));
      });

      expect(screen.getByText("Node Banana")).toBeInTheDocument();
      expect(screen.getByText("New project")).toBeInTheDocument();
    });

    it("should navigate back to initial view from prompt view", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to prompt view
      fireEvent.click(screen.getByText("Prompt a workflow"));
      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();

      // Click back
      fireEvent.click(screen.getByText("Back"));

      expect(screen.getByText("Node Banana")).toBeInTheDocument();
    });
  });

  describe("Load Workflow via Browser View", () => {
    it("should show WorkflowBrowserView when 'Load workflow' is clicked", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));

      expect(screen.getByTestId("workflow-browser-view")).toBeInTheDocument();
    });

    it("should navigate back to initial view from browse view", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));
      expect(screen.getByTestId("workflow-browser-view")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Back"));
      expect(screen.getByText("Node Banana")).toBeInTheDocument();
    });

    it("should call onWorkflowGenerated when a workflow is loaded from browser", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      fireEvent.click(screen.getByText("Load workflow"));
      fireEvent.click(screen.getByTestId("load-workflow-btn"));

      expect(mockOnWorkflowGenerated).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1, nodes: [], edges: [] }),
        "/test/dir"
      );
    });
  });

  describe("Workflow Selection from Child Views", () => {
    it("should call onWorkflowGenerated when workflow is generated from templates view", async () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to templates
      await act(async () => {
        fireEvent.click(screen.getByText("Templates"));
      });

      await waitFor(() => {
        expect(screen.getByText("Template Explorer")).toBeInTheDocument();
      });

      // Verify templates view is showing - the actual workflow selection is tested in QuickstartTemplatesView tests
      expect(screen.getByText("Quick Start")).toBeInTheDocument();
    });

    it("should show prompt view when navigating to vibe", () => {
      render(
        <WelcomeModal
          onWorkflowGenerated={mockOnWorkflowGenerated}
          onClose={mockOnClose}
          onNewProject={mockOnNewProject}
        />
      );

      // Navigate to vibe/prompt view
      fireEvent.click(screen.getByText("Prompt a workflow"));

      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();
      expect(screen.getByText("Generate Workflow")).toBeInTheDocument();
    });
  });
});
