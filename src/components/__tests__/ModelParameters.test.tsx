import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModelParameters } from "@/components/nodes/ModelParameters";
import { ModelParameter } from "@/lib/providers/types";

// Mock deduplicatedFetch to pass through to global fetch (avoids caching issues in tests)
vi.mock("@/utils/deduplicatedFetch", () => ({
  deduplicatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  clearFetchCache: vi.fn(),
}));

// Mock the workflow store
const mockUseWorkflowStore = vi.fn();
const mockUseProviderApiKeys = vi.fn(() => ({
  replicateApiKey: null as string | null,
  falApiKey: null as string | null,
  kieApiKey: null as string | null,
  wavespeedApiKey: null as string | null,
  replicateEnabled: false,
  kieEnabled: false,
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
  useProviderApiKeys: () => mockUseProviderApiKeys(),
}));

// Default store state
const defaultStoreState = {
  providerSettings: {
    providers: {
      replicate: { apiKey: null },
      fal: { apiKey: null },
    },
  },
};

// Helper to create mock parameters
const createMockParameter = (overrides: Partial<ModelParameter> = {}): ModelParameter => ({
  name: "test_param",
  type: "string",
  description: "A test parameter",
  ...overrides,
});

describe("ModelParameters", () => {
  const defaultProps = {
    modelId: "test-model",
    provider: "replicate" as const,
    parameters: {},
    onParametersChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(defaultStoreState);
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("Initial Rendering", () => {
    it("should fetch schema for Gemini provider", () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      );
      render(
        <ModelParameters {...defaultProps} provider="gemini" />
      );
      expect(screen.getByText("Loading parameters...")).toBeInTheDocument();
    });

    it("should not render when modelId is empty", () => {
      const { container } = render(
        <ModelParameters {...defaultProps} modelId="" />
      );
      expect(container.firstChild).toBeNull();
    });

    it("should show loading state while fetching schema", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      );

      render(<ModelParameters {...defaultProps} />);

      expect(screen.getByText("Loading parameters...")).toBeInTheDocument();
    });

    it("should fetch schema on mount", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ parameters: [] }),
      });

      render(<ModelParameters {...defaultProps} modelId="test/model" />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/models/test%2Fmodel?provider=replicate",
          expect.any(Object)
        );
      });
    });
  });

  describe("Error Handling", () => {
    it("should display error message on fetch failure", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: "Failed to load model" }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Failed to load model")).toBeInTheDocument();
      });
    });

    it("should display generic error on network failure", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Network error")
      );

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });
  });

  describe("Empty Parameters", () => {
    it("should not render when schema is empty (no parameters available)", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ parameters: [] }),
      });

      const { container } = render(<ModelParameters {...defaultProps} />);

      // Wait for fetch to complete
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });

      // Component returns null when no parameters and not loading
      // The component logic: if (!isLoading && schema.length === 0 && !error) return null
      // So after loading completes with empty params, it should render nothing
      await waitFor(() => {
        expect(container.firstChild).toBeNull();
      });
    });
  });

  describe("Collapse/Expand", () => {
    it("should start expanded by default", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "test_param" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Test Param")).toBeInTheDocument();
      });
    });

    it("should always show parameters (no collapse header)", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "test_param" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Test Param")).toBeInTheDocument();
      });

      // Component no longer has a collapsible "Parameters" header
      expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    });

    it("should render parameters directly without collapse toggle", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "test_param" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Test Param")).toBeInTheDocument();
      });

      // Parameters are always visible since there is no collapse mechanism
      expect(screen.getByText("Test Param")).toBeInTheDocument();
    });
  });

  describe("Parameter Count Display", () => {
    it("should render all parameters that have values", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({ name: "param1" }),
              createMockParameter({ name: "param2" }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          parameters={{ param1: "value1", param2: "value2" }}
        />
      );

      await waitFor(() => {
        // Both parameters should be rendered with their values
        const inputs = screen.getAllByRole("textbox");
        expect(inputs).toHaveLength(2);
        expect(inputs[0]).toHaveValue("value1");
        expect(inputs[1]).toHaveValue("value2");
      });
    });
  });

  describe("String Input", () => {
    it("should render text input for string parameters", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "prompt", type: "string" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const input = screen.getByRole("textbox");
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute("type", "text");
      });
    });

    it("should call onParametersChange when string value changes", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "prompt", type: "string" })],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeInTheDocument();
      });

      const textbox = screen.getByRole("textbox");
      fireEvent.change(textbox, { target: { value: "new value" } });
      fireEvent.blur(textbox);

      expect(onParametersChange).toHaveBeenCalledWith({ prompt: "new value" });
    });

    it("should show placeholder with default value", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "style",
                type: "string",
                default: "realistic",
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const input = screen.getByRole("textbox");
        expect(input).toHaveAttribute("placeholder", "realistic");
      });
    });
  });

  describe("Number Input", () => {
    it("should render number input for number parameters", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "width", type: "number" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const input = screen.getByRole("spinbutton");
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute("type", "number");
      });
    });

    it("should show min/max range in the label tooltip", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "guidance_scale",
                type: "number",
                minimum: 1,
                maximum: 20,
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Guidance Scale")).toHaveAttribute("title", expect.stringContaining("(1-20)"));
      });
    });

    it("should show validation error when value is below minimum", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "cfg",
                type: "number",
                minimum: 5,
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} parameters={{ cfg: 2 }} />);

      await waitFor(() => {
        expect(screen.getByText("Min: 5")).toBeInTheDocument();
      });
    });

    it("should show validation error when value is above maximum", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "cfg",
                type: "number",
                maximum: 20,
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} parameters={{ cfg: 25 }} />);

      await waitFor(() => {
        expect(screen.getByText("Max: 20")).toBeInTheDocument();
      });
    });

    it("should show validation error when integer has decimal", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "steps",
                type: "integer",
              }),
            ],
          }),
      });

      render(
        <ModelParameters {...defaultProps} parameters={{ steps: 10.5 }} />
      );

      await waitFor(() => {
        expect(screen.getByText("Must be integer")).toBeInTheDocument();
      });
    });
  });

  describe("Boolean Input", () => {
    it("should render checkbox for boolean parameters", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({ name: "apply_watermark", type: "boolean" }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeInTheDocument();
      });
    });

    it("should use schema default when value not set", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "apply_watermark",
                type: "boolean",
                default: true,
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const checkbox = screen.getByRole("checkbox");
        expect(checkbox).toBeChecked();
      });
    });

    it("should call onParametersChange when checkbox is toggled", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({ name: "apply_watermark", type: "boolean" }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onParametersChange).toHaveBeenCalledWith({
        apply_watermark: true,
      });
    });
  });

  describe("Enum/Select Input", () => {
    it("should render select for enum parameters", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "scheduler",
                type: "string",
                enum: ["DDIM", "DPM++", "Euler"],
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox");
        expect(select).toBeInTheDocument();
      });
    });

    it("should render all enum options plus default", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "scheduler",
                type: "string",
                enum: ["DDIM", "DPM++", "Euler"],
              }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      const options = screen.getAllByRole("option");
      expect(options.length).toBe(4);
      expect(options[0]).toHaveTextContent("Default");
      expect(options[1]).toHaveTextContent("DDIM");
      expect(options[2]).toHaveTextContent("DPM++");
      expect(options[3]).toHaveTextContent("Euler");
    });

    it("should call onParametersChange when selection changes", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "scheduler",
                type: "string",
                enum: ["DDIM", "DPM++"],
              }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "DPM++" },
      });

      expect(onParametersChange).toHaveBeenCalledWith({ scheduler: "DPM++" });
    });

    it("should coerce integer enum selection to number", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "max_images",
                type: "integer",
                enum: [1, 2, 3, 4],
              }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "2" },
      });

      // Should be number 2, not string "2"
      expect(onParametersChange).toHaveBeenCalledWith({ max_images: 2 });
    });

    it("should coerce number enum selection to number", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "guidance_scale",
                type: "number",
                enum: [1.5, 2.0, 2.5, 3.0],
              }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "2.5" },
      });

      // Should be number 2.5, not string "2.5"
      expect(onParametersChange).toHaveBeenCalledWith({ guidance_scale: 2.5 });
    });

    it("should clear value when Default is selected from enum", async () => {
      const onParametersChange = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({
                name: "max_images",
                type: "integer",
                enum: [1, 2, 3, 4],
              }),
            ],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          parameters={{ max_images: 2 }}
          onParametersChange={onParametersChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeInTheDocument();
      });

      // Select the "Default" option (empty value)
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "" },
      });

      // Should remove the parameter (clear it)
      expect(onParametersChange).toHaveBeenCalledWith({});
    });
  });

  describe("Parameter Display Names", () => {
    it("should format snake_case to Title Case", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [createMockParameter({ name: "guidance_scale" })],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Guidance Scale")).toBeInTheDocument();
      });
    });
  });

  describe("API Key Headers", () => {
    it("should send Replicate API key header when available", async () => {
      mockUseProviderApiKeys.mockReturnValue({
        replicateApiKey: "test-replicate-key",
        falApiKey: null,
        kieApiKey: null,
        wavespeedApiKey: null,
        replicateEnabled: false,
        kieEnabled: false,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ parameters: [] }),
      });

      render(<ModelParameters {...defaultProps} provider="replicate" />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "X-Replicate-Key": "test-replicate-key",
            }),
          })
        );
      });
    });
  });

  describe("Inputs Loading Callback", () => {
    it("should call onInputsLoaded when inputs are in response", async () => {
      const onInputsLoaded = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [],
            inputs: [
              { name: "image", type: "image", required: true, label: "Image" },
            ],
          }),
      });

      render(
        <ModelParameters {...defaultProps} onInputsLoaded={onInputsLoaded} />
      );

      await waitFor(() => {
        expect(onInputsLoaded).toHaveBeenCalledWith([
          { name: "image", type: "image", required: true, label: "Image" },
        ]);
      });
    });

    it("should fetch schema and call onInputsLoaded for Gemini", async () => {
      const onInputsLoaded = vi.fn();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            parameters: [],
            inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
          }),
      });

      render(
        <ModelParameters
          {...defaultProps}
          provider="gemini"
          onInputsLoaded={onInputsLoaded}
        />
      );

      await waitFor(() => {
        expect(onInputsLoaded).toHaveBeenCalledWith([
          { name: "prompt", type: "text", required: true, label: "Prompt" },
        ]);
      });
    });
  });

  describe("Multiple Parameters", () => {
    it("should render multiple parameters of different types", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            parameters: [
              createMockParameter({ name: "prompt", type: "string" }),
              createMockParameter({ name: "width", type: "integer" }),
              createMockParameter({
                name: "scheduler",
                type: "string",
                enum: ["DDIM", "Euler"],
              }),
              createMockParameter({ name: "apply_watermark", type: "boolean" }),
            ],
          }),
      });

      render(<ModelParameters {...defaultProps} />);

      await waitFor(() => {
        // Text input
        expect(screen.getByRole("textbox")).toBeInTheDocument();
        // Number input
        expect(screen.getByRole("spinbutton")).toBeInTheDocument();
        // Select
        expect(screen.getByRole("combobox")).toBeInTheDocument();
        // Checkbox
        expect(screen.getByRole("checkbox")).toBeInTheDocument();
      });
    });
  });
});
