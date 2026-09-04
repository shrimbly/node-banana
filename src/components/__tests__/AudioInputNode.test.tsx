import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AudioInputNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
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

// Mock useAudioVisualization
const mockWaveformData = {
  peaks: Array.from({ length: 256 }, () => Math.random()),
  channelData: [new Float32Array(1000)],
  sampleRate: 44100,
  duration: 3.5,
};

let mockVisualizationReturn = {
  waveformData: null as typeof mockWaveformData | null,
  isLoading: false,
  error: null as string | null,
};

vi.mock("@/hooks/useAudioVisualization", () => ({
  useAudioVisualization: () => mockVisualizationReturn,
}));

import { AudioInputNode } from "@/components/nodes/AudioInputNode";

/** Set up mock store state */
function setMockStoreState(overrides: Record<string, unknown> = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
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
  mockUseWorkflowStore.mockImplementation(
    (selector: (s: typeof state) => unknown) => selector(state)
  );
}

const createNodeData = (
  overrides: Partial<AudioInputNodeData> = {}
): AudioInputNodeData => ({
  audioFile: null,
  filename: null,
  duration: null,
  format: null,
  ...overrides,
});

const createNodeProps = (data: Partial<AudioInputNodeData> = {}) => ({
  id: "test-audio-1",
  type: "audioInput" as const,
  data: createNodeData(data),
  selected: false,
});

describe("AudioInputNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMockStoreState();
    mockVisualizationReturn = {
      waveformData: null,
      isLoading: false,
      error: null,
    };
    // Mock global alert
    vi.spyOn(window, "alert").mockImplementation(() => {});
    // Mock global fetch for base64 to blob conversion
    vi.spyOn(global, "fetch").mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["audio"], { type: "audio/mp3" })),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handle Rendering", () => {
    it("should render a source handle with id=audio", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const handle = container.querySelector('[data-handleid="audio"]');
      expect(handle).toBeInTheDocument();
    });
  });

  describe("Empty State", () => {
    it("should show drop zone text when no audio loaded", () => {
      render(<AudioInputNode {...createNodeProps()} />);
      expect(screen.getByText("Drop audio or click")).toBeInTheDocument();
    });

    it("should have a hidden file input", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveClass("hidden");
    });

    it("should accept audio files", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput?.getAttribute("accept")).toContain("audio/");
    });
  });

  describe("File Upload Validation", () => {
    it("should reject non-audio files", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const fileInput = container.querySelector('input[type="file"]')!;

      const file = new File(["content"], "test.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      expect(window.alert).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported format")
      );
    });

    it("should reject files larger than 50MB", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const fileInput = container.querySelector('input[type="file"]')!;

      // Create a file object with a large size
      const file = new File(["x"], "large.mp3", { type: "audio/mp3" });
      Object.defineProperty(file, "size", { value: 51 * 1024 * 1024 });
      fireEvent.change(fileInput, { target: { files: [file] } });

      expect(window.alert).toHaveBeenCalledWith(
        expect.stringContaining("50MB")
      );
    });

    it("should accept valid audio files and use FileReader", () => {
      // Mock FileReader as a class
      const mockReadAsDataURL = vi.fn();
      class MockFileReader {
        onload: ((e: unknown) => void) | null = null;
        result = "data:audio/mp3;base64,abc";
        readAsDataURL = mockReadAsDataURL;
      }
      vi.stubGlobal("FileReader", MockFileReader);

      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const fileInput = container.querySelector('input[type="file"]')!;

      const file = new File(["audio"], "test.mp3", { type: "audio/mp3" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      expect(window.alert).not.toHaveBeenCalled();
      expect(mockReadAsDataURL).toHaveBeenCalledWith(file);

      vi.unstubAllGlobals();
    });
  });

  describe("Loaded State", () => {
    it("should display filename when audio is loaded", () => {
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test-song.mp3",
            duration: 180,
          })}
        />
      );
      expect(screen.getByText("test-song.mp3")).toBeInTheDocument();
    });

    it("should display formatted duration", () => {
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 125, // 2:05
          })}
        />
      );
      expect(screen.getByText("2:05")).toBeInTheDocument();
    });

    it("should show loading state when waveform is loading", () => {
      mockVisualizationReturn = {
        waveformData: null,
        isLoading: true,
        error: null,
      };
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 10,
          })}
        />
      );
      expect(screen.getByText("Loading waveform...")).toBeInTheDocument();
    });

    it("should show processing state when no waveform and not loading", () => {
      mockVisualizationReturn = {
        waveformData: null,
        isLoading: false,
        error: null,
      };
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 10,
          })}
        />
      );
      expect(screen.getByText("Processing...")).toBeInTheDocument();
    });
  });

  describe("Play/Pause Controls", () => {
    it("should render play button when audio is loaded", () => {
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 10,
          })}
        />
      );
      expect(screen.getByTitle("Play")).toBeInTheDocument();
    });
  });

  describe("Remove", () => {
    it("should call updateNodeData to clear data when remove is clicked", () => {
      const { container } = render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 10,
          })}
        />
      );

      // The remove button is the X button inside the loaded state
      // It contains an SVG with an X path
      const buttons = container.querySelectorAll("button");
      // Find the remove button (has the X SVG icon, positioned absolute top right)
      const removeButton = Array.from(buttons).find((btn) =>
        btn.querySelector("path[d*='M6 18L18 6']")
      );
      expect(removeButton).toBeTruthy();

      fireEvent.click(removeButton!);
      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-audio-1", {
        audioFile: null,
        filename: null,
        duration: null,
        format: null,
      });
    });
  });

  describe("Drag and Drop", () => {
    it("should handle dragOver by preventing default", () => {
      const { container } = render(
        <AudioInputNode {...createNodeProps()} />
      );
      const dropZone = screen.getByText("Drop audio or click").closest("div")!;
      const event = new Event("dragover", { bubbles: true });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      dropZone.dispatchEvent(event);
    });
  });

  describe("Time Formatting", () => {
    it("should format 0 seconds as 0:00", () => {
      render(
        <AudioInputNode
          {...createNodeProps({
            audioFile: "data:audio/mp3;base64,abc",
            filename: "test.mp3",
            duration: 60,
          })}
        />
      );
      // The current time display should show 0:00
      expect(screen.getByText("0:00")).toBeInTheDocument();
    });
  });
});
