import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VideoStitchNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockRemoveEdge = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock @xyflow/react
vi.mock("@xyflow/react", () => {
  const React = require("react");
  const MockHandle = (props: Record<string, unknown>) =>
    React.createElement("div", {
      "data-testid": `handle-${props.id}`,
      "data-handleid": props.id,
      "data-handletype": props["data-handletype"],
      "data-type": props.type,
      "data-position": props.position,
      "data-connectable": String(props.isConnectable ?? ""),
      className: `react-flow__handle react-flow__handle-${props.position}`,
      style: props.style,
    });
  return {
    Handle: MockHandle,
    NodeResizer: () => null,
    NodeResizeControl: () => null,
    useNodeConnections: () => [],
    useUpdateNodeInternals: () => () => {},
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
    useReactFlow: () => ({
      getNodes: () => [],
      setNodes: () => {},
      screenToFlowPosition: (pos: unknown) => pos,
    }),
    useConnection: (selector: (state: { inProgress: boolean }) => boolean) => selector({ inProgress: false }),
  };
});

// Mock useStitchVideos (this also prevents mediabunny from loading)
const mockCheckEncoderSupport = vi.fn();
vi.mock("@/hooks/useStitchVideos", () => ({
  checkEncoderSupport: () => mockCheckEncoderSupport(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/hooks/useCommentNavigation", () => ({
  useCommentNavigation: () => null,
}));

vi.mock("@/components/nodes/BaseNode", () => {
  const React = require("react");
  return {
    BaseNode: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(
        "div",
        { "data-testid": "base-node", "data-title": props.title },
        children as React.ReactNode
      ),
  };
});

import { VideoStitchNode } from "@/components/nodes/VideoStitchNode";

/** Set up mock store state, merging overrides onto the base state. */
function setMockStoreState(overrides: Record<string, unknown> = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
    regenerateNode: mockRegenerateNode,
    removeEdge: mockRemoveEdge,
    edges: [],
    nodes: [],
    isRunning: false,
    currentNodeIds: [],
    groups: {},
    getNodesWithComments: vi.fn(() => []),
    markCommentViewed: vi.fn(),
    setNavigationTarget: vi.fn(),
    ...overrides,
  };
  mockUseWorkflowStore.mockImplementation((selector: (s: typeof state) => unknown) => selector(state));
}

const createNodeData = (overrides: Partial<VideoStitchNodeData> = {}): VideoStitchNodeData => ({
  clips: [],
  clipOrder: [],
  outputVideo: null,
  status: "idle",
  error: null,
  progress: 0,
  encoderSupported: true,
  ...overrides,
});

const createNodeProps = (data: Partial<VideoStitchNodeData> = {}) => ({
  id: "test-stitch-1",
  type: "videoStitch" as const,
  data: createNodeData(data),
  selected: false,
});

describe("VideoStitchNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEncoderSupport.mockResolvedValue(true);
    setMockStoreState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handle Rendering", () => {
    it("should render video-0, video-1, audio, and output handles", () => {
      const { container } = render(<VideoStitchNode {...createNodeProps()} />);

      expect(container.querySelector('[data-handleid="video-0"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="audio"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video"]')).toBeInTheDocument();

      const handles = container.querySelectorAll(".react-flow__handle");
      expect(handles.length).toBeGreaterThanOrEqual(4);
      handles.forEach((handle) => {
        expect(handle.classList.contains("react-flow__handle-not-connectable")).toBe(false);
      });
    });

    it("should grow dynamic handles when video edges exist", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0" },
          { id: "e2", source: "gen2", target: "test-stitch-1", targetHandle: "video-1" },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: null } },
          { id: "gen2", type: "generateVideo", data: { outputVideo: null } },
        ],
      });

      const { container } = render(<VideoStitchNode {...createNodeProps()} />);

      expect(container.querySelector('[data-handleid="video-0"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-2"]')).toBeInTheDocument();
    });
  });

  describe("Encoder Detection States", () => {
    it("should show checking state when encoderSupported is null", () => {
      render(<VideoStitchNode {...createNodeProps({ encoderSupported: null })} />);
      expect(screen.getByText("Checking encoder...")).toBeInTheDocument();
    });

    it("should show unsupported message when encoderSupported is false", () => {
      render(<VideoStitchNode {...createNodeProps({ encoderSupported: false })} />);
      expect(screen.getByText("Your browser doesn't support video encoding.")).toBeInTheDocument();
    });

    it("should render handles in checking and unsupported states for connection stability", () => {
      const { container: checking } = render(
        <VideoStitchNode {...createNodeProps({ encoderSupported: null })} />
      );
      expect(checking.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);

      const { container: unsupported } = render(
        <VideoStitchNode {...createNodeProps({ encoderSupported: false })} />
      );
      expect(unsupported.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Empty State", () => {
    it("should show placeholder when no clips connected", () => {
      render(<VideoStitchNode {...createNodeProps()} />);
      expect(screen.getByText("Connect videos to stitch")).toBeInTheDocument();
    });
  });

  describe("Stitch Button", () => {
    it("should call regenerateNode when stitch button clicked", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0", data: { createdAt: 1 } },
          { id: "e2", source: "gen2", target: "test-stitch-1", targetHandle: "video-1", data: { createdAt: 2 } },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
          { id: "gen2", type: "generateVideo", data: { outputVideo: "blob:video2" } },
        ],
      });

      render(<VideoStitchNode {...createNodeProps({ clipOrder: ["e1", "e2"] })} />);

      const stitchButton = screen.getByText("Stitch");
      expect(stitchButton).not.toBeDisabled();
      fireEvent.click(stitchButton);
      expect(mockRegenerateNode).toHaveBeenCalledWith("test-stitch-1");
    });

    it("should disable stitch button when less than 2 clips", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0", data: { createdAt: 1 } },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
        ],
      });

      render(<VideoStitchNode {...createNodeProps({ clipOrder: ["e1"] })} />);
      expect(screen.getByText("Stitch")).toBeDisabled();
    });
  });
});
