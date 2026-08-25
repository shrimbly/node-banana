import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRestoreGate } from "@/components/WorkflowRestoreGate";

const mocks = vi.hoisted(() => ({
  clearLastWorkflowDirectory: vi.fn(),
  getLastWorkflowDirectory: vi.fn<() => string | null>(),
  loadWorkflow: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/store/utils/localStorage", () => ({
  clearLastWorkflowDirectory: mocks.clearLastWorkflowDirectory,
  getLastWorkflowDirectory: mocks.getLastWorkflowDirectory,
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (
    selector: (state: { loadWorkflow: typeof mocks.loadWorkflow }) => unknown
  ) => selector({ loadWorkflow: mocks.loadWorkflow }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({ show: mocks.showToast }),
  },
}));

const workflow = {
  version: 1,
  id: "wf_restore",
  name: "Restored workflow",
  nodes: [],
  edges: [],
  edgeStyle: "angular",
};

describe("WorkflowRestoreGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getLastWorkflowDirectory.mockReturnValue(null);
    mocks.loadWorkflow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the server render independent from localStorage", () => {
    mocks.getLastWorkflowDirectory.mockReturnValue("/projects/remembered");

    const html = renderToString(
      <WorkflowRestoreGate>
        <div>Canvas</div>
      </WorkflowRestoreGate>
    );

    expect(html).toContain("Opening last project");
    expect(html).not.toContain("Canvas");
    expect(mocks.getLastWorkflowDirectory).not.toHaveBeenCalled();
  });

  it("opens quickstart content immediately after mount when no path is stored", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkflowRestoreGate>
        <div>Canvas</div>
      </WorkflowRestoreGate>
    );

    expect(await screen.findByText("Canvas")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.loadWorkflow).not.toHaveBeenCalled();
  });

  it("keeps quickstart hidden until the remembered workflow is loaded", async () => {
    mocks.getLastWorkflowDirectory.mockReturnValue("/projects/remembered");
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    render(
      <WorkflowRestoreGate>
        <div>Canvas</div>
      </WorkflowRestoreGate>
    );

    expect(screen.getByRole("status")).toHaveTextContent("Opening last project");
    expect(screen.queryByText("Canvas")).not.toBeInTheDocument();

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ success: true, workflow }),
      });
    });

    await waitFor(() => {
      expect(mocks.loadWorkflow).toHaveBeenCalledWith(workflow, "/projects/remembered");
      expect(screen.getByText("Canvas")).toBeInTheDocument();
    });
    expect(mocks.clearLastWorkflowDirectory).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing directory",
      response: {
        ok: false,
        json: async () => ({ success: false, error: "Missing" }),
      },
    },
    {
      name: "corrupted workflow",
      response: {
        ok: true,
        json: async () => ({
          success: true,
          workflow: {
            ...workflow,
            nodes: [
              {
                id: "removed-node-1",
                type: "removedNodeType",
                position: { x: 0, y: 0 },
                data: {},
              },
            ],
          },
        }),
      },
    },
  ])("falls back to quickstart for a $name", async ({ response }) => {
    mocks.getLastWorkflowDirectory.mockReturnValue("/projects/stale");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    render(
      <WorkflowRestoreGate>
        <div>Canvas</div>
      </WorkflowRestoreGate>
    );

    expect(await screen.findByText("Canvas")).toBeInTheDocument();
    expect(mocks.loadWorkflow).not.toHaveBeenCalled();
    expect(mocks.clearLastWorkflowDirectory).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith(
      "Couldn’t reopen the last project. Choose a workflow to continue.",
      "warning"
    );
  });

  it("falls back to quickstart when the restore request fails", async () => {
    mocks.getLastWorkflowDirectory.mockReturnValue("/projects/offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unavailable")));

    render(
      <WorkflowRestoreGate>
        <div>Canvas</div>
      </WorkflowRestoreGate>
    );

    expect(await screen.findByText("Canvas")).toBeInTheDocument();
    expect(mocks.clearLastWorkflowDirectory).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });
});
