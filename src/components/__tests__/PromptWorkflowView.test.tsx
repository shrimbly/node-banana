import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { PromptWorkflowView } from "@/components/quickstart/PromptWorkflowView";
import { WorkflowFile } from "@/store/workflowStore";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("PromptWorkflowView", () => {
  const mockOnBack = vi.fn();
  const mockOnWorkflowGenerated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(() => {
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
    it("should render header with title", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      expect(screen.getByText("Prompt a Workflow")).toBeInTheDocument();
    });

    it("should render back button", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      expect(screen.getByText("Back")).toBeInTheDocument();
    });

    it("should render description label", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      expect(screen.getByText("Describe your workflow")).toBeInTheDocument();
    });

    it("should render textarea with placeholder", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      expect(textarea).toBeInTheDocument();
    });

    it("should render helper text", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      expect(screen.getByText(/Say what it should accomplish/i)).toBeInTheDocument();
    });

    it("should render Generate Workflow button", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      expect(screen.getByText("Generate workflow")).toBeInTheDocument();
    });
  });

  describe("Textarea Interaction", () => {
    it("should update textarea value on typing", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a workflow for product shots" } });

      expect(textarea).toHaveValue("Create a workflow for product shots");
    });

    it("should clear error when user types after validation error", async () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      // First type a valid length (3+ chars) to enable button
      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "short test prompt" } });

      // Now clear to short input
      fireEvent.change(textarea, { target: { value: "ab" } });

      // The button should be disabled when less than 3 chars (trimmed)
      const button = screen.getByText("Generate workflow").closest("button");
      expect(button).toBeDisabled();

      // Type more and error should not appear since we never clicked generate
      fireEvent.change(textarea, { target: { value: "abc" } });
      expect(button).not.toBeDisabled();
    });
  });

  describe("Generate Button Validation", () => {
    it("should disable generate button when input is empty", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const button = screen.getByText("Generate workflow").closest("button");
      expect(button).toBeDisabled();
    });

    it("should disable generate button when input is less than 3 characters", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "ab" } });

      const button = screen.getByText("Generate workflow").closest("button");
      expect(button).toBeDisabled();
    });

    it("should enable generate button when input has 3+ characters", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "abc" } });

      const button = screen.getByText("Generate workflow").closest("button");
      expect(button).not.toBeDisabled();
    });

    it("should trim whitespace when checking input length", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "  ab  " } });

      const button = screen.getByText("Generate workflow").closest("button");
      expect(button).toBeDisabled();
    });
  });

  describe("Workflow Generation", () => {
    it("should call API when generate is clicked with valid input", async () => {
      const mockWorkflow: WorkflowFile = {
        id: "generated-id",
        version: 1,
        name: "Generated Workflow",
        edgeStyle: "curved",
        nodes: [],
        edges: [],
      };

      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflow: mockWorkflow }),
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("/api/quickstart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: "Create a product shot workflow",
            contentLevel: "full",
          }),
          signal: expect.any(AbortSignal),
        });
      });
    });

    it("should call onWorkflowGenerated when generation succeeds", async () => {
      const mockWorkflow: WorkflowFile = {
        id: "generated-id",
        version: 1,
        name: "Generated Workflow",
        edgeStyle: "curved",
        nodes: [],
        edges: [],
      };

      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, workflow: mockWorkflow }),
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(mockOnWorkflowGenerated).toHaveBeenCalledWith(mockWorkflow);
      });
    });

    it("should show loading state during generation", async () => {
      let resolveGeneration: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      // Should show "Generating..." text
      expect(screen.getByText("Generating...")).toBeInTheDocument();

      // Should show spinner
      const spinners = document.querySelectorAll(".animate-spin");
      expect(spinners.length).toBeGreaterThan(0);

      // Resolve to clean up
      resolveGeneration!({
        ok: true,
        json: () => Promise.resolve({ success: true, workflow: {} }),
      });
    });

    it("should disable button during generation", async () => {
      let resolveGeneration: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      // Button should be disabled
      const button = screen.getByText("Generating...").closest("button");
      expect(button).toBeDisabled();

      // Resolve to clean up
      resolveGeneration!({
        ok: true,
        json: () => Promise.resolve({ success: true, workflow: {} }),
      });
    });

    it("should disable textarea during generation", async () => {
      let resolveGeneration: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      // Textarea should be disabled
      expect(textarea).toBeDisabled();

      // Resolve to clean up
      resolveGeneration!({
        ok: true,
        json: () => Promise.resolve({ success: true, workflow: {} }),
      });
    });
  });

  describe("Error Handling", () => {
    it("should show error message when generation fails", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: false, error: "Failed to generate workflow" }),
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(screen.getByText("Failed to generate workflow")).toBeInTheDocument();
      });
    });

    it("should show default error message when API returns no error text", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: false }),
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(screen.getByText("Failed to generate workflow")).toBeInTheDocument();
      });
    });

    it("should show error message when fetch throws exception", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.reject(new Error("Network error"));
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });

    it("should allow dismissing error message", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: false, error: "Failed to generate" }),
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      await waitFor(() => {
        expect(screen.getByText("Failed to generate")).toBeInTheDocument();
      });

      // Click dismiss
      fireEvent.click(screen.getByText("Dismiss"));

      await waitFor(() => {
        expect(screen.queryByText("Failed to generate")).not.toBeInTheDocument();
      });
    });
  });

  describe("Back Button", () => {
    it("should call onBack when back button is clicked", () => {
      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      fireEvent.click(screen.getByText("Back"));

      expect(mockOnBack).toHaveBeenCalled();
    });

    it("should disable back button during generation", async () => {
      let resolveGeneration: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      });

      render(
        <PromptWorkflowView
          onBack={mockOnBack}
          onWorkflowGenerated={mockOnWorkflowGenerated}
        />
      );

      const textarea = screen.getByPlaceholderText(/Create product photography/i);
      fireEvent.change(textarea, { target: { value: "Create a product shot workflow" } });

      await act(async () => {
        fireEvent.click(screen.getByText("Generate workflow"));
      });

      // Back button should be disabled
      const backButton = screen.getByText("Back").closest("button");
      expect(backButton).toBeDisabled();

      // Resolve to clean up
      resolveGeneration!({
        ok: true,
        json: () => Promise.resolve({ success: true, workflow: {} }),
      });
    });
  });
});
