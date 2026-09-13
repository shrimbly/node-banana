/**
 * `blob:` object URLs are only good in the session that made them. A file
 * must never carry one, and one arriving in a file is dropped on load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { stripDeadBlobUrls } from "../utils/executionUtils";
import type { WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const initial = useWorkflowStore.getState();

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

describe("stripDeadBlobUrls", () => {
  it("nulls blob fields and drops blob array entries, at any depth", () => {
    const [video, gallery, untouched] = stripDeadBlobUrls([
      node("v", "videoStitch", { outputVideo: "blob:http://localhost:3000/abc", status: "complete" }),
      node("g", "outputGallery", { images: ["data:image/png;base64,a", "blob:http://localhost:3000/b"], nested: { clip: "blob:http://x/y" } }),
      node("p", "prompt", { prompt: "keep", images: ["data:image/png;base64,a"] }),
    ]);
    expect(video.data).toEqual({ outputVideo: null, status: "complete" });
    expect(gallery.data).toEqual({ images: ["data:image/png;base64,a"], nested: { clip: null } });
    expect(untouched.data).toEqual({ prompt: "keep", images: ["data:image/png;base64,a"] });
  });

  it("returns the same node object when it holds no blob URL", () => {
    const input = [node("p", "prompt", { prompt: "keep", history: [{ id: "a" }] })];
    expect(stripDeadBlobUrls(input)[0]).toBe(input[0]);
  });
});

describe("blob URLs across load and save", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [], groups: {} });
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("drops blob URLs from a loaded file", async () => {
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "Cars",
      nodes: [node("v", "videoStitch", { outputVideo: "blob:http://localhost:3000/f10c2a1e", status: "complete" })],
      edges: [],
      edgeStyle: "angular",
    });
    const data = useWorkflowStore.getState().nodes.find((n) => n.id === "v")!.data as { outputVideo: string | null };
    expect(data.outputVideo).toBeNull();
  });

  it("never writes a blob URL into the saved file, while keeping it live on the canvas", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);
    useWorkflowStore.setState({
      nodes: [node("v", "videoStitch", { outputVideo: "blob:http://localhost:3000/live", status: "complete" })],
      workflowId: "wf-1",
      workflowName: "Cars",
      saveDirectoryPath: "/projects/cars",
      useExternalImageStorage: false,
    });

    await expect(useWorkflowStore.getState().saveToFile()).resolves.toBe(true);

    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/workflow");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(JSON.stringify(body)).not.toContain("blob:");
    expect(body.workflow.nodes[0].data.outputVideo).toBeNull();
    // The canvas keeps the object URL: it still plays in this session
    const live = useWorkflowStore.getState().nodes.find((n) => n.id === "v")!.data as { outputVideo: string };
    expect(live.outputVideo).toBe("blob:http://localhost:3000/live");
  });
});
