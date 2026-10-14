import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HandleLabel } from "../HandleLabel";
import { PaintedNodes } from "../paintMode";
import { setConnectDrag } from "@/store/connectDragStore";

let connectionInProgress = false;
let edges: Array<{ id: string; source: string; target: string; data?: { hidden?: boolean } }> = [];

vi.mock("@xyflow/react", () => ({
  useNodeId: () => "node-1",
  useConnection: (selector?: (c: { inProgress: boolean }) => unknown) => {
    const connection = { inProgress: connectionInProgress };
    return selector ? selector(connection) : connection;
  },
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: { edges: typeof edges }) => unknown) => selector({ edges }),
}));

const hiddenInto = (target: string) => ({ id: `into-${target}`, source: "x", target, data: { hidden: true } });

describe("HandleLabel", () => {
  beforeEach(() => {
    connectionInProgress = false;
    edges = [];
    setConnectDrag(false);
  });

  it("shows when asked and nothing is hidden nearby", () => {
    render(<HandleLabel label="Image" side="target" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("1");
  });

  it("stays hidden when not asked to show", () => {
    render(<HandleLabel label="Image" side="target" color="red" visible={false} />);
    expect(screen.getByText("Image").style.opacity).toBe("0");
  });

  it("steps aside for hidden stubs on its own side", () => {
    edges = [hiddenInto("node-1")];
    render(<HandleLabel label="Image" side="target" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("0");
  });

  it("ignores hidden stubs on the other side of the node", () => {
    edges = [hiddenInto("node-1")];
    render(<HandleLabel label="Image" side="source" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("1");
  });

  it("ignores hidden stubs on other nodes", () => {
    edges = [hiddenInto("node-2")];
    render(<HandleLabel label="Image" side="target" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("1");
  });

  it("comes back while a noodle is being dragged", () => {
    edges = [hiddenInto("node-1")];
    connectionInProgress = true;
    render(<HandleLabel label="Image" side="target" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("1");
  });

  it("comes back while the GPU canvas draws a connection", () => {
    edges = [hiddenInto("node-1")];
    setConnectDrag(true);
    render(<HandleLabel label="Image" side="target" color="red" visible />);
    expect(screen.getByText("Image").style.opacity).toBe("1");
  });

  it("keeps a painted copy as it is at rest during a GPU connection", () => {
    edges = [hiddenInto("node-1")];
    setConnectDrag(true);
    render(<PaintedNodes><HandleLabel label="Image" side="target" color="red" visible /></PaintedNodes>);
    expect(screen.getByText("Image").style.opacity).toBe("0");
  });
});
