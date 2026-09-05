import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OutputNode } from "@/components/nodes/OutputNode";
import { ReactFlowProvider } from "@xyflow/react";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) => mockUseWorkflowStore(selector),
}));

// Mock useReactFlow
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getNodes: vi.fn(() => []),
      setNodes: vi.fn(),
    }),
  };
});

// Mock useVideoBlobUrl to pass through the URL directly
vi.mock("@/hooks/useVideoBlobUrl", () => ({
  useVideoBlobUrl: (url: string | null) => url,
}));

// Mock useVideoAutoplay to return a simple ref
vi.mock("@/hooks/useVideoAutoplay", () => ({
  useVideoAutoplay: () => ({ current: null }),
}));

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = vi.fn(() => "blob:test-url");
const mockRevokeObjectURL = vi.fn();

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("OutputNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        regenerateNode: vi.fn(),
        edges: [],
        isRunning: false,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        hoveredNodeId: null,
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
      };
      return selector(state);
    });

    // Mock URL methods
    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;
  });

  const createNodeProps = (data: Partial<{
    image: string | null;
    video?: string | null;
    contentType?: "image" | "video";
    customTitle?: string;
    comment?: string;
  }> = {}) => ({
    id: "output-node-1",
    type: "output" as const,
    data: {
      image: null,
      ...data,
    },
    selected: false,
  });

  describe("Empty State Rendering", () => {
    it("should render empty state placeholder when no content", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByText("Connect input")).toBeInTheDocument();
    });

    it("should not render download button when no content", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.queryByTitle("Download")).not.toBeInTheDocument();
    });

    it("should render input handle for image", () => {
      const { container } = render(
        <TestWrapper>
          <OutputNode {...createNodeProps()} />
        </TestWrapper>
      );

      const handle = container.querySelector('[data-handletype="image"]');
      expect(handle).toBeInTheDocument();
    });
  });

  describe("Image Content Display", () => {
    it("should render image element when data.image is set", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Output");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "data:image/png;base64,abc123");
    });

    it("should not show waiting message when image is present", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      expect(screen.queryByText("Waiting for image or video")).not.toBeInTheDocument();
    });

    it("should render download button when image is present", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Download")).toBeInTheDocument();
    });
  });

  describe("Video Detection Logic", () => {
    it("should detect video when data.video is present", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz789" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", "data:video/mp4;base64,xyz789");
    });

    it("should detect video when data.contentType is 'video'", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({
            image: "https://example.com/video.mp4",
            contentType: "video"
          })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
    });

    it("should detect video when data.image starts with 'data:video/'", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:video/mp4;base64,abc123" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", "data:video/mp4;base64,abc123");
    });

    it("should detect video when data.image contains '.mp4'", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "https://example.com/video.mp4" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
    });

    it("should detect video when data.image contains '.webm'", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "https://example.com/video.webm" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
    });

    it("should render image when no video indicators are present", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "https://example.com/image.png" })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Output");
      expect(img).toBeInTheDocument();
      expect(document.querySelector("video")).not.toBeInTheDocument();
    });

    it("should prioritize data.video over data.image", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({
            video: "data:video/mp4;base64,video123",
            image: "data:image/png;base64,image456"
          })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", "data:video/mp4;base64,video123");
    });
  });

  describe("Video Controls Rendering", () => {
    it("drives the video from the scrub row instead of native controls", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz789" })} />
        </TestWrapper>
      );
      const video = document.querySelector("video");
      expect(video).not.toHaveAttribute("controls");
      expect(screen.getByTitle("Play")).toBeInTheDocument();
    });

    it("should render video with loop attribute", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toHaveAttribute("loop");
    });

    it("should render video with muted attribute", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video?.muted).toBe(true);
    });

    it("should render video with playsInline attribute", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      const video = document.querySelector("video");
      expect(video).toHaveAttribute("playsinline");
    });
  });

  describe("Lightbox Functionality", () => {
    it("should open lightbox when image is clicked", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Output");
      const clickableArea = img.closest(".cursor-pointer");
      expect(clickableArea).toBeInTheDocument();

      fireEvent.click(clickableArea!);

      // Lightbox should be visible with full size image
      expect(screen.getByAltText("Output full size")).toBeInTheDocument();
    });

    it("should close lightbox when clicking outside", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      // Open lightbox
      const img = screen.getByAltText("Output");
      const clickableArea = img.closest(".cursor-pointer");
      fireEvent.click(clickableArea!);

      // Lightbox should be open
      expect(screen.getByAltText("Output full size")).toBeInTheDocument();

      // Click the backdrop (fixed overlay)
      const backdrop = document.querySelector(".fixed.inset-0");
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      // Lightbox should be closed
      expect(screen.queryByAltText("Output full size")).not.toBeInTheDocument();
    });

    it("should close lightbox when clicking close button", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      // Open lightbox
      const img = screen.getByAltText("Output");
      const clickableArea = img.closest(".cursor-pointer");
      fireEvent.click(clickableArea!);

      // Find and click close button (it's the button with X icon inside the lightbox)
      const closeButton = document.querySelector(".fixed.inset-0 button");
      expect(closeButton).toBeInTheDocument();
      fireEvent.click(closeButton!);

      // Lightbox should be closed
      expect(screen.queryByAltText("Output full size")).not.toBeInTheDocument();
    });

    it("should show video in lightbox when video content is clicked", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      // Find the clickable area (parent of video)
      const video = document.querySelector("video");
      const clickableArea = video?.closest(".cursor-pointer");
      expect(clickableArea).toBeInTheDocument();

      fireEvent.click(clickableArea!);

      // Lightbox should have a video element
      const lightboxVideos = document.querySelectorAll("video");
      // There should now be 2 videos - one in node, one in lightbox
      expect(lightboxVideos.length).toBe(2);
    });

    it("should not close lightbox when clicking on video controls", () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      // Open lightbox
      const video = document.querySelector("video");
      const clickableArea = video?.closest(".cursor-pointer");
      fireEvent.click(clickableArea!);

      // Click directly on video (should stopPropagation)
      const lightboxVideo = document.querySelectorAll("video")[1];
      fireEvent.click(lightboxVideo);

      // Lightbox should still be open (2 videos present)
      const allVideos = document.querySelectorAll("video");
      expect(allVideos.length).toBe(2);
    });
  });

  describe("Download Functionality", () => {
    let anchorClicks: { href: string; download: string }[] = [];
    let originalCreateElement: typeof document.createElement;

    beforeEach(() => {
      anchorClicks = [];
      originalCreateElement = document.createElement.bind(document);

      // Spy on document.createElement to capture anchor properties before click
      vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
        const element = originalCreateElement(tagName, options);
        if (tagName === "a") {
          const originalClick = element.click.bind(element);
          element.click = () => {
            anchorClicks.push({
              href: (element as HTMLAnchorElement).href,
              download: (element as HTMLAnchorElement).download,
            });
            // Don't call original click to avoid navigation issues in tests
          };
        }
        return element;
      });
    });

    afterEach(() => {
      vi.mocked(document.createElement).mockRestore();
    });

    it("should trigger download for data URL content", async () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc123" })} />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download");
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(anchorClicks.length).toBe(1);
        expect(anchorClicks[0].href).toContain("data:image/png;base64,abc123");
      });
    });

    it("should fetch and download for URL-based content", async () => {
      const mockBlob = new Blob(["test"], { type: "image/png" });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });
      global.fetch = mockFetch;

      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "https://example.com/image.png" })} />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download");
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("https://example.com/image.png");
      });

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalledWith(mockBlob);
      });

      await waitFor(() => {
        expect(anchorClicks.length).toBe(1);
        expect(anchorClicks[0].href).toBe("blob:test-url");
      });
    });

    it("should use .mp4 extension for video downloads", async () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ video: "data:video/mp4;base64,xyz" })} />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download");
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(anchorClicks.length).toBe(1);
        expect(anchorClicks[0].download).toMatch(/\.mp4$/);
      });
    });

    it("should use .png extension for image downloads", async () => {
      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "data:image/png;base64,abc" })} />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download");
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(anchorClicks.length).toBe(1);
        expect(anchorClicks[0].download).toMatch(/\.png$/);
      });
    });

    it("should revoke blob URL after download for HTTP content", async () => {
      const mockBlob = new Blob(["test"], { type: "image/png" });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });

      render(
        <TestWrapper>
          <OutputNode {...createNodeProps({ image: "https://example.com/image.png" })} />
        </TestWrapper>
      );

      const downloadButton = screen.getByTitle("Download");
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:test-url");
      });
    });
  });

});
