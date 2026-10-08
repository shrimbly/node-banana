import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const download = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/utils/downloadMedia", () => ({ downloadMedia: download }));

import { AgentTranscriptActionsProvider, type AgentTranscriptActions } from "@/components/agent/AgentSession";
import { AgentSurfaceProvider, type AgentSurface } from "@/components/agent/AgentSurface";
import { AgentRunResults, fixRequestMessage, formatElapsed } from "@/components/agent/AgentRunResults";
import { MEDIA_RETRY_MS, withLineBreaks } from "@/components/agent/AgentRunMedia";
import type { AgentRunOutput, AgentRunRecord } from "@/lib/agent/types";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";

const SHA = "a".repeat(64);

function node(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    chatId: "chat-1",
    anchor: { toolCallId: "call-1" },
    tabId: "tab-a",
    workflowName: "Hero shots",
    label: "Run workflow",
    scope: { kind: "all" },
    runs: 1,
    startedAt: Date.now() - 12_000,
    finishedAt: Date.now(),
    status: "done",
    progress: { index: 1, count: 1 },
    plannedNodeIds: [],
    ranNodeIds: ["gen"],
    outputs: [],
    errors: [],
    ...overrides,
  };
}

function image(id: string, nodeId = "gen", extra: Partial<AgentRunOutput> = {}): AgentRunOutput {
  return {
    id,
    nodeId,
    nodeTitle: "Generate Image",
    nodeType: "nanoBanana",
    kind: "image",
    assetId: id,
    sha256: SHA,
    width: 1600,
    height: 900,
    model: "Nano Banana",
    prompt: "a fox in the snow",
    ...extra,
  };
}

function actions(): AgentTranscriptActions {
  return { chatId: "chat-1", send: vi.fn(() => true), showOnCanvas: vi.fn(() => true), busy: false };
}

function renderCard(run: AgentRunRecord, options: { transcript?: AgentTranscriptActions | null; surface?: AgentSurface } = {}) {
  const { transcript = actions(), surface = "window" } = options;
  const wrap = (children: ReactNode) => (
    <AgentSurfaceProvider value={surface}>
      {transcript ? <AgentTranscriptActionsProvider value={transcript}>{children}</AgentTranscriptActionsProvider> : children}
    </AgentSurfaceProvider>
  );
  const view = render(wrap(<AgentRunResults record={run} />));
  return { ...view, transcript, rerenderCard: (next: AgentRunRecord) => view.rerender(wrap(<AgentRunResults record={next} />)) };
}

beforeEach(() => {
  useWorkflowStore.setState({
    nodes: [node("gen", "nanoBanana", { aspectRatio: "16:9" })],
    edges: [],
    tabs: [{ id: "tab-a", snapshot: null }],
    activeTabId: "tab-a",
    isRunning: false,
    batch: null,
  });
  useAssetStore.setState({ appView: "chat" });
  download.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatElapsed", () => {
  it("reads seconds, then minutes, then hours", () => {
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("AgentRunResults while running", () => {
  it("holds a skeleton for every planned generator, by what it makes", () => {
    useWorkflowStore.setState({
      nodes: [
        node("prompt", "prompt"),
        node("gen", "nanoBanana", { aspectRatio: "16:9", status: "loading" }),
        node("llm", "llmGenerate"),
        node("voice", "generateAudio"),
      ],
      isRunning: true,
    });
    const { container } = renderCard(
      record({ status: "running", finishedAt: undefined, plannedNodeIds: ["prompt", "gen", "llm", "voice"], ranNodeIds: ["gen"] }),
    );
    expect(screen.getByRole("group", { name: "Run workflow" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-run-skeleton="image"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-run-skeleton="text"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-run-skeleton="audio"]')).toHaveLength(1);
    // One lone image skeleton keeps the node's 16:9 shape.
    const lone = container.querySelector('[data-run-media="lone"] > div') as HTMLElement;
    expect(lone.style.aspectRatio).toBe(`${16 / 9}`);
  });

  it("fills a skeleton as its output arrives, and keeps one per run still to come in a batch", () => {
    useWorkflowStore.setState({ isRunning: true });
    const running = record({ status: "running", finishedAt: undefined, runs: 3, progress: { index: 2, count: 3 }, plannedNodeIds: ["gen"] });
    const { container, rerenderCard } = renderCard({ ...running, outputs: [] });
    expect(container.querySelectorAll('[data-run-skeleton="image"]')).toHaveLength(2);
    expect(screen.getByText(/Run 2 of 3/)).toBeInTheDocument();
    rerenderCard({ ...running, outputs: [image("x1", "gen", { batchIndex: 0 })] });
    expect(container.querySelectorAll('[data-run-skeleton="image"]')).toHaveLength(1);
    expect(container.querySelector('[data-run-tile="x1"]')).toBeInTheDocument();
  });

  it("ticks the elapsed time and offers Stop", () => {
    vi.useFakeTimers();
    const requestStop = vi.fn();
    useWorkflowStore.setState({ isRunning: true, requestStop });
    renderCard(record({ status: "running", startedAt: Date.now() - 5_000, finishedAt: undefined }));
    expect(screen.getByText("5s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("7s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Run again" })).not.toBeInTheDocument();
  });

  it("says Stop lets the current run finish mid-batch", () => {
    useWorkflowStore.setState({ isRunning: true, batch: { id: "b", index: 1, count: 3, stopping: false } });
    renderCard(record({ status: "running", finishedAt: undefined, runs: 3, progress: { index: 1, count: 3 } }));
    expect(screen.getByRole("button", { name: "Stop after this run" })).toBeInTheDocument();
  });

  it("announces the end of a run it watched, once", () => {
    const running = record({ status: "running", finishedAt: undefined });
    const { container, rerenderCard } = renderCard(running);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("");
    rerenderCard({ ...running, status: "done", finishedAt: Date.now() });
    expect(live).toHaveTextContent("Run workflow finished");
  });
});

describe("AgentRunResults outputs", () => {
  it("draws images, video, 3D, live media, audio and text", () => {
    useWorkflowStore.setState({
      nodes: [
        node("gen", "nanoBanana"),
        node("vid", "generateVideo"),
        node("mesh", "generate3d"),
        node("live", "nanoBanana", { outputImage: "data:image/png;base64,AAAA" }),
        node("voice", "generateAudio"),
        node("llm", "llmGenerate"),
      ],
    });
    const run = record({
      ranNodeIds: ["gen", "vid", "mesh", "live", "voice", "llm"],
      outputs: [
        image("img-1"),
        { ...image("vid-1", "vid"), nodeTitle: "Generate Video", nodeType: "generateVideo", kind: "video", hasPoster: true },
        { id: "mesh-1", nodeId: "mesh", nodeTitle: "Generate 3D", nodeType: "generate3d", kind: "model3d", assetId: "mesh-1", sha256: SHA },
        { id: "live:0", nodeId: "live", nodeTitle: "Live Image", nodeType: "nanoBanana", kind: "image", live: true },
        { id: "aud-1", nodeId: "voice", nodeTitle: "Generate Audio", nodeType: "generateAudio", kind: "audio", assetId: "aud-1", sha256: SHA },
        { id: "llm:0", nodeId: "llm", nodeTitle: "LLM Generate", nodeType: "llmGenerate", kind: "text", text: "**Bold** caption" },
      ],
    });
    const { container, transcript } = renderCard(run);

    const grid = container.querySelector('[data-run-media="grid"]')!;
    expect(grid).toHaveAttribute("data-columns", "2");
    // Grid cells use the 640px thumbnail; a video its stored poster.
    expect(container.querySelector('[data-run-tile="img-1"] img')).toHaveAttribute("src", `/api/assets/thumb/${SHA}?w=640`);
    expect(container.querySelector('[data-run-tile="vid-1"] img')).toHaveAttribute("src", `/api/assets/thumb/${SHA}?w=640&poster=1`);
    expect(container.querySelector('[data-run-tile="live:0"] img')).toHaveAttribute("src", "data:image/png;base64,AAAA");

    fireEvent.click(screen.getByRole("button", { name: "Show Generate 3D's 3D model on the canvas" }));
    expect(transcript!.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["mesh"] });

    const audio = container.querySelector('[data-run-audio="aud-1"] audio')!;
    expect(audio).toHaveAttribute("src", "/api/assets/aud-1/file");
    expect(audio).toHaveAttribute("preload", "none");

    const text = container.querySelector('[data-run-text="llm:0"]') as HTMLElement;
    expect(within(text).getByText("Bold")).toBeInTheDocument();
    expect(text).not.toHaveTextContent("**");
    expect(within(text).getByRole("button", { name: "Copy text" })).toBeInTheDocument();
  });

  it("folds a long text output behind Show more", () => {
    const text: AgentRunOutput = { id: "llm:0", nodeId: "llm", nodeTitle: "LLM Generate", nodeType: "llmGenerate", kind: "text", text: "A line.\n\n".repeat(30) };
    const { unmount } = renderCard(record({ outputs: [text] }));
    // jsdom lays nothing out: a short text never overflows.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    unmount();

    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
    try {
      renderCard(record({ outputs: [text] }));
      const more = screen.getByRole("button", { name: "Show more" });
      expect(more).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(more);
      expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("shows a live output only while its tab is open, else a way to the canvas", () => {
    useWorkflowStore.setState({
      nodes: [node("other", "prompt")],
      tabs: [
        { id: "tab-a", snapshot: null },
        { id: "tab-b", snapshot: null },
      ],
      activeTabId: "tab-b",
    });
    const { transcript } = renderCard(
      record({ outputs: [{ id: "gen:0", nodeId: "gen", nodeTitle: "Generate Image", nodeType: "nanoBanana", kind: "image", live: true }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Open the canvas to see it/ }));
    expect(transcript!.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen"] });
  });

  it("draws one image large, keeping its shape under the surface's height", () => {
    const { container, unmount } = renderCard(record({ outputs: [image("img-1")] }));
    const frame = container.querySelector('[data-run-media="lone"] > div') as HTMLElement;
    expect(frame.style.aspectRatio).toBe(`${1600 / 900}`);
    expect(frame.style.maxWidth).toBe(`${Math.round(260 * (1600 / 900))}px`);
    // Shown large, so the file rather than the thumbnail.
    expect(frame.querySelector("img")).toHaveAttribute("src", "/api/assets/img-1/file");
    unmount();

    const page = renderCard(record({ outputs: [image("img-1")] }), { surface: "page" });
    const pageFrame = page.container.querySelector('[data-run-media="lone"] > div') as HTMLElement;
    expect(pageFrame.style.maxWidth).toBe(`${Math.round(420 * (1600 / 900))}px`);
  });

  it("lays five or more out in three columns on the page and two in the window", () => {
    const outputs = ["1", "2", "3", "4", "5"].map((id) => image(`img-${id}`));
    const page = renderCard(record({ outputs }), { surface: "page" });
    expect(page.container.querySelector('[data-run-media="grid"]')).toHaveAttribute("data-columns", "3");
    page.unmount();
    const window = renderCard(record({ outputs }));
    expect(window.container.querySelector('[data-run-media="grid"]')).toHaveAttribute("data-columns", "2");
  });

  it("asks for a missing file again after a moment, then falls back to the node's own media", () => {
    vi.useFakeTimers();
    useWorkflowStore.setState({ nodes: [node("gen", "nanoBanana", { outputImage: "data:image/png;base64,LIVE" })] });
    const { container } = renderCard(record({ outputs: [image("img-1")] }));
    const tile = () => container.querySelector('[data-run-tile="img-1"]')!;
    fireEvent.error(tile().querySelector("img")!);
    expect(tile().querySelector("img")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MEDIA_RETRY_MS);
    });
    expect(tile().querySelector("img")).toHaveAttribute("src", "/api/assets/img-1/file?retry=1");
    fireEvent.error(tile().querySelector("img")!);
    expect(tile().querySelector("img")).toHaveAttribute("src", "data:image/png;base64,LIVE");
    fireEvent.error(tile().querySelector("img")!);
    expect(screen.getByText("Open the canvas to see it")).toBeInTheDocument();
  });
});

describe("AgentRunResults viewer", () => {
  it("opens the record's images full screen, with Download and Show on canvas", () => {
    const { transcript } = renderCard(record({ outputs: [image("img-1"), image("img-2")] }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open Generate Image's image" })[1]);

    const viewer = screen.getByRole("dialog", { name: "Run workflow" });
    expect(within(viewer).getByText("2 of 2")).toBeInTheDocument();
    expect(within(viewer).getByText("a fox in the snow")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledWith("/api/assets/img-2/file?download=1", "image");

    fireEvent.click(within(viewer).getByRole("button", { name: "Show on canvas" }));
    expect(transcript!.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen"] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape without the key reaching the window around the card", () => {
    const windowKeys = vi.fn();
    const wrapper = render(
      <div onKeyDown={windowKeys}>
        <AgentRunResults record={record({ outputs: [image("img-1"), image("img-2")] })} />
      </div>,
    );
    fireEvent.click(within(wrapper.container).getAllByRole("button", { name: "Open Generate Image's image" })[0]);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Run workflow" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(windowKeys).not.toHaveBeenCalled();
  });

  it("goes to Assets from the viewer's footer", () => {
    renderCard(record({ outputs: [image("img-1"), image("img-2")] }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open Generate Image's image" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Open in Assets" }));
    expect(useAssetStore.getState().appView).toBe("assets");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("AgentRunResults outcomes", () => {
  const failed = record({
    status: "failed",
    errors: [{ nodeId: "gen", nodeTitle: "Generate Image", message: "Invalid API key" }],
  });

  it("lists each failed node with its error, and asks the agent to fix it", () => {
    const { transcript } = renderCard(failed);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Generate Image: Invalid API key");
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent to fix it" }));
    expect(transcript!.send).toHaveBeenCalledWith(fixRequestMessage(failed));
    expect(fixRequestMessage(failed)).toBe(
      'The run "Run workflow" in "Hero shots" failed:\n- Generate Image (gen): Invalid API key\nPlease fix it.',
    );
    expect(screen.getByRole("button", { name: "Asked the agent" })).toBeDisabled();
  });

  it("leaves out what needs the agent session when there is none", () => {
    renderCard(failed, { transcript: null });
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid API key");
    expect(screen.queryByRole("button", { name: "Ask the agent to fix it" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show on canvas" })).not.toBeInTheDocument();
  });

  it("marks a stopped run, with Show on canvas and Run again", () => {
    const { transcript } = renderCard(record({ status: "stopped", ranNodeIds: ["gen", "out"] }));
    expect(screen.getByRole("img", { name: "Stopped" })).toBeInTheDocument();
    expect(screen.getByText(/^Stopped · \d+s$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show on canvas" }));
    expect(transcript!.showOnCanvas).toHaveBeenCalledWith({ tabId: "tab-a", nodeIds: ["gen", "out"] });
    expect(screen.getByRole("button", { name: "Run again" })).not.toHaveAttribute("aria-disabled");
  });

  it("holds Run again while another run goes, or once its nodes are gone", () => {
    const runBatch = vi.fn();
    useWorkflowStore.setState({ isRunning: true, runBatch });
    renderCard(record({ scope: { kind: "nodes", nodeIds: ["gen"] } }));
    const again = screen.getByRole("button", { name: "Run again" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(again);
    expect(runBatch).not.toHaveBeenCalled();

    act(() => useWorkflowStore.setState({ isRunning: false, nodes: [] }));
    expect(screen.getByRole("button", { name: "Run again" })).toHaveAttribute("aria-disabled", "true");
  });

  it("runs again under the same anchor, and says why when the run doesn't start", () => {
    // A store whose run never starts (offline, nothing runnable).
    const runBatch = vi.fn().mockResolvedValue(undefined);
    useWorkflowStore.setState({ runBatch });
    renderCard(record({ scope: { kind: "nodes", nodeIds: ["gen"] }, runs: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(runBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["gen"] }, 2);
    expect(screen.getByRole("alert")).toHaveTextContent("The run didn't start");
  });
});

describe("withLineBreaks", () => {
  it("keeps a reply's single line breaks as hard breaks", () => {
    expect(withLineBreaks("Golden crescent ripe,\nfreckled sweetness\nsummer")).toBe("Golden crescent ripe,  \nfreckled sweetness  \nsummer");
  });

  it("leaves paragraph breaks and fenced code alone", () => {
    expect(withLineBreaks("One\n\nTwo")).toBe("One\n\nTwo");
    expect(withLineBreaks("```\na = 1\nb = 2\n```\nafter")).toBe("```\na = 1\nb = 2\n```\nafter");
  });
});
