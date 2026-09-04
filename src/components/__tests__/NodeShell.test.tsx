import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { NodeShell } from "@/components/nodes/NodeShell";
import { GAP_ROW_H, socketMinHeight } from "@/components/nodes/ui/tokens";

const mockSetHoveredNodeId = vi.fn();
const mockUseWorkflowStore = vi.fn();
let storeState: Record<string, unknown>;

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) => mockUseWorkflowStore(selector),
}));

vi.mock("@/components/WorkflowCanvas", () => ({
  isPanningRef: { current: false },
  isDraggingNodeRef: { current: false },
}));

const mockGetNodes = vi.fn(() => [] as unknown[]);
const mockSetNodes = vi.fn();
const mockUpdateNodeInternals = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({ getNodes: mockGetNodes, setNodes: mockSetNodes }),
    useUpdateNodeInternals: () => mockUpdateNodeInternals,
    useNodeConnections: () => [],
    NodeResizeControl: (props: { position: string }) => <div data-testid={`resize-${props.position}`} className="react-flow__resize-control" />,
  };
});

function Wrap({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

const card = (container: HTMLElement) => container.querySelector("[data-media-card]") as HTMLElement;
const clip = (container: HTMLElement) => container.querySelector("[data-media-clip]") as HTMLElement;

describe("NodeShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = {
      currentNodeIds: [] as string[],
      setHoveredNodeId: mockSetHoveredNodeId,
      nodes: [{ id: "n1", type: "nanoBanana" }],
    };
    mockUseWorkflowStore.mockImplementation((selector) => selector(storeState));
    mockGetNodes.mockReturnValue([{ id: "n1", type: "nanoBanana", selected: true }]);
  });

  it("puts children in a clip sized by the media aspect", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "aspect", aspect: 16 / 9 }}>
          <span>media</span>
        </NodeShell>
      </Wrap>
    );
    expect(screen.getByText("media")).toBeInTheDocument();
    expect(clip(container).style.aspectRatio).toBe(String(16 / 9));
    expect(clip(container).className).toContain("overflow-hidden");
    expect(container.querySelector("[data-gap-row]")).toBeNull();
  });

  it("uses a fixed height when asked, and treats a bad aspect as square", () => {
    const { container, rerender } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 160 }} />
      </Wrap>
    );
    expect(clip(container).style.height).toBe("160px");
    rerender(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "aspect", aspect: 0 }} />
      </Wrap>
    );
    expect(clip(container).style.aspectRatio).toBe("1");
  });

  it("outlines only the media card when selected", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" selected media={{ kind: "fixed", height: 100 }} dataTutorial="generate-image-node" />
      </Wrap>
    );
    const ringed = Array.from(container.querySelectorAll("[class*='ring-2']"));
    expect(ringed).toHaveLength(1);
    expect(ringed[0]).toBe(card(container));
    expect(card(container).className).toContain("border-selection");
    expect(card(container)).toHaveAttribute("data-tutorial", "generate-image-node");
  });

  it("marks a running node with the running border and a thin ring", () => {
    storeState.currentNodeIds = ["n1"];
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    expect(card(container).className).toContain("border-running");
    expect(card(container).className).toContain("ring-1");
  });

  it("draws one ring when a running node is also selected", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" selected isExecuting media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    expect(card(container).className).toContain("ring-2");
    expect(card(container).className).not.toContain("ring-1 ");
  });

  it("lets the error border win", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" selected hasError media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    const cls = card(container).className;
    expect(cls).toContain("border-error");
    expect(cls).not.toContain("border-selection");
    expect(cls).not.toContain("border-card-border");
  });

  it("lays sockets down the card at the pitch with their ids intact", () => {
    const { container } = render(
      <Wrap>
        <NodeShell
          id="n1"
          media={{ kind: "fixed", height: 40 }}
          inputs={[
            { id: "image", type: "image", label: "Image" },
            { id: "text", type: "text", label: "Prompt" },
            { id: "audio", type: "audio" },
          ]}
          outputs={[{ id: "image", type: "image" }]}
        />
      </Wrap>
    );
    const targets = Array.from(container.querySelectorAll(".socket[class*='target']")) as HTMLElement[];
    expect(targets.map((h) => h.dataset.handleid)).toEqual(["image", "text", "audio"]);
    expect(targets.map((h) => h.style.top)).toEqual(["10px", "40px", "70px"]);
    const source = container.querySelector(".socket[class*='source']") as HTMLElement;
    expect(source.dataset.handleid).toBe("image");
    expect(source.style.right).toBe("-15px");
    expect(card(container).style.minHeight).toBe(`${socketMinHeight(3)}px`);
  });

  it("re-measures handles when the socket set changes, not on mount", () => {
    const { rerender } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} inputs={[{ id: "a", type: "text" }]} />
      </Wrap>
    );
    expect(mockUpdateNodeInternals).not.toHaveBeenCalled();
    rerender(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} inputs={[{ id: "a", type: "text" }, { id: "b", type: "text" }]} />
      </Wrap>
    );
    expect(mockUpdateNodeInternals).toHaveBeenCalledWith("n1");
  });

  it("adds the gap row whenever there are controls", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} controls={<div>controls</div>} />
      </Wrap>
    );
    const gap = container.querySelector("[data-gap-row]") as HTMLElement;
    expect(gap.style.height).toBe(`${GAP_ROW_H}px`);
    expect(screen.getByText("controls")).toBeInTheDocument();
  });

  it("shows width-only resize edges when selected", () => {
    const { rerender } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    expect(screen.queryByTestId("resize-left")).toBeNull();
    rerender(
      <Wrap>
        <NodeShell id="n1" selected media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    expect(screen.getByTestId("resize-left")).toBeInTheDocument();
    expect(screen.getByTestId("resize-right")).toBeInTheDocument();
    expect(screen.queryByTestId("resize-top")).toBeNull();
  });

  it("double-clicking a resize edge resets selected nodes to the default width", () => {
    render(
      <Wrap>
        <NodeShell id="n1" selected media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    fireEvent.doubleClick(screen.getByTestId("resize-left"));
    expect(mockSetNodes).toHaveBeenCalledTimes(1);
    const updater = mockSetNodes.mock.calls[0][0] as (nodes: unknown[]) => Array<{ width?: number; style?: { width?: number } }>;
    const out = updater([
      { id: "n1", type: "nanoBanana", selected: true, width: 480, style: { width: 480 } },
      { id: "n2", type: "prompt", selected: true, style: { width: 400, opacity: 1 } },
      { id: "n3", type: "prompt", selected: false, style: { width: 400 } },
    ]);
    expect(out[0].width).toBe(300);
    expect(out[0].style?.width).toBe(300);
    expect(out[1].width).toBe(300);
    expect(out[1].style).toEqual({ width: 300, opacity: 1 });
    expect(out[2].width).toBeUndefined();
  });

  it("reports hover to the store", () => {
    const { container } = render(
      <Wrap>
        <NodeShell id="n1" media={{ kind: "fixed", height: 100 }} />
      </Wrap>
    );
    const root = container.querySelector("[data-node-shell]") as HTMLElement;
    fireEvent.mouseEnter(root, { buttons: 0 });
    expect(mockSetHoveredNodeId).toHaveBeenCalledWith("n1");
    fireEvent.mouseLeave(root, { buttons: 0 });
    expect(mockSetHoveredNodeId).toHaveBeenCalledWith(null);
  });
});
