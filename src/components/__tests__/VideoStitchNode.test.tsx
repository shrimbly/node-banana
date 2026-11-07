import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { StitchAudioClip, VideoStitchNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockRemoveEdge = vi.fn();
const mockUseWorkflowStore = vi.fn();
// What getState() returns: the state setMockStoreState last set
let mockStoreState: Record<string, unknown> = {};

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    { getState: () => mockStoreState }
  ),
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
    useStore: () => undefined,
    useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }), subscribe: () => () => {} }),
    useUpdateNodeInternals: () => () => {},
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
    useReactFlow: () => ({
      getNodes: () => [],
      setNodes: () => {},
      screenToFlowPosition: (pos: unknown) => pos,
    }),
    useConnection: (selector: (state: { inProgress: boolean }) => boolean) => selector({ inProgress: false }),
    useNodeId: () => "node-1",
  };
});

// Mock useStitchVideos (this also prevents mediabunny from loading)
const mockCheckEncoderSupport = vi.fn();
vi.mock("@/hooks/useStitchVideos", () => ({
  checkEncoderSupport: () => mockCheckEncoderSupport(),
}));

// Open editor opens the editor's store; the editor itself is not under test here
const mockOpenStitchEditor = vi.fn();
vi.mock("@/components/stitch/openStitchEditor", () => ({
  openStitchEditor: (nodeId: string) => mockOpenStitchEditor(nodeId),
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

import { VideoStitchNode, __resetStitchWritesForTests } from "@/components/nodes/VideoStitchNode";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { createClip } from "@/lib/stitch/timeline";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { __resetAssetInfoForTests, requestAssetInfo } from "@/lib/stitch/assetInfo";
import {
  FILMSTRIP_FRAMES,
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  type MediaExtractor,
} from "@/lib/stitch/mediaInfo";

/**
 * jsdom cannot decode video: sources stay "loading" unless a test primes the
 * media cache with __setMediaInfoForTests (keyed by the source's URL).
 */
const pendingExtractor = {
  probe: () => new Promise<never>(() => {}),
  open: () => new Promise<never>(() => {}),
};

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
  mockStoreState = state;
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
    __resetStitchWritesForTests();
    vi.clearAllMocks();
    mockCheckEncoderSupport.mockResolvedValue(true);
    setMockStoreState();
    __resetMediaInfoForTests();
    __resetAssetInfoForTests();
    __setMediaExtractorForTests(pendingExtractor);
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
      expect(screen.getByText("Connect videos to edit")).toBeInTheDocument();
    });
  });

  describe("Sequence reconciliation", () => {
    const STITCH_ID = "test-stitch-1";
    const twoEdges = {
      edges: [
        { id: "e1", source: "gen1", target: STITCH_ID, targetHandle: "video-0" },
        { id: "e2", source: "gen2", target: STITCH_ID, targetHandle: "video-1" },
      ],
      nodes: [
        { id: "gen1", type: "generateVideo", data: { outputVideo: null } },
        { id: "gen2", type: "generateVideo", data: { outputVideo: null } },
      ],
    };
    const orderWrites = () =>
      mockUpdateNodeData.mock.calls.filter(([, patch]) => "clipOrder" in patch || "timeline" in patch);

    /** The store as React Flow sees it: the stitch node itself holds `data`. */
    function setGraph(graph: { edges: unknown[]; nodes: unknown[] }, data: VideoStitchNodeData) {
      setMockStoreState({
        edges: graph.edges,
        nodes: [...graph.nodes, { id: STITCH_ID, type: "videoStitch", data }],
      });
    }
    function renderStitch(graph: { edges: unknown[]; nodes: unknown[] }, overrides: Partial<VideoStitchNodeData>) {
      const props = createNodeProps(overrides);
      setGraph(graph, props.data);
      return render(<VideoStitchNode {...props} />);
    }

    it("writes nothing for a legacy node whose clipOrder matches its edges", () => {
      renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
      expect(orderWrites()).toEqual([]);
    });

    it("writes clipOrder alone when a legacy node gains an edge", () => {
      renderStitch(twoEdges, { clipOrder: ["e2"] });
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e2", "e1"] }]]);
    });

    it("writes the timeline with clipOrder for a node the editor emptied", () => {
      renderStitch({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, { clipOrder: [], timeline: [] });
      expect(orderWrites()).toEqual([
        [
          STITCH_ID,
          {
            timeline: [
              { id: "clip:e1", source: { kind: "edge", edgeId: "e1" }, inSec: 0, outSec: null, muted: false, volume: 1 },
            ],
            clipOrder: ["e1"],
          },
        ],
      ]);
    });

    it("treats a new node as legacy and writes clipOrder alone", () => {
      const fresh = createDefaultNodeData("videoStitch") as VideoStitchNodeData;
      expect("timeline" in fresh).toBe(false);
      const data = { ...fresh, encoderSupported: true };
      setGraph({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, data);
      render(<VideoStitchNode id={STITCH_ID} type="videoStitch" data={data} selected={false} />);
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1"] }]]);
    });

    it("writes nothing for a timeline node already in sync with its edges", () => {
      renderStitch(twoEdges, {
        clipOrder: ["e2", "e1"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }),
          createClip({ kind: "edge", edgeId: "e1" }, { id: "x", inSec: 1 }),
        ],
      });
      expect(orderWrites()).toEqual([]);
    });

    it("drops the clip of a vanished edge from a timeline node, keeping the others' trims", () => {
      const kept = createClip({ kind: "edge", edgeId: "e1" }, { id: "x", inSec: 1.5 });
      renderStitch(
        { edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] },
        { clipOrder: ["e2", "e1"], timeline: [createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }), kept] }
      );
      expect(orderWrites()).toEqual([[STITCH_ID, { timeline: [kept], clipOrder: ["e1"] }]]);
    });

    it("does not count a loop edge an older card saved into clipOrder as stale", () => {
      const loopEdge = { id: "eL", source: "gen3", target: STITCH_ID, targetHandle: "video-2", data: { isLoop: true } };
      renderStitch(
        { edges: [...twoEdges.edges, loopEdge], nodes: [...twoEdges.nodes, { id: "gen3", type: "generateVideo", data: {} }] },
        { clipOrder: ["e1", "e2", "eL"] }
      );
      expect(orderWrites()).toEqual([]);
    });

    it("does not write again when Undo restores the clipOrder from before its write", () => {
      const props = createNodeProps({ clipOrder: ["e1"] });
      setGraph(twoEdges, props.data);
      const { rerender } = render(<VideoStitchNode {...props} />);
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1", "e2"] }]]);

      // The write lands
      const written = createNodeData({ clipOrder: ["e1", "e2"] });
      setGraph(twoEdges, written);
      rerender(<VideoStitchNode {...props} data={written} />);
      // Undo restores the snapshot taken with the new edge and the old clipOrder
      const restored = createNodeData({ clipOrder: ["e1"] });
      setGraph(twoEdges, restored);
      rerender(<VideoStitchNode {...props} data={restored} />);

      expect(orderWrites()).toHaveLength(1);
    });

    it("does not write again when Undo's restored data mounts a new card (a painted copy on the GPU canvas)", () => {
      const props = createNodeProps({ clipOrder: ["e1"] });
      setGraph(twoEdges, props.data);
      const { unmount } = render(<VideoStitchNode {...props} />);
      expect(orderWrites()).toHaveLength(1);
      unmount();
      const restored = createNodeData({ clipOrder: ["e1"] });
      setGraph(twoEdges, restored);
      render(<VideoStitchNode {...props} data={restored} />);
      expect(orderWrites()).toHaveLength(1);
    });

    it("builds its write from the store, not from a data prop that has not caught up", () => {
      // The store already holds a newer timeline (a trim) for the new edges in the
      // same update; the prop still carries the old data
      const stale = createNodeData({
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "clip:e1" }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }),
        ],
      });
      const current = createNodeData({
        clipOrder: ["e1"],
        timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "clip:e1", inSec: 1.5 })],
      });
      setGraph({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, current);
      render(<VideoStitchNode {...createNodeProps()} data={stale} />);
      expect(orderWrites()).toEqual([]);
    });

    it("shows the clips in the stored order", () => {
      const { container } = renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
      const tiles = [...container.querySelectorAll("[data-clip-id]")].map((el) => el.getAttribute("data-clip-id"));
      expect(tiles).toEqual(["clip:e2", "clip:e1"]);
      expect(screen.getByText("2 clips")).toBeInTheDocument();
    });

    describe("drag reorder", () => {
      const originalElementsFromPoint = document.elementsFromPoint;
      beforeEach(() => {
        HTMLElement.prototype.setPointerCapture ??= () => {};
        HTMLElement.prototype.releasePointerCapture ??= () => {};
      });
      afterEach(() => {
        document.elementsFromPoint = originalElementsFromPoint;
      });

      function dragTile(container: HTMLElement, from: string, to: string) {
        const source = container.querySelector(`[data-clip-id="${from}"]`) as HTMLElement;
        const target = container.querySelector(`[data-clip-id="${to}"]`) as HTMLElement;
        document.elementsFromPoint = () => [target];
        fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
        fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(source, { pointerId: 1 });
      }

      it("writes the new clipOrder alone for a legacy node", () => {
        const { container } = renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
        dragTile(container, "clip:e2", "clip:e1");
        expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1", "e2"] }]]);
      });

      it("writes the moved timeline and its clipOrder for a timeline node", () => {
        const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a", inSec: 1 });
        const b = createClip({ kind: "edge", edgeId: "e2" }, { id: "b", muted: true });
        const { container } = renderStitch(twoEdges, { clipOrder: ["e1", "e2"], timeline: [a, b] });
        dragTile(container, "a", "b");
        expect(orderWrites()).toEqual([[STITCH_ID, { timeline: [b, a], clipOrder: ["e2", "e1"] }]]);
      });
    });

    describe("duration badges", () => {
      it("keeps the badges after a write that does not touch the sequence", () => {
        __setMediaInfoForTests("blob:video1", { duration: 5 });
        __setMediaInfoForTests("blob:video2", { duration: 5 });
        const graph = {
          edges: twoEdges.edges,
          nodes: [
            { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
            { id: "gen2", type: "generateVideo", data: { outputVideo: "blob:video2" } },
          ],
        };
        const props = createNodeProps({ clipOrder: ["e1", "e2"] });
        setGraph(graph, props.data);
        const { rerender } = render(<VideoStitchNode {...props} />);
        expect(screen.getAllByText("5s")).toHaveLength(2);

        const looped = { ...props.data, loopCount: 2 as const };
        setGraph(graph, looped);
        rerender(<VideoStitchNode {...props} data={looped} />);
        expect(screen.getAllByText("5s")).toHaveLength(2);
      });
    });
  });

  describe("Card", () => {
    const STITCH_ID = "test-stitch-1";
    const edge = (id: string, source: string, targetHandle: string) => ({
      id,
      source,
      target: STITCH_ID,
      sourceHandle: targetHandle === "audio" ? "audio" : "video",
      targetHandle,
    });
    const generated = (id: string, outputVideo: string | null) => ({ id, type: "generateVideo", data: { outputVideo } });
    /** Two generated clips: blob:v1 (5 s) on e1 and blob:v2 (4.4 s) on e2. */
    const twoClips = {
      edges: [edge("e1", "gen1", "video-0"), edge("e2", "gen2", "video-1")],
      nodes: [generated("gen1", "blob:v1"), generated("gen2", "blob:v2")],
    };

    function renderCard(graph: { edges: unknown[]; nodes: unknown[] }, overrides: Partial<VideoStitchNodeData> = {}) {
      const props = createNodeProps(overrides);
      setMockStoreState({
        edges: graph.edges,
        nodes: [...graph.nodes, { id: STITCH_ID, type: "videoStitch", data: props.data }],
      });
      return render(<VideoStitchNode {...props} />);
    }

    beforeEach(() => {
      __setMediaInfoForTests("blob:v1", { duration: 5 });
      __setMediaInfoForTests("blob:v2", { duration: 4.4 });
    });

    it("opens the editor from Open editor", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      fireEvent.click(screen.getByRole("button", { name: "Open editor" }));
      expect(mockOpenStitchEditor).toHaveBeenCalledWith(STITCH_ID);
    });

    it("keeps Open editor enabled with no clips", () => {
      renderCard({ edges: [], nodes: [] });
      expect(screen.getByRole("button", { name: "Open editor" })).not.toBeDisabled();
    });

    it("sums the sequence in the summary", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      expect(screen.getByText("2 clips")).toBeInTheDocument();
      expect(screen.getByText("0:09")).toBeInTheDocument();
      expect(screen.getByText("loop 1×")).toBeInTheDocument();
    });

    it("labels the loop chips with the multiplication sign", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      expect(screen.getByText("1×")).toBeInTheDocument();
      expect(screen.getByText("3×")).toBeInTheDocument();
      expect(screen.queryByText("1x")).toBeNull();
    });

    it("marks a clip whose sound is muted", () => {
      renderCard(twoClips, {
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "a", muted: true }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "b" }),
        ],
      });
      expect(screen.getAllByTitle("Clip audio muted")).toHaveLength(1);
      expect(screen.getByTitle("Clip audio muted").closest("[data-clip-id]")).toHaveAttribute("data-clip-id", "a");
    });

    it("marks every clip of a legacy node with music, whose sound the music replaces", () => {
      renderCard(
        {
          edges: [...twoClips.edges, edge("eM", "music", "audio")],
          nodes: [...twoClips.nodes, { id: "music", type: "generateAudio", data: { outputAudio: null } }],
        },
        { clipOrder: ["e1", "e2"] }
      );
      expect(screen.getAllByTitle("Clip audio muted")).toHaveLength(2);
    });

    it("shows a trimmed clip's own length", () => {
      renderCard(twoClips, {
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "a", inSec: 1 }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "b" }),
        ],
      });
      const tile = document.querySelector('[data-clip-id="a"]') as HTMLElement;
      expect(tile).toHaveTextContent("4s");
      expect(screen.getByText("0:08")).toBeInTheDocument();
    });

    it("counts a trim that starts past its source's end as 0 s and says why", () => {
      renderCard(twoClips, {
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "a", inSec: 6 }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "b" }),
        ],
      });
      expect(screen.getByTitle("Trim starts past the end of this video")).toBeInTheDocument();
      expect(screen.getByText("0:04")).toBeInTheDocument();
    });

    it("keeps the slot of a source that has not run", () => {
      renderCard(
        { edges: twoClips.edges, nodes: [generated("gen1", null), twoClips.nodes[1]] },
        { clipOrder: ["e1", "e2"] }
      );
      expect(screen.getByTitle("Not generated yet").closest("[data-clip-id]")).toHaveAttribute(
        "data-clip-id",
        "clip:e1"
      );
      expect(screen.getByText("2 clips")).toBeInTheDocument();
      expect(screen.getByText("0:04")).toBeInTheDocument();
      expect(screen.getByText("Render")).not.toBeDisabled();
    });

    it("shows a library clip's tile, and Render to preview with no socket in use", () => {
      __setMediaInfoForTests("a:alibrary00001", { duration: 3 });
      renderCard(
        { edges: [], nodes: [] },
        { clipOrder: [], timeline: [createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" })] }
      );
      expect(document.querySelector('[data-clip-id="lib"]')).toHaveTextContent("3s");
      expect(screen.getByText("Render to preview")).toBeInTheDocument();
      expect(screen.queryByText("No clips connected")).toBeNull();
    });

    it("removes one piece of a split clip from the sequence without disconnecting its edge", () => {
      const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "left", outSec: 2 });
      const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "right", inSec: 2 });
      const other = createClip({ kind: "edge", edgeId: "e2" }, { id: "other" });
      renderCard(twoClips, { clipOrder: ["e1", "e2"], timeline: [left, right, other] });
      const remove = document.querySelector('[data-clip-id="right"] button') as HTMLElement;
      expect(remove).toHaveAttribute("title", "Remove clip");
      fireEvent.click(remove);
      expect(mockRemoveEdge).not.toHaveBeenCalled();
      expect(mockUpdateNodeData).toHaveBeenCalledWith(STITCH_ID, { timeline: [left, other], clipOrder: ["e1", "e2"] });
    });

    it("disconnects the edge when its last clip is removed", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      const remove = document.querySelector('[data-clip-id="clip:e2"] button') as HTMLElement;
      expect(remove).toHaveAttribute("title", "Disconnect");
      fireEvent.click(remove);
      expect(mockRemoveEdge).toHaveBeenCalledWith("e2");
      expect(mockUpdateNodeData).not.toHaveBeenCalledWith(STITCH_ID, expect.objectContaining({ timeline: expect.anything() }));
    });

    it("keeps a socket for every edge, up to the highest one in use", () => {
      const { container } = renderCard(
        {
          edges: [edge("e0", "gen1", "video-0"), edge("e3", "gen2", "video-3")],
          nodes: twoClips.nodes,
        },
        { clipOrder: ["e0", "e3"] }
      );
      const handles = [...container.querySelectorAll("[data-handleid^='video-']")].map((el) =>
        el.getAttribute("data-handleid")
      );
      expect(handles).toEqual(["video-0", "video-1", "video-2", "video-3", "video-4"]);
    });

    it("has exactly one Render button", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      expect(screen.getAllByText("Render")).toHaveLength(1);
    });

    it("sums one loop in the summary and shows the loop apart", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"], loopCount: 3 });
      expect(screen.getByText("0:09")).toBeInTheDocument();
      expect(screen.getByText("loop 3×")).toBeInTheDocument();
    });

    it("reads the loop chips from the same loop count as the summary", () => {
      renderCard(twoClips, { clipOrder: ["e1", "e2"], loopCount: 4 as unknown as 1 });
      expect(screen.getByText("loop 1×")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "1×" })).toHaveAttribute("aria-checked", "true");
    });

    it("leaves the length out until every source is read", () => {
      renderCard(
        {
          edges: [...twoClips.edges, edge("e3", "gen3", "video-2")],
          nodes: [...twoClips.nodes, generated("gen3", "blob:v3")],
        },
        { clipOrder: ["e1", "e2", "e3"] }
      );
      expect(screen.getByText("3 clips")).toBeInTheDocument();
      expect(screen.getByText("loop 1×")).toBeInTheDocument();
      expect(screen.queryByText("0:09")).toBeNull();
      expect(screen.queryByText("0:00")).toBeNull();
    });

    it("shows the lengths and the sum once the sources are read after the first render", async () => {
      __resetMediaInfoForTests();
      const extractor: MediaExtractor = {
        probe: async () => ({ duration: 5, width: 160, height: 90, fps: 24 }),
        open: async () => ({ duration: 5, width: 160, height: 90, frame: async () => "blob:f", close() {} }),
      };
      __setMediaExtractorForTests(extractor);
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      expect(screen.queryByText("5s")).toBeNull();
      await waitFor(() => expect(screen.getAllByText("5s")).toHaveLength(2));
      expect(await screen.findByText("0:10")).toBeInTheDocument();
    });

    it("shows a trimmed clip's poster from inside its own range", () => {
      const frames = Array<string | null>(FILMSTRIP_FRAMES).fill(null);
      frames[1] = "blob:p1";
      frames[6] = "blob:p6";
      __setMediaInfoForTests("blob:v1", { duration: 12, frames });
      renderCard(twoClips, {
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "a", inSec: 0, outSec: 4 }),
          createClip({ kind: "edge", edgeId: "e1" }, { id: "b", inSec: 6 }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "c" }),
        ],
      });
      const poster = (clipId: string) =>
        (document.querySelector(`[data-clip-id="${clipId}"] img`) as HTMLImageElement | null)?.getAttribute("src");
      expect(poster("a")).toBe("blob:p1");
      expect(poster("b")).toBe("blob:p6");
    });

    it("gives the two pieces of a split clip their own posters", async () => {
      __resetMediaInfoForTests();
      // Each frame is named after its slot, so a filmstrip gives every piece a frame of its own
      const extractor: MediaExtractor = {
        probe: async () => ({ duration: 6, width: 160, height: 90, fps: 24 }),
        open: async () => ({
          duration: 6,
          width: 160,
          height: 90,
          frame: async (time) => `blob:slot${Math.round((time * FILMSTRIP_FRAMES) / 6 - 0.5)}`,
          close() {},
        }),
      };
      __setMediaExtractorForTests(extractor);
      renderCard(twoClips, {
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "left", outSec: 3 }),
          createClip({ kind: "edge", edgeId: "e1" }, { id: "right", inSec: 3 }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "other" }),
        ],
      });
      const left = document.querySelector('[data-clip-id="left"]') as HTMLElement;
      const right = document.querySelector('[data-clip-id="right"]') as HTMLElement;
      // Poster times 0.75 s and 3.75 s: slots 1 and 7
      expect(await within(left).findByRole("img")).toHaveAttribute("src", "blob:slot1");
      expect(await within(right).findByRole("img")).toHaveAttribute("src", "blob:slot7");
    });

    it("says when a source cannot be read", () => {
      __setMediaInfoForTests("blob:v1", { status: "error", duration: null });
      renderCard(twoClips, { clipOrder: ["e1", "e2"] });
      expect(screen.getByTitle("Can't read this video").closest("[data-clip-id]")).toHaveAttribute(
        "data-clip-id",
        "clip:e1"
      );
    });

    it("removes a library clip from the sequence", () => {
      __setMediaInfoForTests("a:alibrary00001", { duration: 3 });
      const lib = createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" });
      const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
      const b = createClip({ kind: "edge", edgeId: "e2" }, { id: "b" });
      renderCard(twoClips, { clipOrder: ["e1", "e2"], timeline: [a, lib, b] });
      const remove = document.querySelector('[data-clip-id="lib"] button') as HTMLElement;
      expect(remove).toHaveAttribute("title", "Remove clip");
      fireEvent.click(remove);
      expect(mockRemoveEdge).not.toHaveBeenCalled();
      expect(mockUpdateNodeData).toHaveBeenCalledWith(STITCH_ID, { timeline: [a, b], clipOrder: ["e1", "e2"] });
    });

    it("counts a library clip the library no longer has as 0 s, as the editor and a run do", async () => {
      // Read when the card was first drawn: the file's length is still in the cache
      __setMediaInfoForTests("a:agone00000001", { duration: 3 });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
      const lib = createClip({ kind: "asset", assetId: "agone00000001" }, { id: "lib" });
      const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
      renderCard(twoClips, { clipOrder: ["e1", "e2"], timeline: [a, lib] });
      // The card reads the record again when it mounts, and the library says it is gone
      await waitFor(() => expect(screen.getByTitle("Not in the library")).toBeInTheDocument());
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/assets/agone00000001"), expect.anything());
      expect(screen.getByTitle("Not in the library").closest("[data-clip-id]")).toHaveAttribute("data-clip-id", "lib");
      // Clip 1 (5 s) and e2 (4.4 s, appended): the gone clip adds nothing
      expect(screen.getByText("0:09")).toBeInTheDocument();
    });

    it("counts a library clip as gone once a run finds its file missing, though the card read the file before", async () => {
      // The card read the file while it was there
      __setMediaInfoForTests("a:agone00000001", { duration: 3 });
      const notFound = async (): Promise<never> => {
        throw new Error("Not found");
      };
      __setMediaExtractorForTests({ probe: notFound, open: notFound });
      const record = { id: "agone00000001", producer: { nodeId: "n", nodeType: "generateVideo" } };
      const answer = (body: object) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(record));
      const lib = createClip({ kind: "asset", assetId: "agone00000001" }, { id: "lib" });
      const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
      renderCard(twoClips, { clipOrder: ["e1", "e2"], timeline: [a, lib] });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(screen.getByText("0:12")).toBeInTheDocument();

      // A run gets a 404 for the file and reads the record again, which now says the file is missing
      fetchSpy.mockImplementation(async () => answer({ ...record, missing: true }));
      requestAssetInfo(["agone00000001"], { refresh: true });
      await waitFor(() => expect(screen.getByTitle("Not in the library")).toBeInTheDocument());
      // Clip 1 (5 s) and e2 (4.4 s, appended): the earlier read of the gone file adds nothing
      expect(screen.getByText("0:09")).toBeInTheDocument();
    });

    it("marks a library clip with the library badge, and only a library clip", () => {
      __setMediaInfoForTests("a:alibrary00001", { duration: 3 });
      const lib = createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" });
      const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
      renderCard(twoClips, { clipOrder: ["e1", "e2"], timeline: [a, lib] });
      const tile = document.querySelector('[data-clip-id="lib"]') as HTMLElement;
      expect(within(tile).getByTitle("From the library")).toBeInTheDocument();
      expect(within(document.querySelector('[data-clip-id="a"]') as HTMLElement).queryByTitle("From the library")).toBeNull();
    });

    it("stitches a node whose clips all come from the library, with no socket in use", () => {
      __setMediaInfoForTests("a:alibrary00001", { duration: 3 });
      __setMediaInfoForTests("a:alibrary00002", { duration: 4 });
      renderCard(
        { edges: [], nodes: [] },
        {
          clipOrder: [],
          timeline: [
            createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib1" }),
            createClip({ kind: "asset", assetId: "alibrary00002" }, { id: "lib2" }),
          ],
        }
      );
      expect(document.querySelectorAll("[data-clip-id]")).toHaveLength(2);
      expect(screen.getAllByTitle("From the library")).toHaveLength(2);
      expect(screen.getByText("Render to preview")).toBeInTheDocument();
      expect(screen.queryByText("No clips connected")).toBeNull();
      expect(screen.queryByText("Connect videos to edit")).toBeNull();
      const stitch = screen.getByText("Render");
      expect(stitch).not.toBeDisabled();
      fireEvent.click(stitch);
      expect(mockRegenerateNode).toHaveBeenCalledWith(STITCH_ID);
    });

    describe("stacked", () => {
      /** Three generated clips of 5, 5 and 6 s. */
      const threeClips = {
        edges: [edge("e1", "gen1", "video-0"), edge("e2", "gen2", "video-1"), edge("e3", "gen3", "video-2")],
        nodes: [generated("gen1", "blob:s1"), generated("gen2", "blob:s2"), generated("gen3", "blob:s3")],
      };
      const timeline = () => [
        createClip({ kind: "edge", edgeId: "e1" }, { id: "a" }),
        createClip({ kind: "edge", edgeId: "e2" }, { id: "b" }),
        createClip({ kind: "edge", edgeId: "e3" }, { id: "c" }),
      ];
      const stacked = (overlapSec: number, crossfade = true) => ({ mode: "stacked" as const, overlapSec, crossfade });
      const summaryText = () => screen.getByText("loop 1×").parentElement?.textContent;

      beforeEach(() => {
        __setMediaInfoForTests("blob:s1", { duration: 5 });
        __setMediaInfoForTests("blob:s2", { duration: 5 });
        __setMediaInfoForTests("blob:s3", { duration: 6 });
      });

      it("sums the stacked length and names the crossfade", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: stacked(1) });
        expect(summaryText()).toBe("0:14 · 1.0 s crossfade · loop 1×");
      });

      it("names the overlap when the crossfade is off", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: stacked(1, false) });
        expect(summaryText()).toBe("0:14 · 1.0 s overlap · loop 1×");
      });

      it("adds nothing when every join is a cut", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: stacked(0) });
        expect(summaryText()).toBe("0:16 · loop 1×");
        cleanup();
        // Pieces of one video meet with a cut
        const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "left", outSec: 2 });
        const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "right", inSec: 2 });
        const oneVideo = { edges: [threeClips.edges[0]], nodes: [threeClips.nodes[0]] };
        renderCard(oneVideo, { clipOrder: ["e1"], timeline: [left, right], sequenceLayout: stacked(1) });
        expect(summaryText()).toBe("0:05 · loop 1×");
      });

      it("reads Track whatever the overlap", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: { ...stacked(1), mode: "track" } });
        expect(summaryText()).toBe("0:16 · loop 1×");
      });

      it("counts the audio clips only once the audio is more than the music alone", () => {
        const track = { ...stacked(1), mode: "track" as const };
        const toneClip = (id: string, startSec: number) =>
          createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id, startSec });
        renderCard(threeClips, {
          clipOrder: ["e1", "e2", "e3"],
          timeline: timeline(),
          sequenceLayout: track,
          audioClips: [toneClip("t1", 0), toneClip("t2", 4)],
        });
        expect(summaryText()).toBe("0:16 · loop 1× · 2 audio clips");
        cleanup();
        // An empty list (a disconnect left it) reads as the music alone
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: track, audioClips: [] });
        expect(summaryText()).toBe("0:16 · loop 1×");
        cleanup();
        // With music connected: a stored lone untouched music clip is the music alone; a moved one is counted
        const withMusic = {
          edges: [...threeClips.edges, edge("eM", "music", "audio")],
          nodes: [...threeClips.nodes, { id: "music", type: "generateAudio", data: { outputAudio: null } }],
        };
        const musicClip = (init: Partial<StitchAudioClip>) => createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, ...init });
        const base = { clipOrder: ["e1", "e2", "e3"], timeline: timeline(), sequenceLayout: track };
        renderCard(withMusic, { ...base, audioClips: [musicClip({ row: 1, curve: [{ t: 1, gain: 0.5 }] })] });
        expect(summaryText()).toBe("0:16 · loop 1×");
        cleanup();
        renderCard(withMusic, { ...base, audioClips: [musicClip({ startSec: 2 })] });
        expect(summaryText()).toBe("0:16 · loop 1× · 1 audio clip");
      });

      it("keeps the layout through a removal and a reorder: their writes leave it out", () => {
        const piece = createClip({ kind: "edge", edgeId: "e2" }, { id: "b2", inSec: 2 });
        const { container } = renderCard(threeClips, {
          clipOrder: ["e1", "e2", "e3"],
          timeline: [...timeline(), piece],
          sequenceLayout: stacked(1),
        });
        // A piece of a split clip: removed from the sequence, its edge kept
        fireEvent.click(container.querySelector('[data-clip-id="b2"] button') as HTMLElement);
        HTMLElement.prototype.setPointerCapture ??= () => {};
        HTMLElement.prototype.releasePointerCapture ??= () => {};
        const original = document.elementsFromPoint;
        const target = container.querySelector('[data-clip-id="c"]') as HTMLElement;
        document.elementsFromPoint = () => [target];
        const source = container.querySelector('[data-clip-id="a"]') as HTMLElement;
        fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
        fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(source, { pointerId: 1 });
        document.elementsFromPoint = original;
        const writes = mockUpdateNodeData.mock.calls.filter(
          ([id, patch]) => id === STITCH_ID && ("timeline" in patch || "clipOrder" in patch),
        );
        expect(writes).toHaveLength(2);
        for (const [, patch] of writes) expect(patch).not.toHaveProperty("sequenceLayout");
      });

      /** placed-board: A 0–5; B (In 0.8) 6–10.2; C 9.2–15.2; A again (Out 3.2) 11–14.2, wholly under C. */
      const placedBoard = () => [
        createClip({ kind: "edge", edgeId: "e1" }, { id: "a", startSec: 0 }),
        createClip({ kind: "edge", edgeId: "e2" }, { id: "b", inSec: 0.8, startSec: 6 }),
        createClip({ kind: "edge", edgeId: "e3" }, { id: "c", startSec: 9.2 }),
        createClip({ kind: "edge", edgeId: "e1" }, { id: "a2", outSec: 3.2, startSec: 11 }),
      ];

      it("counts a placed stack's crossfades and gaps", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: placedBoard(), sequenceLayout: stacked(1) });
        // Clip 2 fades out over Clip 3; Clip 4 is hidden under Clip 3 and makes none
        expect(summaryText()).toBe("0:15 · 1 crossfade · 1 gap · loop 1×");
      });

      it("counts a placed stack's overlaps with the crossfade off", () => {
        renderCard(threeClips, { clipOrder: ["e1", "e2", "e3"], timeline: placedBoard(), sequenceLayout: stacked(1, false) });
        expect(summaryText()).toBe("0:15 · 2 overlaps · 1 gap · loop 1×");
      });

      it("keeps every stored start through the card's removal and reorder", () => {
        const { container } = renderCard(threeClips, {
          clipOrder: ["e1", "e2", "e3"],
          timeline: placedBoard(),
          sequenceLayout: stacked(1),
        });
        fireEvent.click(container.querySelector('[data-clip-id="a2"] button') as HTMLElement);
        HTMLElement.prototype.setPointerCapture ??= () => {};
        HTMLElement.prototype.releasePointerCapture ??= () => {};
        const original = document.elementsFromPoint;
        const target = container.querySelector('[data-clip-id="c"]') as HTMLElement;
        document.elementsFromPoint = () => [target];
        const source = container.querySelector('[data-clip-id="a"]') as HTMLElement;
        fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
        fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(source, { pointerId: 1 });
        document.elementsFromPoint = original;
        const writes = mockUpdateNodeData.mock.calls.filter(([id, patch]) => id === STITCH_ID && "timeline" in patch);
        // The removal's write, then the reorder's: a after c
        expect(writes).toHaveLength(2);
        const ids = (n: number) => (writes[n][1] as { timeline: Array<{ id: string }> }).timeline.map((clip) => clip.id);
        expect(ids(0)).toEqual(["a", "b", "c"]);
        expect(ids(1).indexOf("a")).toBeGreaterThan(ids(1).indexOf("c"));
        const starts = { a: 0, b: 6, c: 9.2, a2: 11 } as Record<string, number>;
        for (const [, patch] of writes) {
          for (const clip of (patch as { timeline: Array<{ id: string; startSec?: number }> }).timeline) {
            expect(clip.startSec).toBe(starts[clip.id]);
          }
        }
      });
    });
  });

  describe("Render Button", () => {
    it("should call regenerateNode when Render is clicked", () => {
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

      const stitchButton = screen.getByText("Render");
      expect(stitchButton).not.toBeDisabled();
      fireEvent.click(stitchButton);
      expect(mockRegenerateNode).toHaveBeenCalledWith("test-stitch-1");
    });

    it("should disable Render when less than 2 clips", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0", data: { createdAt: 1 } },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
        ],
      });

      render(<VideoStitchNode {...createNodeProps({ clipOrder: ["e1"] })} />);
      expect(screen.getByText("Render")).toBeDisabled();
    });
  });
});
