import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TemplateGalleryModal } from "@/components/modals/TemplateGalleryModal";
import { WorkflowFile } from "@/store/workflowStore";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock useWorkflowStore
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: () => ({
    incrementModalCount: mockIncrementModalCount,
    decrementModalCount: mockDecrementModalCount,
  }),
}));

// Mock templates
vi.mock("@/lib/quickstart/templates", () => ({
  getAllPresets: () => [
    {
      id: "product-shot",
      name: "Product Shot",
      description: "Place product in a new scene",
      icon: "M20 7l-8-4-8 4",
    },
    {
      id: "background-swap",
      name: "Background Swap",
      description: "Change image backgrounds",
      icon: "M4 16l4.586-4.586",
    },
  ],
}));

describe("TemplateGalleryModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTemplateSelected = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for community workflows
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/community-workflows") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              workflows: [
                { id: "comm-1", name: "Community Flow", author: "testuser" },
              ],
            }),
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

  describe("Rendering", () => {
    it("should not render when isOpen is false", () => {
      render(
        <TemplateGalleryModal
          isOpen={false}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      expect(screen.queryByText("Template Gallery")).not.toBeInTheDocument();
    });

    it("should render modal when isOpen is true", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Template Gallery")).toBeInTheDocument();
      });
    });

    it("should render search input", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search templates...")
        ).toBeInTheDocument();
      });
    });

    it("should render category filter buttons", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All")).toBeInTheDocument();
        expect(screen.getByText("Quick Start")).toBeInTheDocument();
        expect(screen.getByText("Community")).toBeInTheDocument();
      });
    });

    it("should render preset templates", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
        expect(screen.getByText("Background Swap")).toBeInTheDocument();
      });
    });

    it("should render community templates", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Community Flow")).toBeInTheDocument();
        expect(screen.getByText("@testuser")).toBeInTheDocument();
      });
    });
  });

  describe("Modal Management", () => {
    it("should call incrementModalCount on open", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(mockIncrementModalCount).toHaveBeenCalled();
      });
    });

    it("should call onClose when close button is clicked", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Template Gallery")).toBeInTheDocument();
      });

      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onClose when backdrop is clicked", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Template Gallery")).toBeInTheDocument();
      });

      // Click on the backdrop (the outer div with bg-black/60)
      const backdrop = document.querySelector(".bg-black\\/60");
      if (backdrop) {
        fireEvent.click(backdrop);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });
  });

  describe("Filtering", () => {
    it("should filter templates by search query", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search templates...");
      fireEvent.change(searchInput, { target: { value: "Product" } });

      // Wait for debounced search
      await waitFor(
        () => {
          expect(screen.getByText("Product Shot")).toBeInTheDocument();
          expect(
            screen.queryByText("Background Swap")
          ).not.toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });

    it("should filter by Quick Start category", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Community Flow")).toBeInTheDocument();
      });

      // Get the Quick Start filter button (in the category pills section)
      const quickStartButtons = screen.getAllByText("Quick Start");
      fireEvent.click(quickStartButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
        expect(screen.queryByText("Community Flow")).not.toBeInTheDocument();
      });
    });

    it("should filter by Community category", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      // Get the Community filter button (in the category pills section)
      const communityButtons = screen.getAllByText("Community");
      // The first Community text is the filter button
      fireEvent.click(communityButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Community Flow")).toBeInTheDocument();
        expect(screen.queryByText("Product Shot")).not.toBeInTheDocument();
      });
    });

    it("should show empty state when no templates match", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search templates...");
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });

      await waitFor(
        () => {
          expect(screen.getByText("No templates found")).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });
  });

  describe("Template Selection", () => {
    it("should load preset template when Import is clicked", async () => {
      const mockWorkflow: WorkflowFile = {
        id: "test-id",
        version: 1,
        name: "Product Shot",
        edgeStyle: "curved",
        nodes: [],
        edges: [],
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, workflows: [] }),
          });
        }
        if (url === "/api/quickstart" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ success: true, workflow: mockWorkflow }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      // Find and click the Import button for Product Shot
      const importButtons = screen.getAllByText("Import");
      await act(async () => {
        fireEvent.click(importButtons[0]);
      });

      await waitFor(() => {
        expect(mockOnTemplateSelected).toHaveBeenCalledWith(mockWorkflow);
      });
    });

    it("should load community workflow when Import is clicked", async () => {
      const mockWorkflow: WorkflowFile = {
        id: "comm-1",
        version: 1,
        name: "Community Flow",
        edgeStyle: "curved",
        nodes: [],
        edges: [],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                workflows: [
                  { id: "comm-1", name: "Community Flow", author: "testuser" },
                ],
              }),
          });
        }
        if (url === "/api/community-workflows/comm-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ success: true, workflow: mockWorkflow }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      // Filter to community only to make selection easier
      await waitFor(() => {
        expect(screen.getByText("Community Flow")).toBeInTheDocument();
      });

      // Get the Community filter button
      const communityButtons = screen.getAllByText("Community");
      fireEvent.click(communityButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Community Flow")).toBeInTheDocument();
      });

      const importButton = screen.getByText("Import");
      await act(async () => {
        fireEvent.click(importButton);
      });

      await waitFor(() => {
        expect(mockOnTemplateSelected).toHaveBeenCalledWith(mockWorkflow);
      });
    });

    it("should show loading state while importing", async () => {
      let resolveQuickstart: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, workflows: [] }),
          });
        }
        if (url === "/api/quickstart" && options?.method === "POST") {
          return new Promise((resolve) => {
            resolveQuickstart = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const importButtons = screen.getAllByText("Import");
      await act(async () => {
        fireEvent.click(importButtons[0]);
      });

      // Check for loading state
      expect(screen.getByText("Loading...")).toBeInTheDocument();

      // Resolve to clean up
      resolveQuickstart!({
        ok: true,
        json: () => Promise.resolve({ success: true, workflow: {} }),
      });
    });
  });

  describe("Error Handling", () => {
    it("should show error when template loading fails", async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, workflows: [] }),
          });
        }
        if (url === "/api/quickstart" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: false,
                error: "Template not found",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const importButtons = screen.getAllByText("Import");
      await act(async () => {
        fireEvent.click(importButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByText("Template not found")).toBeInTheDocument();
      });
    });

    it("should allow dismissing error", async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, workflows: [] }),
          });
        }
        if (url === "/api/quickstart" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: false,
                error: "Load failed",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const importButtons = screen.getAllByText("Import");
      await act(async () => {
        fireEvent.click(importButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByText("Load failed")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Dismiss"));

      await waitFor(() => {
        expect(screen.queryByText("Load failed")).not.toBeInTheDocument();
      });
    });
  });

  describe("Preview Modal", () => {
    it("should open preview modal when Preview button is clicked", async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/community-workflows") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, workflows: [] }),
          });
        }
        if (url === "/api/quickstart" && options?.method === "POST") {
          const body = JSON.parse(options.body as string);
          if (body.contentLevel === "empty") {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  success: true,
                  workflow: {
                    nodes: [
                      { type: "imageInput" },
                      { type: "nanoBanana" },
                      { type: "output" },
                    ],
                    edges: [{ id: "e1" }, { id: "e2" }],
                  },
                }),
            });
          }
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      });

      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Product Shot")).toBeInTheDocument();
      });

      const previewButtons = screen.getAllByText("Preview");
      await act(async () => {
        fireEvent.click(previewButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByText("Template Preview")).toBeInTheDocument();
      });
    });
  });

  describe("Footer", () => {
    it("should show template count", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/\d+ templates? available/)).toBeInTheDocument();
      });
    });

    it("should show Discord link for workflow submission", async () => {
      render(
        <TemplateGalleryModal
          isOpen={true}
          onClose={mockOnClose}
          onTemplateSelected={mockOnTemplateSelected}
        />
      );

      await waitFor(() => {
        const link = screen.getByText("Submit your workflow →");
        expect(link).toBeInTheDocument();
        expect(link.closest("a")).toHaveAttribute(
          "href",
          "https://discord.com/invite/89Nr6EKkTf"
        );
      });
    });
  });
});
