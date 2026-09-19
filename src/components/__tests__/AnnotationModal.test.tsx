import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AnnotationModal } from "@/components/AnnotationModal";
import { ToolType, ToolOptions } from "@/types";

// Mock Konva and react-konva - canvas internals cannot be tested in jsdom
vi.mock("react-konva", () => ({
  Stage: ({ children }: { children: ReactNode }) => <div data-testid="konva-stage">{children}</div>,
  Layer: ({ children }: { children: ReactNode }) => <div data-testid="konva-layer">{children}</div>,
  Image: () => <div data-testid="konva-image" />,
  Rect: () => <div data-testid="konva-rect" />,
  Ellipse: () => <div data-testid="konva-ellipse" />,
  Arrow: () => <div data-testid="konva-arrow" />,
  Line: () => <div data-testid="konva-line" />,
  Text: () => <div data-testid="konva-text" />,
  Transformer: () => <div data-testid="konva-transformer" />,
}));

vi.mock("konva", () => ({
  default: {
    Stage: vi.fn(),
    Layer: vi.fn(),
    Image: vi.fn(),
    Rect: vi.fn(),
    Ellipse: vi.fn(),
    Arrow: vi.fn(),
    Line: vi.fn(),
    Text: vi.fn(),
    Transformer: vi.fn(),
  },
}));

// Mock annotation store
const mockCloseModal = vi.fn();
const mockAddAnnotation = vi.fn();
const mockUpdateAnnotation = vi.fn();
const mockDeleteAnnotation = vi.fn();
const mockClearAnnotations = vi.fn();
const mockSelectShape = vi.fn();
const mockSetCurrentTool = vi.fn();
const mockSetToolOptions = vi.fn();
const mockUndo = vi.fn();
const mockRedo = vi.fn();

const defaultToolOptions: ToolOptions = {
  strokeColor: "#ef4444",
  strokeWidth: 3,
  fillColor: null,
  fontSize: 24,
  opacity: 1,
};

const createMockAnnotationStore = (overrides = {}) => ({
  isModalOpen: true,
  sourceNodeId: "test-node",
  sourceImage: "data:image/png;base64,test",
  annotations: [],
  selectedShapeId: null,
  currentTool: "rectangle" as ToolType,
  toolOptions: defaultToolOptions,
  closeModal: mockCloseModal,
  addAnnotation: mockAddAnnotation,
  updateAnnotation: mockUpdateAnnotation,
  deleteAnnotation: mockDeleteAnnotation,
  clearAnnotations: mockClearAnnotations,
  selectShape: mockSelectShape,
  setCurrentTool: mockSetCurrentTool,
  setToolOptions: mockSetToolOptions,
  undo: mockUndo,
  redo: mockRedo,
  ...overrides,
});

let mockAnnotationStore = createMockAnnotationStore();

vi.mock("@/store/annotationStore", () => ({
  useAnnotationStore: (selector?: (state: ReturnType<typeof createMockAnnotationStore>) => unknown) => {
    if (selector) {
      return selector(mockAnnotationStore);
    }
    return mockAnnotationStore;
  },
}));

// Mock workflow store
const mockUpdateNodeData = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    const state = { updateNodeData: mockUpdateNodeData };
    if (selector) {
      return selector(state);
    }
    return state;
  },
}));

// Mock Image constructor
class MockImage {
  onload: (() => void) | null = null;
  src: string = "";
  width = 800;
  height = 600;

  constructor() {
    setTimeout(() => {
      if (this.onload) this.onload();
    }, 0);
  }
}

// Store original Image to restore later
const OriginalImage = global.Image;

describe("AnnotationModal", () => {
  beforeAll(() => {
    vi.stubGlobal("Image", MockImage);
  });

  afterAll(() => {
    vi.stubGlobal("Image", OriginalImage);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnnotationStore = createMockAnnotationStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Visibility", () => {
    it("should not render when isModalOpen is false", () => {
      mockAnnotationStore = createMockAnnotationStore({ isModalOpen: false });

      render(<AnnotationModal />);

      expect(screen.queryByText("Select")).not.toBeInTheDocument();
    });

    it("should render when isModalOpen is true", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Select")).toBeInTheDocument();
    });
  });

  describe("Tool Buttons", () => {
    it("should render all tool buttons", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Select")).toBeInTheDocument();
      expect(screen.getByText("Rect")).toBeInTheDocument();
      expect(screen.getByText("Circle")).toBeInTheDocument();
      expect(screen.getByText("Arrow")).toBeInTheDocument();
      expect(screen.getByText("Draw")).toBeInTheDocument();
      expect(screen.getByText("Text")).toBeInTheDocument();
    });

    it("should call setCurrentTool when tool button is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Circle"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("circle");
    });

    it("should highlight the current tool", () => {
      mockAnnotationStore = createMockAnnotationStore({ currentTool: "circle" });

      render(<AnnotationModal />);

      const circleButton = screen.getByText("Circle");
      expect(circleButton).toHaveClass("bg-white");
    });

    it("should set tool to select when Select is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Select"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("select");
    });

    it("should set tool to rectangle when Rect is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Rect"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("rectangle");
    });

    it("should set tool to arrow when Arrow is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Arrow"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("arrow");
    });

    it("should set tool to freehand when Draw is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Draw"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("freehand");
    });

    it("should set tool to text when Text is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Text"));

      expect(mockSetCurrentTool).toHaveBeenCalledWith("text");
    });
  });

  describe("Undo/Redo Buttons", () => {
    it("should render Undo and Redo buttons", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Undo")).toBeInTheDocument();
      expect(screen.getByText("Redo")).toBeInTheDocument();
    });

    it("should call undo when Undo button is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Undo"));

      expect(mockUndo).toHaveBeenCalled();
    });

    it("should call redo when Redo button is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Redo"));

      expect(mockRedo).toHaveBeenCalled();
    });
  });

  describe("Clear Button", () => {
    it("should render Clear button", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Clear")).toBeInTheDocument();
    });

    it("should call clearAnnotations when Clear is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Clear"));

      expect(mockClearAnnotations).toHaveBeenCalled();
    });
  });

  describe("Cancel and Done Buttons", () => {
    it("should render Cancel button", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("should render Done button", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Done")).toBeInTheDocument();
    });

    it("should call closeModal when Cancel is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Cancel"));

      expect(mockCloseModal).toHaveBeenCalled();
    });

    it("should save annotations and close when Done is clicked", async () => {
      render(<AnnotationModal />);

      // Done button should trigger save and close
      // Note: In jsdom, the flattenImage function won't work properly
      // so we just verify the button exists and triggers the handler
      fireEvent.click(screen.getByText("Done"));

      // closeModal should be called after save (async operation)
      await waitFor(() => {
        expect(mockCloseModal).toHaveBeenCalled();
      });
    });
  });

  describe("Color Picker", () => {
    it("should render color label", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Color")).toBeInTheDocument();
    });

    it("should render 8 color buttons", () => {
      const { container } = render(<AnnotationModal />);

      // Find color buttons (round buttons in the color section)
      const colorButtons = container.querySelectorAll(".rounded-full.w-6.h-6");
      expect(colorButtons.length).toBe(8);
    });

    it("should call setToolOptions when color is clicked", () => {
      const { container } = render(<AnnotationModal />);

      // Find color buttons and click one
      const colorButtons = container.querySelectorAll(".rounded-full.w-6.h-6");
      fireEvent.click(colorButtons[2]); // Click third color (yellow)

      expect(mockSetToolOptions).toHaveBeenCalledWith({ strokeColor: expect.any(String) });
    });

    it("should highlight selected color", () => {
      mockAnnotationStore = createMockAnnotationStore({
        toolOptions: { ...defaultToolOptions, strokeColor: "#ef4444" },
      });

      const { container } = render(<AnnotationModal />);

      // The first color (red #ef4444) should have ring styling
      const colorButtons = container.querySelectorAll(".rounded-full.w-6.h-6");
      expect(colorButtons[0]).toHaveClass("ring-2");
    });
  });

  describe("Stroke Width", () => {
    it("should render Size label", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Size")).toBeInTheDocument();
    });

    it("should render 3 stroke width options", () => {
      const { container } = render(<AnnotationModal />);

      // Find stroke width buttons (buttons with round indicators inside)
      const sizeSection = container.querySelectorAll(".w-8.h-8.rounded");
      expect(sizeSection.length).toBe(3);
    });

    it("should call setToolOptions when stroke width is clicked", () => {
      const { container } = render(<AnnotationModal />);

      const sizeButtons = container.querySelectorAll(".w-8.h-8.rounded");
      fireEvent.click(sizeButtons[1]); // Click medium width

      expect(mockSetToolOptions).toHaveBeenCalledWith({ strokeWidth: expect.any(Number) });
    });
  });

  describe("Fill Toggle", () => {
    it("should render Fill button", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("Fill")).toBeInTheDocument();
    });

    it("should toggle fill color when Fill is clicked", () => {
      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Fill"));

      expect(mockSetToolOptions).toHaveBeenCalledWith({ fillColor: expect.any(String) });
    });

    it("should set fill to null when already filled", () => {
      mockAnnotationStore = createMockAnnotationStore({
        toolOptions: { ...defaultToolOptions, fillColor: "#ef4444" },
      });

      render(<AnnotationModal />);

      fireEvent.click(screen.getByText("Fill"));

      expect(mockSetToolOptions).toHaveBeenCalledWith({ fillColor: null });
    });
  });

  describe("Zoom Controls", () => {
    it("should render zoom percentage", () => {
      render(<AnnotationModal />);

      // Default scale is 1, which is 100%
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    it("should render zoom in and out buttons", () => {
      render(<AnnotationModal />);

      expect(screen.getByText("+")).toBeInTheDocument();
      expect(screen.getByText("-")).toBeInTheDocument();
    });
  });

  describe("Canvas Element", () => {
    it("should render Konva Stage component", () => {
      render(<AnnotationModal />);

      expect(screen.getByTestId("konva-stage")).toBeInTheDocument();
    });

    it("should render Konva Layer component", () => {
      render(<AnnotationModal />);

      expect(screen.getByTestId("konva-layer")).toBeInTheDocument();
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("should call closeModal when Escape is pressed with no text editing", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Escape" });

      expect(mockCloseModal).toHaveBeenCalled();
    });

    it("should call undo when Ctrl+Z is pressed", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "z", ctrlKey: true });

      expect(mockUndo).toHaveBeenCalled();
    });

    it("should call redo when Ctrl+Shift+Z is pressed", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });

      expect(mockRedo).toHaveBeenCalled();
    });

    it("should call undo when the Z key is uppercase", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Z", ctrlKey: true });

      expect(mockUndo).toHaveBeenCalled();
    });

    it("should call undo when Cmd+Z is pressed (Mac)", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "z", metaKey: true });

      expect(mockUndo).toHaveBeenCalled();
    });

    it("should call redo when Cmd+Shift+Z is pressed (Mac)", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });

      expect(mockRedo).toHaveBeenCalled();
    });

    it("should call deleteAnnotation when Delete is pressed with shape selected", () => {
      mockAnnotationStore = createMockAnnotationStore({ selectedShapeId: "shape-1" });

      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Delete" });

      expect(mockDeleteAnnotation).toHaveBeenCalledWith("shape-1");
    });

    it("should call deleteAnnotation when Backspace is pressed with shape selected", () => {
      mockAnnotationStore = createMockAnnotationStore({ selectedShapeId: "shape-1" });

      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Backspace" });

      expect(mockDeleteAnnotation).toHaveBeenCalledWith("shape-1");
    });

    it("should not delete when no shape is selected", () => {
      mockAnnotationStore = createMockAnnotationStore({ selectedShapeId: null });

      render(<AnnotationModal />);

      fireEvent.keyDown(window, { key: "Delete" });

      expect(mockDeleteAnnotation).not.toHaveBeenCalled();
    });
  });

  describe("Modal Layout", () => {
    it("should render top bar with tools", () => {
      const { container } = render(<AnnotationModal />);

      const topBar = container.querySelector(".h-14.bg-neutral-900.flex");
      expect(topBar).toBeInTheDocument();
    });

    it("should render bottom options bar", () => {
      const { container } = render(<AnnotationModal />);

      // Top bar is the shared dialog header; the bottom options bar keeps its own
      expect(container.querySelector(".h-12.bg-card")).toBeInTheDocument();
      expect(container.querySelectorAll(".h-14.bg-neutral-900").length).toBe(1);
    });

    it("should render canvas container in the middle", () => {
      const { container } = render(<AnnotationModal />);

      const canvasContainer = container.querySelector(".flex-1.overflow-hidden");
      expect(canvasContainer).toBeInTheDocument();
    });
  });

  describe("Keyboard handling", () => {
    // Simulates React Flow's document-level key handler (deleteKeyCode etc.).
    // While the modal is open, destructive keys must never reach it — otherwise
    // Delete removes the selected NODE on the canvas behind the modal.
    let canvasKeyHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      canvasKeyHandler = vi.fn();
      document.addEventListener("keydown", canvasKeyHandler);
    });

    afterEach(() => {
      document.removeEventListener("keydown", canvasKeyHandler);
    });

    it("should delete the selected annotation on Delete without reaching the canvas", () => {
      mockAnnotationStore = createMockAnnotationStore({ selectedShapeId: "shape-1" });
      render(<AnnotationModal />);

      fireEvent.keyDown(document.body, { key: "Delete" });

      expect(mockDeleteAnnotation).toHaveBeenCalledWith("shape-1");
      expect(canvasKeyHandler).not.toHaveBeenCalled();
    });

    it("should swallow Delete even with no annotation selected (regression: node behind modal was deleted)", () => {
      mockAnnotationStore = createMockAnnotationStore({ selectedShapeId: null });
      render(<AnnotationModal />);

      fireEvent.keyDown(document.body, { key: "Delete" });

      expect(mockDeleteAnnotation).not.toHaveBeenCalled();
      expect(canvasKeyHandler).not.toHaveBeenCalled();
    });

    it("should close the modal on Escape without reaching the canvas", () => {
      render(<AnnotationModal />);

      fireEvent.keyDown(document.body, { key: "Escape" });

      expect(mockCloseModal).toHaveBeenCalled();
      expect(canvasKeyHandler).not.toHaveBeenCalled();
    });

    it("should let keys reach the canvas when the modal is closed", () => {
      mockAnnotationStore = createMockAnnotationStore({ isModalOpen: false });
      render(<AnnotationModal />);

      fireEvent.keyDown(document.body, { key: "Delete" });

      expect(canvasKeyHandler).toHaveBeenCalled();
    });
  });
});
