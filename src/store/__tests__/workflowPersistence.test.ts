import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore, type WorkflowFile } from "../workflowStore";
import { externalizeWorkflowMedia, hydrateWorkflowMedia } from "@/utils/mediaStorage";
import type { WorkflowNode } from "@/types";

vi.mock("@/utils/mediaStorage", () => ({
  externalizeWorkflowMedia: vi.fn(async (workflow) => workflow),
  hydrateWorkflowMedia: vi.fn(async (workflow) => workflow),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const node = (id: string, data: Record<string, unknown>, type = "imageInput"): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const store = () => useWorkflowStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalizeWorkflowMedia).mockImplementation(async (workflow) => workflow);
  vi.mocked(hydrateWorkflowMedia).mockImplementation(async (workflow) => workflow);
  store().clearWorkflow();
  useWorkflowStore.setState({
    tabs: [{ id: store().activeTabId, snapshot: null }],
    isSaving: false,
    pendingMediaSaves: 0,
    workflowId: "original-id",
    workflowName: "Original",
    saveDirectoryPath: "/project",
    useExternalImageStorage: true,
    imageRefBasePath: "/project",
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ success: true }) }));
});

afterEach(() => {
  store().clearWorkflow();
  vi.unstubAllGlobals();
});

describe("save media snapshots", () => {
  it.each([
    ["imageInput", "image", "imageRef", "data:image/png;base64,old", "data:image/png;base64,new", "old-image"],
    ["audioInput", "audioFile", "audioFileRef", "data:audio/wav;base64,old", "data:audio/wav;base64,new", "old-audio"],
    ["videoInput", "video", "videoRef", "data:video/mp4;base64,old", "data:video/mp4;base64,new", "old-video"],
    ["outputGallery", "images", "imageRefs", ["old"], ["new"], ["old-ref"]],
  ])("does not attach stale %s refs to media replaced during a save", async (type, field, refField, oldMedia, newMedia, oldRef) => {
    const pending = deferred<WorkflowFile>();
    const original = node("media-1", { [field as string]: oldMedia }, type as string);
    useWorkflowStore.setState({ nodes: [original] });
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);

    const saving = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());
    store().updateNodeData(original.id, { [field as string]: newMedia });
    pending.resolve({
      ...vi.mocked(externalizeWorkflowMedia).mock.calls[0][0],
      nodes: [node(original.id, { [field as string]: null, [refField as string]: oldRef }, type as string)],
    });
    expect(await saving).toBe(true);
    expect(store().nodes[0].data[field as string]).toEqual(newMedia);
    expect(store().nodes[0].data[refField as string]).toBeUndefined();
    expect(store().hasUnsavedChanges).toBe(true);

    await store().saveToFile();
    const nextSave = vi.mocked(externalizeWorkflowMedia).mock.calls[1][0];
    expect(nextSave.nodes[0].data[field as string]).toEqual(newMedia);
    expect(nextSave.nodes[0].data[refField as string]).toBeUndefined();
  });

  it("still reuses saved refs when an unrelated field changes", async () => {
    const pending = deferred<WorkflowFile>();
    useWorkflowStore.setState({ nodes: [node("media-1", { image: "original" })] });
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);
    const saving = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());
    store().updateNodeData("media-1", { label: "Renamed" });
    pending.resolve({
      ...vi.mocked(externalizeWorkflowMedia).mock.calls[0][0],
      nodes: [node("media-1", { image: null, imageRef: "saved-image" })],
    });
    await saving;
    expect(store().nodes[0].data).toMatchObject({ image: "original", imageRef: "saved-image", label: "Renamed" });
    expect(store().hasUnsavedChanges).toBe(true);
  });
});

describe("workflow replacement during persistence", () => {
  const file = (name: string): WorkflowFile => ({
    version: 1, name, nodes: [node(`${name}-node`, { image: name })], edges: [], edgeStyle: "angular",
  });

  it("does not replace a different tab when slow media hydration finishes", async () => {
    useWorkflowStore.setState({ nodes: [node("keep-me", { image: "unsaved" })], hasUnsavedChanges: true });
    const originalTab = store().activeTabId;
    store().newTab();
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const loading = store().loadWorkflow(file("Slow"), "/slow");

    expect(store().switchTab(originalTab)).toBe(true);
    pending.resolve(file("Slow"));
    await loading;
    expect(store().nodes[0].id).toBe("keep-me");
    expect(store().hasUnsavedChanges).toBe(true);
  });

  it("keeps the newest load when hydration resolves out of order", async () => {
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const oldLoad = store().loadWorkflow(file("Old"), "/old");
    await store().loadWorkflow(file("New"), "/new");
    pending.resolve(file("Old"));
    await oldLoad;
    expect(store().workflowName).toBe("New");
    expect(store().nodes[0].id).toBe("New-node");
  });

  it("does not resurrect a workflow cleared during hydration", async () => {
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const loading = store().loadWorkflow(file("Old"), "/old");
    store().clearWorkflow();
    pending.resolve(file("Old"));
    await loading;
    expect(store().nodes).toEqual([]);
    expect(store().workflowName).toBeNull();
  });

  it("never merges a completed save's refs or metadata into a replacement graph", async () => {
    const pending = deferred<{ json: () => Promise<{ success: boolean }> }>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise as Promise<Response>);
    useWorkflowStore.setState({ nodes: [node("same-id", { image: "old" })] });
    const saving = store().saveToFile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await store().loadWorkflow(file("Replacement"), "/replacement");
    pending.resolve({ json: async () => ({ success: true }) });
    expect(await saving).toBe(false);
    expect(store().workflowName).toBe("Replacement");
    expect(store().imageRefBasePath).toBe("/replacement");
    expect(store().lastSavedAt).toBeNull();
  });

  it("refuses an overlapping save or Save As without changing workflow identity", async () => {
    const pending = deferred<WorkflowFile>();
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);
    const saving = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());
    expect(await store().saveToFile()).toBe(false);
    expect(await store().saveAsFile("Different")).toBe(false);
    expect(store().workflowName).toBe("Original");
    pending.resolve(vi.mocked(externalizeWorkflowMedia).mock.calls[0][0]);
    expect(await saving).toBe(true);
  });
});
