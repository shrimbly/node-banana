import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EaseCurveNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
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
      "data-testid": `handle-${props.id}-${props.type}`,
      "data-handleid": props.id,
      "data-handletype": props["data-handletype"],
      "data-type": props.type,
      "data-position": props.position,
      className: `react-flow__handle react-flow__handle-${props.position}`,
      style: props.style,
    });
  return {
    Handle: MockHandle,
    NodeResizer: () => null,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
    useReactFlow: () => ({
      getNodes: () => [],
      setNodes: vi.fn(),
      screenToFlowPosition: (pos: unknown) => pos,
    }),
    useConnection: (selector: (state: { inProgress: boolean }) => boolean) => selector({ inProgress: false }),
    useNodeId: () => "node-1",
  };
});

// Mock checkEncoderSupport
const mockCheckEncoderSupport = vi.fn();
vi.mock("@/hooks/useStitchVideos", () => ({
  checkEncoderSupport: () => mockCheckEncoderSupport(),
}));

// Mock useVideoBlobUrl - return the input as-is
vi.mock("@/hooks/useVideoBlobUrl", () => ({
  useVideoBlobUrl: (url: string | null) => url,
}));

// Mock useVideoAutoplay - return a simple ref
vi.mock("@/hooks/useVideoAutoplay", () => ({
  useVideoAutoplay: () => ({ current: null }),
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

import { EaseCurveNode } from "@/components/nodes/EaseCurveNode";

/** Set up mock store state */
function setMockStoreState(overrides: Record<string, unknown> = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
    removeEdge: mockRemoveEdge,
    edges: [],
    nodes: [],
    isRunning: false,
    hoveredNodeId: null,
    ...overrides,
  };
  mockUseWorkflowStore.mockImplementation(
    (selector: (s: typeof state) => unknown) => selector(state)
  );
}

const createNodeData = (
  overrides: Partial<EaseCurveNodeData> = {}
): EaseCurveNodeData => ({
  bezierHandles: [0.42, 0, 0.58, 1],
  easingPreset: null,
  inheritedFrom: null,
  outputDuration: 1.5,
  outputVideo: null,
  status: "idle",
  error: null,
  progress: 0,
  encoderSupported: true,
  ...overrides,
});

const createNodeProps = (data: Partial<EaseCurveNodeData> = {}) => ({
  id: "test-ease-1",
  type: "easeCurve" as const,
  data: createNodeData(data),
  selected: false,
});

describe("EaseCurveNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEncoderSupport.mockResolvedValue(true);
    setMockStoreState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handle Rendering", () => {
    it("should render 4 handles: video in/out and easeCurve in/out", () => {
      const { container } = render(
        <EaseCurveNode {...createNodeProps()} />
      );

      // Video input (target)
      expect(
        container.querySelector('[data-handleid="video"][data-type="target"]')
      ).toBeInTheDocument();
      // Video output (source)
      expect(
        container.querySelector('[data-handleid="video"][data-type="source"]')
      ).toBeInTheDocument();
      // EaseCurve input (target)
      expect(
        container.querySelector('[data-handleid="easeCurve"][data-type="target"]')
      ).toBeInTheDocument();
      // EaseCurve output (source)
      expect(
        container.querySelector('[data-handleid="easeCurve"][data-type="source"]')
      ).toBeInTheDocument();
    });

    it("renders handles in checking and unsupported states", () => {
      const { container: checking } = render(
        <EaseCurveNode {...createNodeProps({ encoderSupported: null })} />
      );
      expect(checking.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);

      const { container: unsupported } = render(
        <EaseCurveNode {...createNodeProps({ encoderSupported: false })} />
      );
      expect(unsupported.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);
    });

    it("should render handle labels for Video In, Video Out, and Settings", () => {
      render(<EaseCurveNode {...createNodeProps()} />);
      expect(screen.getByText("Video In")).toBeInTheDocument();
      expect(screen.getByText("Video Out")).toBeInTheDocument();
      // Two Settings labels (input and output)
      expect(screen.getAllByText("Settings")).toHaveLength(2);
    });
  });

  describe("Encoder Detection States", () => {
    it("should show checking spinner when encoderSupported is null", () => {
      render(<EaseCurveNode {...createNodeProps({ encoderSupported: null })} />);
      expect(screen.getByText("Checking encoder...")).toBeInTheDocument();
    });

    it("should show unsupported message when encoderSupported is false", () => {
      render(<EaseCurveNode {...createNodeProps({ encoderSupported: false })} />);
      expect(
        screen.getByText(/doesn.t support video encoding/)
      ).toBeInTheDocument();
    });

    it("should show Discord link when encoder is unsupported", () => {
      render(<EaseCurveNode {...createNodeProps({ encoderSupported: false })} />);
      const link = screen.getByText(/Message Willie on Discord/);
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute(
        "href",
        "https://discord.com/invite/89Nr6EKkTf"
      );
    });
  });

  describe("Video Display", () => {
    it("should show placeholder when no output video", () => {
      render(<EaseCurveNode {...createNodeProps()} />);
      expect(
        screen.getByText("Run workflow to apply ease curve")
      ).toBeInTheDocument();
    });

    it("should show video element when outputVideo exists", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({ outputVideo: "blob:http://localhost/video" })}
        />
      );
      const video = document.querySelector("video");
      expect(video).toBeInTheDocument();
      expect(video?.getAttribute("src")).toBe("blob:http://localhost/video");
    });

    it("should render video with correct attributes", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({ outputVideo: "blob:http://localhost/video" })}
        />
      );
      const video = document.querySelector("video");
      expect(video).toHaveAttribute("loop");
      expect(video).toHaveAttribute("controls");
    });

    it("should show clear button when outputVideo exists", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({ outputVideo: "blob:http://localhost/video" })}
        />
      );
      const clearBtn = screen.getByTitle("Clear video");
      expect(clearBtn).toBeInTheDocument();
    });

    it("should clear video when clear button is clicked", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({ outputVideo: "blob:http://localhost/video" })}
        />
      );
      fireEvent.click(screen.getByTitle("Clear video"));
      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-ease-1", {
        outputVideo: null,
        status: "idle",
      });
    });
  });

  describe("Processing State", () => {
    it("should show processing overlay when status is loading", () => {
      render(
        <EaseCurveNode {...createNodeProps({ status: "loading", progress: 45 })} />
      );
      expect(screen.getByText("Processing... 45%")).toBeInTheDocument();
    });

    it("should round progress percentage", () => {
      render(
        <EaseCurveNode {...createNodeProps({ status: "loading", progress: 33.7 })} />
      );
      expect(screen.getByText("Processing... 34%")).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when status is error", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({
            status: "error",
            error: "Encoder failed",
          })}
        />
      );
      expect(screen.getByText("Encoder failed")).toBeInTheDocument();
    });

    it("should not show error when status is not error", () => {
      render(
        <EaseCurveNode
          {...createNodeProps({
            status: "idle",
            error: "Stale error message",
          })}
        />
      );
      expect(screen.queryByText("Stale error message")).not.toBeInTheDocument();
    });
  });

  describe("Inheritance", () => {
    it("should detect inherited edge from store edges", () => {
      setMockStoreState({
        edges: [
          {
            id: "ec-edge",
            source: "parent-ease",
            target: "test-ease-1",
            targetHandle: "easeCurve",
          },
        ],
      });
      // Rendering should not throw even when inherited
      const { container } = render(<EaseCurveNode {...createNodeProps()} />);
      expect(container.querySelector('[data-testid="base-node"]')).toBeInTheDocument();
    });

    it("should not detect inheritance when edge targets different node", () => {
      setMockStoreState({
        edges: [
          {
            id: "ec-edge",
            source: "parent-ease",
            target: "other-node",
            targetHandle: "easeCurve",
          },
        ],
      });
      const { container } = render(<EaseCurveNode {...createNodeProps()} />);
      expect(container.querySelector('[data-testid="base-node"]')).toBeInTheDocument();
    });
  });
});
