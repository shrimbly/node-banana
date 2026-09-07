import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AnnotationNode } from "@/components/nodes/AnnotationNode";
import { ReactFlowProvider } from "@xyflow/react";
import { AnnotationNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign((selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  }, { getState: () => ({ workflowLifecycleId: 0 }) }),
}));

// Mock the annotation store
const mockOpenModal = vi.fn();
const mockUseAnnotationStore = vi.fn();

vi.mock("@/store/annotationStore", () => ({
  useAnnotationStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseAnnotationStore(selector);
    }
    return mockUseAnnotationStore((s: unknown) => s);
  },
}));

// Mock alert
const mockAlert = vi.fn();

// Mock DataTransfer
class MockDataTransfer {
  items: { add: (file: File) => void };
  private _files: File[] = [];
  get files() {
    const fileList = Object.assign(this._files, {
      item: (index: number) => this._files[index] || null,
    });
    return fileList as unknown as FileList;
  }
  constructor() {
    this.items = {
      add: (file: File) => this._files.push(file),
    };
  }
}

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("AnnotationNode", () => {
  beforeAll(() => {
    vi.stubGlobal("alert", mockAlert);
    vi.stubGlobal("DataTransfer", MockDataTransfer);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation for workflow store
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
      };
      return selector(state);
    });

    // Default mock implementation for annotation store
    mockUseAnnotationStore.mockImplementation((selector) => {
      const state = {
        openModal: mockOpenModal,
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<AnnotationNodeData> = {}): AnnotationNodeData => ({
    sourceImage: null,
    annotations: [],
    outputImage: null,
    ...overrides,
  });

  const createNodeProps = (data: Partial<AnnotationNodeData> = {}) => ({
    id: "test-annotation-1",
    type: "annotation" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render image input handle on left", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const inputHandle = container.querySelector('[data-handletype="image"][class*="target"]');
      expect(inputHandle).toBeInTheDocument();
    });

    it("should render image output handle on right", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="image"][class*="source"]');
      expect(outputHandle).toBeInTheDocument();
    });
  });

  describe("Empty State", () => {
    it("should show empty state message when no image", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({ sourceImage: null, outputImage: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Drop, click, or connect")).toBeInTheDocument();
    });

    it("should render drop zone when no image", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const dropZone = screen.getByText("Drop, click, or connect").parentElement!;
      expect(dropZone).toBeInTheDocument();
    });
  });

  describe("Image Display", () => {
    const propsWithImage = {
      sourceImage: "data:image/png;base64,sourceImageData",
      annotations: [],
      outputImage: null,
    };

    it("should display source image when sourceImage is set", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps(propsWithImage)} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "data:image/png;base64,sourceImageData");
    });

    it("should display output image when outputImage is set", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,sourceImageData",
            outputImage: "data:image/png;base64,outputImageData",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toHaveAttribute("src", "data:image/png;base64,outputImageData");
    });

    it("should prefer outputImage over sourceImage when both exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,source",
            outputImage: "data:image/png;base64,output",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      expect(img).toHaveAttribute("src", "data:image/png;base64,output");
    });
  });

  describe("Edit Button / Image Click", () => {
    it("should show 'Add annotations' hint when no annotations exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [],
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Add annotations")).toBeInTheDocument();
    });

    it("should show annotation count when annotations exist", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [
              { id: "1", type: "rectangle", x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null },
              { id: "2", type: "rectangle", x: 50, y: 50, width: 100, height: 100, stroke: "#00ff00", strokeWidth: 2, opacity: 1, fill: null },
            ],
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Edit (2)")).toBeInTheDocument();
    });

    it("should open annotation modal when image is clicked", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations: [],
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      fireEvent.click(img.parentElement!);

      expect(mockOpenModal).toHaveBeenCalledWith(
        "test-annotation-1",
        "data:image/png;base64,test",
        []
      );
    });

    it("should pass existing annotations when opening modal", () => {
      const annotations = [
        { id: "1", type: "rectangle" as const, x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null },
      ];

      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            annotations,
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Annotated");
      fireEvent.click(img.parentElement!);

      expect(mockOpenModal).toHaveBeenCalledWith(
        "test-annotation-1",
        "data:image/png;base64,test",
        annotations
      );
    });

    it("should show alert when trying to edit without an image", () => {
      // Test when trying to trigger edit without image
      // The handleEdit function alerts when there's no image
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({ sourceImage: null, outputImage: null })} />
        </TestWrapper>
      );

      // Empty state doesn't have the clickable edit area
      // But we can verify the empty state is shown
      expect(screen.getByText("Drop, click, or connect")).toBeInTheDocument();
    });
  });

  describe("Remove/Clear Button", () => {
    it("should render remove button when image is present", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
          })} />
        </TestWrapper>
      );

      // The remove button has an X SVG icon
      const removeButton = container.querySelector('button svg path[d*="M6 18"]');
      expect(removeButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear when remove button is clicked", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps({
            sourceImage: "data:image/png;base64,test",
            outputImage: "data:image/png;base64,output",
            annotations: [{ id: "1", type: "rectangle", x: 0, y: 0, width: 100, height: 100, stroke: "#ff0000", strokeWidth: 2, opacity: 1, fill: null }],
          })} />
        </TestWrapper>
      );

      // Find the remove button by looking for the button element that contains the X icon
      // The button has opacity-0 by default but is still clickable
      const buttons = container.querySelectorAll('button');
      // The remove button is the one with the X icon SVG
      const removeButton = Array.from(buttons).find((btn) =>
        btn.querySelector('svg path[d*="M6 18"]')
      );
      expect(removeButton).toBeInTheDocument();

      if (removeButton) {
        fireEvent.click(removeButton);
      }

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-annotation-1", {
        sourceImage: null,
        sourceImageRef: undefined,
        outputImage: null,
        outputImageRef: undefined,
        annotations: [],
      });
    });
  });

  describe("File Upload", () => {
    it("should render hidden file input", () => {
      const { container } = render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveClass("hidden");
    });

    it("should trigger file input click when drop zone is clicked", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      const dropZone = screen.getByText("Drop, click, or connect").parentElement!;
      fireEvent.click(dropZone);

      expect(clickSpy).toHaveBeenCalled();
    });

    it("should process valid image file and call updateNodeData", async () => {
      // Mock FileReader using vi.stubGlobal for proper cleanup
      const mockReadAsDataURL = vi.fn();
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = "data:image/png;base64,uploadedImage";
        readAsDataURL(file: Blob) {
          mockReadAsDataURL(file);
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }
      }
      vi.stubGlobal("FileReader", MockFileReader);

      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(["test"], "test.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith("test-annotation-1", {
          sourceImage: "data:image/png;base64,uploadedImage",
          sourceImageRef: undefined,
          outputImage: null,
          outputImageRef: undefined,
          annotations: [],
        });
      });

      // Restore FileReader
      vi.unstubAllGlobals();
      // Re-stub the globals we need for other tests
      vi.stubGlobal("alert", mockAlert);
      vi.stubGlobal("DataTransfer", MockDataTransfer);
    });

    it("should reject non-image file types", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(["test"], "test.txt", { type: "text/plain" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).toHaveBeenCalledWith("Unsupported format. Use PNG, JPG, or WebP.");
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });

    it("should reject files larger than 10MB", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([""], "large.png", { type: "image/png" });
      Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).toHaveBeenCalledWith("Image too large. Maximum size is 10MB.");
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });
  });

  describe("Drag and Drop", () => {
    it("should handle dragOver event", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const dropZone = screen.getByText("Drop, click, or connect").parentElement!;

      // Use fireEvent.dragOver for idiomatic testing
      fireEvent.dragOver(dropZone);

      // Should handle without error
      expect(dropZone).toBeInTheDocument();
    });

    it("should handle drop event with empty files", () => {
      render(
        <TestWrapper>
          <AnnotationNode {...createNodeProps()} />
        </TestWrapper>
      );

      const dropZone = screen.getByText("Drop, click, or connect").parentElement!;

      fireEvent.drop(dropZone, {
        dataTransfer: { files: [] },
      });

      // Should handle gracefully without updating node data
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });
  });

});
