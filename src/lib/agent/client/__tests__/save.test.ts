import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const libraryStatus = vi.hoisted(() => vi.fn());
const folderName = vi.hoisted(() => vi.fn());
const requestSave = vi.hoisted(() => vi.fn());
const lastBaseDir = vi.hoisted(() => vi.fn());

vi.mock("@/lib/assets/client/recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/recorder")>()),
  getRecorderLibraryStatus: libraryStatus,
}));
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  fetchProjectFolderName: folderName,
}));
vi.mock("@/store/saveRequestStore", () => ({ requestSave }));
vi.mock("@/store/utils/localStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/utils/localStorage")>()),
  getLastProjectBaseDir: lastBaseDir,
}));

import { useToast } from "@/components/Toast";
import { useWorkflowStore } from "@/store/workflowStore";
import { ensureProjectSubfolderPath, saveLiveWorkflow } from "../save";

describe("saveLiveWorkflow", () => {
  const saveToFile = vi.fn(async () => true);
  const original = useWorkflowStore.getState().saveToFile;

  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow();
    useWorkflowStore.setState({ saveToFile, workflowId: null, workflowName: null, saveDirectoryPath: null, generationsPath: null });
    saveToFile.mockClear();
    saveToFile.mockResolvedValue(true);
    libraryStatus.mockReset();
    folderName.mockReset();
    requestSave.mockReset();
    lastBaseDir.mockReset();
    lastBaseDir.mockReturnValue(null);
    useToast.getState().hide();
  });

  afterEach(() => {
    useWorkflowStore.setState({ saveToFile: original });
    vi.unstubAllGlobals();
  });

  it("saves a workflow that already has a folder into it, under its own name", async () => {
    useWorkflowStore.setState({ workflowId: "wf-1", workflowName: "Fox", saveDirectoryPath: "/work/Fox" });
    await expect(saveLiveWorkflow("Ignored")).resolves.toEqual({ ok: true, name: "Fox", path: "/work/Fox" });
    expect(saveToFile).toHaveBeenCalledWith({ reason: "manual" });
    expect(folderName).not.toHaveBeenCalled();
  });

  it("gives a first save a project folder in the Node Banana folder, keeping the canvas's id", async () => {
    libraryStatus.mockReturnValue({ available: true, root: "/Users/me/Documents/Node Banana" });
    folderName.mockResolvedValue({ folder: "Fox 2", path: "/Users/me/Documents/Node Banana/Fox 2", taken: true });
    useWorkflowStore.setState({ workflowId: "wf-canvas" });

    await expect(saveLiveWorkflow("  Fox ")).resolves.toEqual({ ok: true, name: "Fox", path: "/Users/me/Documents/Node Banana/Fox 2" });
    expect(folderName).toHaveBeenCalledWith("Fox");
    const state = useWorkflowStore.getState();
    expect(state).toMatchObject({
      workflowId: "wf-canvas",
      workflowName: "Fox",
      saveDirectoryPath: "/Users/me/Documents/Node Banana/Fox 2",
      generationsPath: "/Users/me/Documents/Node Banana/Fox 2/generations",
    });
    expect(saveToFile).toHaveBeenCalledWith({ reason: "manual" });
  });

  it("names a first save after the workflow when no name is given, minting an id when it has none", async () => {
    libraryStatus.mockReturnValue({ available: true, root: "/lib" });
    folderName.mockResolvedValue({ folder: "Owl", path: "/lib/Owl", taken: false });
    useWorkflowStore.setState({ workflowName: "Owl" });
    await expect(saveLiveWorkflow()).resolves.toMatchObject({ ok: true, name: "Owl" });
    expect(useWorkflowStore.getState().workflowId).toMatch(/^wf_/);
  });

  it("refuses a first save with no name at all", async () => {
    await expect(saveLiveWorkflow()).resolves.toEqual({ ok: false, reason: "The workflow needs a name before it can be saved" });
    expect(saveToFile).not.toHaveBeenCalled();
  });

  it("falls back to the last project folder without a library, past folders holding another workflow", async () => {
    libraryStatus.mockReturnValue({ available: false, root: null });
    lastBaseDir.mockReturnValue("/work/projects");
    const answers: Record<string, unknown> = {
      "/work/projects/Fox": { success: true, workflow: { id: "someone-else" } },
      "/work/projects/Fox 2": { success: true, exists: false, isDirectory: false },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
      return new Response(JSON.stringify(answers[path] ?? { success: false }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveLiveWorkflow("Fox")).resolves.toEqual({ ok: true, name: "Fox", path: "/work/projects/Fox 2" });
    expect(folderName).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useWorkflowStore.getState().saveDirectoryPath).toBe("/work/projects/Fox 2");
  });

  it("opens the user's save dialog when there is no folder to save in", async () => {
    libraryStatus.mockReturnValue(null);
    await expect(saveLiveWorkflow("Fox")).resolves.toEqual({
      ok: false,
      reason: "Choose where to save Fox: there is no default folder",
    });
    expect(requestSave).toHaveBeenCalledTimes(1);
    expect(saveToFile).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().saveDirectoryPath).toBeNull();
  });

  it("passes on why the save failed", async () => {
    useWorkflowStore.setState({ workflowId: "wf-1", workflowName: "Fox", saveDirectoryPath: "/work/Fox" });
    saveToFile.mockImplementationOnce(async () => {
      useToast.getState().show("Couldn't save: disk full", "error");
      return false;
    });
    await expect(saveLiveWorkflow()).resolves.toEqual({ ok: false, reason: "Couldn't save: disk full" });
  });
});

describe("ensureProjectSubfolderPath", () => {
  it("adds the project's folder unless the base already is it", () => {
    expect(ensureProjectSubfolderPath("/work/projects", "Fox: the sequel")).toBe("/work/projects/Fox_ the sequel");
    expect(ensureProjectSubfolderPath("/work/projects/", "Fox")).toBe("/work/projects/Fox");
    expect(ensureProjectSubfolderPath("/work/fox", "Fox")).toBe("/work/fox");
    expect(ensureProjectSubfolderPath("C:\\Users\\me", "Fox")).toBe("C:\\Users\\me\\Fox");
  });
});
