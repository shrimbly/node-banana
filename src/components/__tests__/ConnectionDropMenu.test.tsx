import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionDropMenu } from "@/components/ConnectionDropMenu";

describe("ConnectionDropMenu", () => {
  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();

  const defaultProps = {
    position: { x: 100, y: 200 },
    handleType: "image" as const,
    connectionType: "source" as const,
    onSelect: mockOnSelect,
    onClose: mockOnClose,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render at the specified position", () => {
      render(<ConnectionDropMenu {...defaultProps} />);

      const menu = document.querySelector(".fixed");
      expect(menu).toBeInTheDocument();
      expect(menu).toHaveStyle({ left: "100px", top: "200px" });
    });

    it("should render the header with handle type", () => {
      render(<ConnectionDropMenu {...defaultProps} />);

      expect(screen.getByText("Add image node")).toBeInTheDocument();
    });

    it("should render keyboard shortcuts hint", () => {
      render(<ConnectionDropMenu {...defaultProps} />);

      expect(screen.getByText("navigate")).toBeInTheDocument();
      expect(screen.getByText("select")).toBeInTheDocument();
    });

    it("should not render when handleType is null", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType={null} />);

      expect(screen.queryByText(/Add .* node/)).not.toBeInTheDocument();
    });
  });

  describe("Node Type Filtering - Source Connection (from output handle)", () => {
    it("should show image-accepting nodes when dragging from image output", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      expect(screen.getByText("Annotate")).toBeInTheDocument();
      expect(screen.getByText("Generate Image")).toBeInTheDocument();
      expect(screen.getByText("Generate Video")).toBeInTheDocument();
      expect(screen.getByText("Split Grid Node")).toBeInTheDocument();
      expect(screen.getByText("Split Grid Now")).toBeInTheDocument();
      expect(screen.getByText("Output")).toBeInTheDocument();
      expect(screen.getByText("Generate Panorama")).toBeInTheDocument();
      expect(screen.getByText("Generate World")).toBeInTheDocument();
    });

    it("should show text-accepting nodes when dragging from text output", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="text" connectionType="source" />);

      expect(screen.getByText("Generate Image")).toBeInTheDocument();
      expect(screen.getByText("Generate Video")).toBeInTheDocument();
      expect(screen.getByText("LLM Generate")).toBeInTheDocument();
      expect(screen.getByText("Generate Panorama")).toBeInTheDocument();
      // Should NOT show image-only nodes
      expect(screen.queryByText("Annotate")).not.toBeInTheDocument();
      expect(screen.queryByText("Output")).not.toBeInTheDocument();
    });

    it("should show video-accepting nodes when dragging from video output", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="video" connectionType="source" />);

      expect(screen.getByText("Generate Video")).toBeInTheDocument();
      expect(screen.getByText("Output")).toBeInTheDocument();
      // Should NOT show image/text-only nodes
      expect(screen.queryByText("Annotate")).not.toBeInTheDocument();
      expect(screen.queryByText("LLM Generate")).not.toBeInTheDocument();
    });

    it("should show 3D-accepting nodes when dragging from 3D output", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="3d" connectionType="source" />);

      expect(screen.getByText("GLB Viewer")).toBeInTheDocument();
      expect(screen.getByText("SPZ Viewer")).toBeInTheDocument();
      // Should NOT show image/text/video nodes
      expect(screen.queryByText("Annotate")).not.toBeInTheDocument();
      expect(screen.queryByText("Generate Image")).not.toBeInTheDocument();
      expect(screen.queryByText("Generate Video")).not.toBeInTheDocument();
    });
  });

  describe("Node Type Filtering - Target Connection (from input handle)", () => {
    it("should show image-producing nodes when dragging from image input", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="target" />);

      expect(screen.getByText("Image Input")).toBeInTheDocument();
      expect(screen.getByText("Annotate")).toBeInTheDocument();
      expect(screen.getByText("Generate Image")).toBeInTheDocument();
      expect(screen.getByText("Panorama")).toBeInTheDocument();
      expect(screen.getByText("WorldLabs World")).toBeInTheDocument();
      // Should NOT show text nodes
      expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
    });

    it("should show text-producing nodes when dragging from text input", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="text" connectionType="target" />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(screen.getByText("LLM Generate")).toBeInTheDocument();
      // Should NOT show image-only nodes
      expect(screen.queryByText("Image Input")).not.toBeInTheDocument();
      expect(screen.queryByText("Annotate")).not.toBeInTheDocument();
    });

    it("should show video-producing nodes when dragging from video input", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="video" connectionType="target" />);

      expect(screen.getByText("Generate Video")).toBeInTheDocument();
      // Should NOT show other nodes
      expect(screen.queryByText("Image Input")).not.toBeInTheDocument();
      expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
    });

    it("should show 3D-producing nodes when dragging from 3D input", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="3d" connectionType="target" />);

      expect(screen.getByText("Generate 3D")).toBeInTheDocument();
      expect(screen.getByText("WorldLabs World")).toBeInTheDocument();
      // Should NOT show other nodes
      expect(screen.queryByText("Image Input")).not.toBeInTheDocument();
      expect(screen.queryByText("Generate Image")).not.toBeInTheDocument();
    });
  });

  describe("Menu Item Click", () => {
    it("should call onSelect with node type when menu item is clicked", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      const annotateButton = screen.getByText("Annotate");
      fireEvent.click(annotateButton);

      expect(mockOnSelect).toHaveBeenCalledWith({ type: "annotation", isAction: false });
    });

    it("should call onSelect with isAction true for action items", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      const splitNowButton = screen.getByText("Split Grid Now");
      fireEvent.click(splitNowButton);

      expect(mockOnSelect).toHaveBeenCalledWith({ type: "splitGridImmediate", isAction: true });
    });

    it("should call onSelect with nanoBanana type for Generate Image", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="text" connectionType="source" />);

      const generateButton = screen.getByText("Generate Image");
      fireEvent.click(generateButton);

      expect(mockOnSelect).toHaveBeenCalledWith({ type: "nanoBanana", isAction: false });
    });
  });

  describe("Escape Key", () => {
    it("should call onClose when Escape key is pressed", () => {
      render(<ConnectionDropMenu {...defaultProps} />);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("Click Outside", () => {
    it("should call onClose when clicking outside the menu", () => {
      const { container } = render(
        <div>
          <div data-testid="outside">Outside</div>
          <ConnectionDropMenu {...defaultProps} />
        </div>
      );

      const outside = screen.getByTestId("outside");
      fireEvent.mouseDown(outside);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should not call onClose when clicking inside the menu", () => {
      render(<ConnectionDropMenu {...defaultProps} />);

      const menuItem = screen.getByText("Annotate");
      fireEvent.mouseDown(menuItem);

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe("Keyboard Navigation", () => {
    it("should navigate down with ArrowDown key", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      // First item should be highlighted by default
      const firstButton = screen.getByText("Annotate").closest("button");
      expect(firstButton).toHaveClass("bg-neutral-700");

      // Press ArrowDown
      fireEvent.keyDown(document, { key: "ArrowDown" });

      // Second item should now be highlighted
      const secondButton = screen.getByText("Generate Image").closest("button");
      expect(secondButton).toHaveClass("bg-neutral-700");
    });

    it("should navigate up with ArrowUp key", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      // Press ArrowUp to go to last item (wrapping)
      fireEvent.keyDown(document, { key: "ArrowUp" });

      // Last item should now be highlighted (Mask Painter is the last IMAGE_TARGET_OPTIONS item)
      const lastButton = screen.getByText("Mask Painter").closest("button");
      expect(lastButton).toHaveClass("bg-neutral-700");
    });

    it("should select item with Enter key", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      // Press Enter on first item
      fireEvent.keyDown(document, { key: "Enter" });

      expect(mockOnSelect).toHaveBeenCalledWith({ type: "annotation", isAction: false });
    });

    it("should select navigated item with Enter key", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      // Navigate to second item
      fireEvent.keyDown(document, { key: "ArrowDown" });
      // Press Enter
      fireEvent.keyDown(document, { key: "Enter" });

      expect(mockOnSelect).toHaveBeenCalledWith({ type: "nanoBanana", isAction: false });
    });

    it("should wrap around when navigating past last item", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="text" connectionType="source" />);

      // Text target options: Prompt, Prompt Constructor, Array, Generate Image, Generate Video, Generate Audio, LLM Generate, Generate Panorama, Pano Editor (9 items)
      // Navigate down 9 times to wrap to first
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });

      // Should be back on first item (Prompt)
      const firstButton = screen.getByText("Prompt").closest("button");
      expect(firstButton).toHaveClass("bg-neutral-700");
    });
  });

  describe("Mouse Hover", () => {
    it("should highlight item on mouse enter", () => {
      render(<ConnectionDropMenu {...defaultProps} handleType="image" connectionType="source" />);

      const secondItem = screen.getByText("Generate Image");
      fireEvent.mouseEnter(secondItem);

      // Second item should now be highlighted
      const secondButton = secondItem.closest("button");
      expect(secondButton).toHaveClass("bg-neutral-700");
    });
  });
});
