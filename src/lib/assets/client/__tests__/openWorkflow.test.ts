import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowFile } from "@/store/workflowStore";
import { stripDeadBlobUrls } from "@/store/utils/executionUtils";
import type { WorkflowNode } from "@/types";
import type { AssetView, AssetWorkflowResult, SnapshotWorkflow } from "../../types";
import { assetView, blobResponse, fakeMediaServer, jsonResponse, libraryStatus, sha256Of, type FetchCall } from "./helpers";

interface FakeState {
  tabs: { id: string; snapshot: { workflowId: string | null; saveDirectoryPath: string | null; nodes: WorkflowNode[] } | null }[];
  activeTabId: string;
  workflowId: string | null;
  saveDirectoryPath: string | null;
  nodes: WorkflowNode[];
  busy: string | null;
  tabsBusyReason: () => string | null;
  switchTab: (id: string) => boolean;
  openWorkflowInNewTab: (workflow: WorkflowFile, path?: string) => Promise<void>;
  setNavigationTarget: (nodeId: string | null) => void;
}

/** Just enough of the workflow store: tabs park the live fields, loads go through the real blob stripping. */
const store = vi.hoisted(() => {
  let state = {} as FakeState;
  return {
    getState: () => state,
    setState: (partial: Partial<FakeState>) => {
      state = { ...state, ...partial };
    },
    replace: (next: FakeState) => {
      state = next;
    },
  };
});
vi.mock("@/store/workflowStore", () => ({ useWorkflowStore: store }));

let tabCounter = 0;

function freshState(): FakeState {
  const live = () => {
    const state = store.getState();
    return { workflowId: state.workflowId, saveDirectoryPath: state.saveDirectoryPath, nodes: state.nodes };
  };
  return {
    tabs: [{ id: "tab-1", snapshot: null }],
    activeTabId: "tab-1",
    workflowId: "wf_live",
    saveDirectoryPath: null,
    nodes: [{ id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "hi" } } as unknown as WorkflowNode],
    busy: null,
    tabsBusyReason: () => store.getState().busy,
    switchTab: vi.fn((id: string) => {
      const state = store.getState();
      const target = state.tabs.find((tab) => tab.id === id);
      if (!target?.snapshot || state.busy) return false;
      const parked = live();
      store.setState({
        tabs: state.tabs.map((tab) => (tab.id === state.activeTabId ? { ...tab, snapshot: parked } : tab.id === id ? { ...tab, snapshot: null } : tab)),
        activeTabId: id,
        ...target.snapshot,
      });
      return true;
    }),
    openWorkflowInNewTab: vi.fn(async (workflow: WorkflowFile, path?: string) => {
      const state = store.getState();
      if (state.busy) return;
      const id = `tab-new-${++tabCounter}`;
      store.setState({
        tabs: [...state.tabs.map((tab) => (tab.id === state.activeTabId ? { ...tab, snapshot: live() } : tab)), { id, snapshot: null }],
        activeTabId: id,
        workflowId: workflow.id ?? null,
        saveDirectoryPath: path ?? null,
        nodes: stripDeadBlobUrls(workflow.nodes),
      });
    }),
    setNavigationTarget: vi.fn(),
  };
}

type OpenModule = typeof import("../openWorkflow");
let open: OpenModule;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  tabCounter = 0;
  store.replace(freshState());
  open = await import("../openWorkflow");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ASSET_BYTES = "NEWIMAGE";
const OLD_OUTPUT = "OLDIMAGE";

function asset(overrides: Partial<AssetView> = {}): AssetView {
  return assetView({ id: "a-cat", runId: "r-run-1", producer: { nodeId: "nanoBanana-1", nodeType: "nanoBanana" }, ...overrides });
}

async function snapshotFixture(extraNodes: unknown[] = []): Promise<SnapshotWorkflow> {
  return {
    version: 1,
    id: "wf_1_cats",
    name: "Cats",
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "a cat" } },
      {
        id: "nanoBanana-1",
        type: "nanoBanana",
        position: { x: 300, y: 0 },
        data: {
          status: "loading",
          outputImage: { $nbMedia: await sha256Of(OLD_OUTPUT), mime: "image/png" },
          imageHistory: [{ id: "1", assetId: "a-cat" }],
          selectedHistoryIndex: 4,
        },
      },
      ...extraNodes,
    ],
    edges: [],
    edgeStyle: "curved",
  };
}

/** The workflow, file and media routes for `assets`, over the in-memory media store. */
async function fakeServer(
  options: {
    workflow?: SnapshotWorkflow | null;
    files?: Record<string, Blob>;
    assets?: AssetView[];
    route?: (call: FetchCall) => Response | undefined;
  } = {},
) {
  const workflow = options.workflow === undefined ? await snapshotFixture() : options.workflow;
  const server = fakeMediaServer((call) => {
    const answered = options.route?.(call);
    if (answered) return answered;
    const workflowRoute = /^\/api\/assets\/([^/]+)\/workflow$/.exec(call.url);
    if (workflowRoute) {
      if (!workflow) return jsonResponse({ error: "No snapshot" }, { status: 404 });
      const result: AssetWorkflowResult = {
        asset: options.assets?.find((candidate) => candidate.id === workflowRoute[1]) ?? asset({ id: workflowRoute[1] }),
        run: { id: "r-run-1", workflowId: "wf_1_cats", workflowName: "Cats", projectPath: null, startedAt: 1, updatedAt: 2 },
        which: "final",
        workflow,
      };
      return jsonResponse(result);
    }
    const fileRoute = /^\/api\/assets\/([^/]+)\/file$/.exec(call.url);
    if (fileRoute) {
      const blob = options.files?.[fileRoute[1]] ?? new Blob([ASSET_BYTES], { type: "image/png" });
      return blobResponse(blob);
    }
    return undefined;
  });
  server.media.set(await sha256Of(OLD_OUTPUT), new Blob([OLD_OUTPUT], { type: "image/png" }));
  return server;
}

function liveData(nodeId: string): Record<string, unknown> {
  return store.getState().nodes.find((node) => node.id === nodeId)!.data as unknown as Record<string, unknown>;
}

describe("openWorkflowBlockedReason", () => {
  it("gives the tabs' busy reason first", () => {
    store.setState({ busy: "Wait for the run to finish" });
    expect(open.openWorkflowBlockedReason(asset(), "snapshot")).toBe("Wait for the run to finish");
  });

  it("explains an imported asset and one outside a project", () => {
    expect(open.openWorkflowBlockedReason(asset({ imported: true }), "snapshot")).toBe(
      "This asset was imported, so there is no snapshot of its workflow.",
    );
    expect(open.openWorkflowBlockedReason(asset(), "project")).toBe("This asset isn't in a project.");
    expect(open.openWorkflowBlockedReason(asset(), "snapshot")).toBeNull();
    expect(open.openWorkflowBlockedReason(asset({ workflow: { id: "wf", name: null, projectPath: "/p" } }), "project")).toBeNull();
  });
});

describe("openAssetWorkflow: snapshot", () => {
  it("refuses while the tabs are busy, without asking the server", async () => {
    const server = await fakeServer();
    store.setState({ busy: "Wait for the save to finish" });
    await expect(open.openAssetWorkflow(asset(), "snapshot")).resolves.toEqual({ ok: false, reason: "Wait for the save to finish" });
    expect(server.calls).toHaveLength(0);
  });

  it("asks before opening the copy while the agent works, and opens nothing when the user keeps it working", async () => {
    await fakeServer();
    const guard = await import("@/lib/agent/client/stopGuard");
    const stopTurn = vi.fn();
    guard.setAgentTurnStop(stopTurn);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await expect(open.openAssetWorkflow(asset(), "snapshot")).resolves.toEqual({
        ok: false,
        reason: "The agent is still working",
        kept: true,
      });
      expect(confirm).toHaveBeenCalledWith("The agent is still working. Opening another workflow will stop it.");
      expect(stopTurn).not.toHaveBeenCalled();
      expect(store.getState().openWorkflowInNewTab).not.toHaveBeenCalled();
    } finally {
      guard.setAgentTurnStop(null);
    }
  });

  it("opens a prepared copy in a new tab with the asset in its node, and centres on it", async () => {
    await fakeServer();
    const result = await open.openAssetWorkflow(asset(), "snapshot");

    expect(result).toEqual({ ok: true, tabId: "tab-new-1", nodeId: "nanoBanana-1" });
    const state = store.getState();
    expect(state.openWorkflowInNewTab).toHaveBeenCalledTimes(1);
    const [file, path] = vi.mocked(state.openWorkflowInNewTab).mock.calls[0];
    expect(path).toBeUndefined();
    expect(file.id).toMatch(/^wf_/);
    expect(file.id).not.toBe("wf_1_cats");
    expect(file).not.toHaveProperty("directoryPath");
    expect(file.name).toMatch(/^Cats \(.+ \d\d:\d\d\)$/);

    expect(state.workflowId).toBe(file.id);
    expect(liveData("nanoBanana-1")).toMatchObject({
      outputImage: `data:image/png;base64,${btoa(ASSET_BYTES)}`,
      status: "complete",
      selectedHistoryIndex: 0,
    });
    expect(state.setNavigationTarget).toHaveBeenCalledWith("nanoBanana-1");
  });

  it("opens a split cell's workflow with the source node's own output, centred on it", async () => {
    const cell = asset({ id: "a-cell", producer: { nodeId: "nanoBanana-1", nodeType: "nanoBanana", operation: "splitToNodes", batchIndex: 2 } });
    const server = await fakeServer({ assets: [cell] });
    const result = await open.openAssetWorkflow(cell, "snapshot");

    expect(result).toEqual({ ok: true, tabId: "tab-new-1", nodeId: "nanoBanana-1" });
    expect(liveData("nanoBanana-1")).toMatchObject({
      outputImage: `data:image/png;base64,${btoa(OLD_OUTPUT)}`,
      status: "idle",
      selectedHistoryIndex: 4,
    });
    // The cell's own bytes are not needed.
    expect(server.calls.some((call) => call.url.endsWith("/file"))).toBe(false);
  });

  it("goes back to the copy it opened for the same run instead of opening another", async () => {
    const server = await fakeServer();
    const first = await open.openAssetWorkflow(asset(), "snapshot");
    expect(first.ok).toBe(true);
    // The user goes back to their own workflow.
    store.getState().switchTab("tab-1");
    expect(store.getState().workflowId).toBe("wf_live");

    const second = await open.openAssetWorkflow(asset({ id: "a-other" }), "snapshot");
    expect(second).toEqual({ ok: true, tabId: "tab-new-1", nodeId: "nanoBanana-1" });
    expect(store.getState().openWorkflowInNewTab).toHaveBeenCalledTimes(1);
    expect(server.calls.filter((call) => call.url.endsWith("/workflow"))).toHaveLength(1);

    // Already showing: nothing to switch.
    const third = await open.openAssetWorkflow(asset(), "snapshot");
    expect(third).toMatchObject({ ok: true, tabId: "tab-new-1" });
  });

  it("still finds the copy after a restart restored the tabs", async () => {
    const server = await fakeServer();
    const first = await open.openAssetWorkflow(asset(), "snapshot");
    expect(first).toMatchObject({ ok: true, tabId: "tab-new-1" });
    store.getState().switchTab("tab-1");

    // The desktop app restarts and restores its tabs; this module starts afresh.
    vi.resetModules();
    open = await import("../openWorkflow");
    const again = await open.openAssetWorkflow(asset(), "snapshot");
    expect(again).toEqual({ ok: true, tabId: "tab-new-1", nodeId: "nanoBanana-1" });
    expect(store.getState().openWorkflowInNewTab).toHaveBeenCalledTimes(1);
    expect(server.calls.filter((call) => call.url.endsWith("/workflow"))).toHaveLength(1);
  });

  it("opens a fresh copy once the earlier one was saved to a folder", async () => {
    await fakeServer();
    await open.openAssetWorkflow(asset(), "snapshot");
    // Saved as a project: it keeps its id but is the user's own workflow now.
    store.setState({ saveDirectoryPath: "/Users/test/Projects/Cats v2" });
    store.getState().switchTab("tab-1");

    const again = await open.openAssetWorkflow(asset(), "snapshot");
    expect(again).toMatchObject({ ok: true, tabId: "tab-new-2" });
    expect(store.getState().openWorkflowInNewTab).toHaveBeenCalledTimes(2);
  });

  it("opens a new copy once the earlier one was closed", async () => {
    await fakeServer();
    await open.openAssetWorkflow(asset(), "snapshot");
    store.getState().switchTab("tab-1");
    store.setState({ tabs: store.getState().tabs.filter((tab) => tab.id !== "tab-new-1") });

    const again = await open.openAssetWorkflow(asset(), "snapshot");
    expect(again).toMatchObject({ ok: true, tabId: "tab-new-2" });
  });

  it("shares one open between two quick clicks", async () => {
    const server = await fakeServer();
    const [a, b] = await Promise.all([open.openAssetWorkflow(asset(), "snapshot"), open.openAssetWorkflow(asset(), "snapshot")]);
    expect(a).toMatchObject({ ok: true, tabId: "tab-new-1" });
    expect(b).toMatchObject({ ok: true, tabId: "tab-new-1" });
    expect(store.getState().openWorkflowInNewTab).toHaveBeenCalledTimes(1);
    expect(server.calls.filter((call) => call.url.endsWith("/workflow"))).toHaveLength(1);
  });

  it("centres only on a node the copy has", async () => {
    await fakeServer();
    const result = await open.openAssetWorkflow(asset({ producer: { nodeId: "nanoBanana-7", nodeType: "nanoBanana" } }), "snapshot");
    expect(result).toMatchObject({ ok: true, nodeId: null });
    expect(store.getState().setNavigationTarget).not.toHaveBeenCalled();
  });

  it("explains a missing snapshot", async () => {
    await fakeServer({ workflow: null });
    await expect(open.openAssetWorkflow(asset(), "snapshot")).resolves.toEqual({
      ok: false,
      reason: "There's no snapshot of this asset's workflow.",
    });
  });

  it("never throws: a failed request becomes a reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(open.openAssetWorkflow(asset(), "snapshot")).resolves.toEqual({ ok: false, reason: "Couldn't reach the asset library." });
  });

  it("reports a load the store refused, and frees the blob: URLs it made", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:http://localhost/model"), revokeObjectURL }));
    await fakeServer({ files: { "a-3d": new Blob(["glTF"], { type: "model/gltf-binary" }) } });
    vi.mocked(store.getState().openWorkflowInNewTab).mockImplementationOnce(async () => {
      store.setState({ busy: "Wait for the media to finish saving" });
    });
    const result = await open.openAssetWorkflow(
      asset({ id: "a-3d", kind: "3d", producer: { nodeId: "generate3d-1", nodeType: "generate3d" } }),
      "snapshot",
    );
    expect(result).toEqual({ ok: false, reason: "Wait for the media to finish saving" });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/model");
  });

  it("keeps fresh blob: URLs (3D, large videos) through the store's load, which drops blob: URLs from files", async () => {
    let made = 0;
    const createObjectURL = vi.fn(() => `blob:http://localhost/${++made}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const bigVideo = new Uint8Array(20 * 1024 * 1024 + 1);
    const bigSha = await sha256Of(bigVideo);
    const model = asset({ id: "a-3d", kind: "3d", mime: "model/gltf-binary", producer: { nodeId: "generate3d-1", nodeType: "generate3d" } });
    const server = await fakeServer({
      workflow: await snapshotFixture([
        { id: "generate3d-1", type: "generate3d", position: { x: 0, y: 300 }, data: { output3dUrl: null } },
        {
          id: "outputGallery-1",
          type: "outputGallery",
          position: { x: 0, y: 600 },
          data: { images: ["x"], videos: ["https://cdn.example.com/a.mp4", { $nbMedia: bigSha, mime: "video/mp4" }, "tail"] },
        },
      ]),
      files: { "a-3d": new Blob(["glTF"], { type: "model/gltf-binary" }) },
      assets: [model],
    });
    server.media.set(bigSha, new Blob([bigVideo as BlobPart], { type: "video/mp4" }));

    const result = await open.openAssetWorkflow(model, "snapshot");
    expect(result).toMatchObject({ ok: true, nodeId: "generate3d-1" });
    const urls = createObjectURL.mock.results.map((entry) => entry.value as string);
    expect(urls).toHaveLength(2);
    expect(urls).toContain(liveData("generate3d-1").output3dUrl);
    expect(liveData("outputGallery-1").videos).toEqual(["https://cdn.example.com/a.mp4", expect.stringMatching(/^blob:/), "tail"]);
    expect(liveData("outputGallery-1").images).toEqual(["x"]);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("openAssetWorkflow: project", () => {
  const PROJECT = "/Users/test/Projects/Cats";
  const projectAsset = (overrides: Partial<AssetView> = {}) =>
    asset({ workflow: { id: "wf_1_cats", name: "Cats", projectPath: PROJECT }, filename: "a_cat_0123abcd.png", ...overrides });

  function projectWorkflow(nodes: unknown[] = []): WorkflowFile {
    return { version: 1, id: "wf_1_cats", name: "Cats", nodes: nodes as WorkflowFile["nodes"], edges: [], edgeStyle: "curved" };
  }

  function projectServer(workflow: WorkflowFile | { error: string }) {
    return fakeMediaServer((call) =>
      call.url.startsWith("/api/workflow?")
        ? "error" in workflow
          ? jsonResponse({ success: false, error: workflow.error }, { status: 400 })
          : jsonResponse({ success: true, workflow, filename: "Cats.json" })
        : undefined,
    );
  }

  it("switches to a tab bound to that project, however the path is spelled", async () => {
    const { applyLibraryStatus } = await import("../recorder");
    applyLibraryStatus(libraryStatus({ platform: "darwin" }));
    const server = projectServer(projectWorkflow());
    store.setState({
      tabs: [
        { id: "tab-1", snapshot: null },
        { id: "tab-cats", snapshot: { workflowId: "wf_1_cats", saveDirectoryPath: "/users/test/projects/cats/", nodes: [] } },
      ],
    });
    await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toEqual({ ok: true, tabId: "tab-cats", nodeId: null });
    expect(store.getState().switchTab).toHaveBeenCalledWith("tab-cats");
    expect(server.calls).toHaveLength(0);
  });

  it("stops the agent before switching to the project's tab once the user agrees", async () => {
    const { applyLibraryStatus } = await import("../recorder");
    applyLibraryStatus(libraryStatus({ platform: "darwin" }));
    projectServer(projectWorkflow());
    store.setState({
      tabs: [
        { id: "tab-1", snapshot: null },
        { id: "tab-cats", snapshot: { workflowId: "wf_1_cats", saveDirectoryPath: PROJECT, nodes: [] } },
      ],
    });
    const guard = await import("@/lib/agent/client/stopGuard");
    const stopTurn = vi.fn();
    guard.setAgentTurnStop(stopTurn);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toEqual({ ok: true, tabId: "tab-cats", nodeId: null });
      expect(stopTurn).toHaveBeenCalledTimes(1);
      expect(store.getState().switchTab).toHaveBeenCalledWith("tab-cats");
    } finally {
      guard.setAgentTurnStop(null);
    }
  });

  it("compares paths exactly where the file system does", async () => {
    const { applyLibraryStatus } = await import("../recorder");
    applyLibraryStatus(libraryStatus({ platform: "linux" }));
    projectServer(projectWorkflow());
    store.setState({
      tabs: [
        { id: "tab-1", snapshot: null },
        { id: "tab-cats", snapshot: { workflowId: "wf_1_cats", saveDirectoryPath: "/users/test/projects/cats", nodes: [] } },
      ],
    });
    await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toMatchObject({ ok: true, tabId: "tab-new-1" });
  });

  it("loads the project's workflow bound to its folder and centres on the node showing the asset", async () => {
    const server = projectServer(
      projectWorkflow([
        { id: "nanoBanana-1", type: "nanoBanana", position: { x: 0, y: 0 }, data: { imageHistory: [{ id: "a_cat_0123abcd" }] } },
      ]),
    );
    const result = await open.openAssetWorkflow(projectAsset(), "project");
    expect(result).toEqual({ ok: true, tabId: "tab-new-1", nodeId: "nanoBanana-1" });
    expect(server.calls[0].url).toBe(`/api/workflow?path=${encodeURIComponent(PROJECT)}&load=true`);
    expect(vi.mocked(store.getState().openWorkflowInNewTab).mock.calls[0][1]).toBe(PROJECT);
    expect(store.getState().saveDirectoryPath).toBe(PROJECT);
    expect(store.getState().setNavigationTarget).toHaveBeenCalledWith("nanoBanana-1");
  });

  it("does not centre on a node whose carousel no longer has the asset", async () => {
    projectServer(
      projectWorkflow([{ id: "nanoBanana-1", type: "nanoBanana", position: { x: 0, y: 0 }, data: { imageHistory: [{ id: "someone_else" }] } }]),
    );
    await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toMatchObject({ ok: true, nodeId: null });
    expect(store.getState().setNavigationTarget).not.toHaveBeenCalled();
  });

  it("switches to the folder's workflow when it is open under its own id", async () => {
    const server = projectServer({ ...projectWorkflow(), id: "wf_2_renamed" });
    store.setState({
      tabs: [
        { id: "tab-1", snapshot: null },
        { id: "tab-renamed", snapshot: { workflowId: "wf_2_renamed", saveDirectoryPath: PROJECT, nodes: [] } },
      ],
    });
    await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toMatchObject({ ok: true, tabId: "tab-renamed" });
    expect(server.calls).toHaveLength(1);
    expect(store.getState().openWorkflowInNewTab).not.toHaveBeenCalled();
  });

  it("passes on why the folder could not be loaded", async () => {
    projectServer({ error: "Directory does not exist" });
    await expect(open.openAssetWorkflow(projectAsset(), "project")).resolves.toEqual({ ok: false, reason: "Directory does not exist" });
  });

  it("refuses an asset outside a project", async () => {
    await expect(open.openAssetWorkflow(asset(), "project")).resolves.toEqual({ ok: false, reason: "This asset isn't in a project." });
  });
});
