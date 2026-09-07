import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImageInputNode } from "@/components/nodes/ImageInputNode";
import { ReactFlowProvider } from "@xyflow/react";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(vi.fn((selector) => {
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
  }), { getState: () => ({ workflowLifecycleId: 0 }) }),
}));

// Mock alert
const mockAlert = vi.fn();
global.alert = mockAlert;

// Mock DataTransfer (not available in jsdom)
// The drop handler in ImageInputNode tries to set fileInputRef.current.files
// which requires a proper FileList. Since jsdom doesn't allow setting files directly
// from a plain array, we need to work around this in the test.
class MockDataTransfer {
  items: { add: (file: File) => void };
  private _files: File[] = [];
  get files() {
    // Return a FileList-like object
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
global.DataTransfer = MockDataTransfer as unknown as typeof DataTransfer;

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("ImageInputNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultProps = {
    id: "test-image-1",
    type: "imageInput" as const,
    data: {
      image: null,
      filename: null,
      dimensions: null,
    },
    selected: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    deletable: true,
    selectable: true,
    parentId: undefined,
    dragHandle: undefined,
  };

  describe("Basic Rendering", () => {
    it("should render drop zone when no image is set", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      expect(screen.getByText("Drop image")).toBeInTheDocument();
    });

    it("should render reference input handle on left", () => {
      const { container } = render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const referenceHandle = container.querySelector('[data-handletype="reference"]');
      expect(referenceHandle).toBeInTheDocument();
    });

    it("should render image output handle on right", () => {
      const { container } = render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const imageHandle = container.querySelector('[data-handletype="image"]');
      expect(imageHandle).toBeInTheDocument();
    });
  });

  describe("Image Display", () => {
    const propsWithImage = {
      ...defaultProps,
      data: {
        image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        filename: "test-image.png",
        dimensions: { width: 800, height: 600 },
      },
    };

    it("should display image when data.image is set", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...propsWithImage} />
        </TestWrapper>
      );

      const img = screen.getByAltText("test-image.png");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
    });

    it("should not show drop zone when image is set", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...propsWithImage} />
        </TestWrapper>
      );

      expect(screen.queryByText("Drop image")).not.toBeInTheDocument();
    });
  });

  describe("File Input Change Handler", () => {
    it("should process valid image file and call updateNodeData", async () => {
      // Mock FileReader as a class
      let mockOnload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      const mockReadAsDataURL = vi.fn();

      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = "data:image/png;base64,test123";
        readAsDataURL(file: Blob) {
          mockOnload = this.onload;
          mockReadAsDataURL(file);
          // Trigger onload asynchronously
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }
      }
      global.FileReader = MockFileReader as unknown as typeof FileReader;

      // Mock Image as a class
      let mockImageOnload: (() => void) | null = null;
      class MockImage {
        onload: (() => void) | null = null;
        width: number = 1024;
        height: number = 768;
        private _src: string = "";
        get src() { return this._src; }
        set src(value: string) {
          this._src = value;
          mockImageOnload = this.onload;
          // Trigger onload asynchronously
          setTimeout(() => {
            this.onload?.();
          }, 0);
        }
      }
      global.Image = MockImage as unknown as typeof Image;

      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      const file = new File(["test"], "test.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith("test-image-1", {
          image: "data:image/png;base64,test123",
          imageRef: undefined,
          filename: "test.png",
          dimensions: { width: 1024, height: 768 },
        });
      });
    });

    it("should reject non-image file types", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
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
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // Create a file object with size > 10MB
      const file = new File([""], "large.png", { type: "image/png" });
      Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 }); // 11MB
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).toHaveBeenCalledWith("Image too large. Maximum size is 10MB.");
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });

    it("should accept PNG files", () => {
      const mockReadAsDataURL = vi.fn();
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = "data:image/png;base64,test";
        readAsDataURL(file: Blob) {
          mockReadAsDataURL(file);
        }
      }
      global.FileReader = MockFileReader as unknown as typeof FileReader;

      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const file = new File(["test"], "test.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockReadAsDataURL).toHaveBeenCalledWith(file);
    });

    it("should accept JPEG files", () => {
      const mockReadAsDataURL = vi.fn();
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = "data:image/jpeg;base64,test";
        readAsDataURL(file: Blob) {
          mockReadAsDataURL(file);
        }
      }
      global.FileReader = MockFileReader as unknown as typeof FileReader;

      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const file = new File(["test"], "test.jpg", { type: "image/jpeg" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockReadAsDataURL).toHaveBeenCalledWith(file);
    });

    it("should accept WebP files", () => {
      const mockReadAsDataURL = vi.fn();
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = "data:image/webp;base64,test";
        readAsDataURL(file: Blob) {
          mockReadAsDataURL(file);
        }
      }
      global.FileReader = MockFileReader as unknown as typeof FileReader;

      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const file = new File(["test"], "test.webp", { type: "image/webp" });
      Object.defineProperty(fileInput, "files", { value: [file] });

      fireEvent.change(fileInput);

      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockReadAsDataURL).toHaveBeenCalledWith(file);
    });
  });

  describe("Remove Button", () => {
    const propsWithImage = {
      ...defaultProps,
      data: {
        image: "data:image/png;base64,test123",
        filename: "test-image.png",
        dimensions: { width: 800, height: 600 },
      },
    };

    it("should render remove button when image is present", () => {
      const { container } = render(
        <TestWrapper>
          <ImageInputNode {...propsWithImage} />
        </TestWrapper>
      );

      // The remove button contains an SVG with X icon
      const removeButton = container.querySelector("button");
      expect(removeButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear image when remove button is clicked", () => {
      const { container } = render(
        <TestWrapper>
          <ImageInputNode {...propsWithImage} />
        </TestWrapper>
      );

      // Find the remove button (it's the button inside the image container)
      const buttons = container.querySelectorAll("button");
      // The remove button is the one that appears when image is present
      const removeButton = Array.from(buttons).find((btn) =>
        btn.querySelector('svg path[d*="M6 18"]')
      );
      expect(removeButton).toBeInTheDocument();

      if (removeButton) {
        fireEvent.click(removeButton);
      }

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-image-1", {
        image: null,
        imageRef: undefined,
        filename: null,
        dimensions: null,
      });
    });
  });

  describe("Drag and Drop", () => {
    it("should handle dragOver event", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const dropZone = screen.getByText("Drop image").parentElement!;
      const dragOverEvent = new Event("dragover", { bubbles: true });
      Object.assign(dragOverEvent, {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });

      fireEvent(dropZone, dragOverEvent);

      // Event should be handled without error
      expect(dropZone).toBeInTheDocument();
    });

    it("should handle drop event with empty dataTransfer", () => {
      // Note: Full drop-to-file-processing flow cannot be fully tested in jsdom
      // because jsdom doesn't allow setting HTMLInputElement.files property.
      // We test that the drop handler gracefully handles an empty file list.
      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const dropZone = screen.getByText("Drop image").parentElement!;

      // Drop with empty files array (no file to process)
      const dataTransfer = {
        files: [],
      };

      fireEvent.drop(dropZone, { dataTransfer });

      // Component should handle empty drop gracefully
      expect(dropZone).toBeInTheDocument();
      // No updateNodeData should be called with empty files
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });
  });

  describe("Click to Upload", () => {
    it("should trigger file input click when drop zone is clicked", () => {
      render(
        <TestWrapper>
          <ImageInputNode {...defaultProps} />
        </TestWrapper>
      );

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      const dropZone = screen.getByText("Drop image").parentElement!;
      fireEvent.click(dropZone);

      expect(clickSpy).toHaveBeenCalled();
    });
  });

});
