import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { ArrayNode } from "@/components/nodes/ArrayNode";
import { PaintedNodes } from "@/components/nodes/paintMode";
import { useNodeUiStore } from "@/store/nodeUiStore";
import type { ArrayNodeData } from "@/types";

const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();
let mockState: unknown = null;

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign((selector: (state: unknown) => unknown) => mockUseWorkflowStore(selector), {
    getState: () => mockState,
  }),
}));

const NODE_ID = "array-1";
const ITEMS = ["fox", "lighthouse", "koi", "motel", "greenhouse", "market", "harbour"];

function nodeData(overrides: Partial<ArrayNodeData> = {}): ArrayNodeData {
  const inputText = overrides.inputText ?? null;
  return {
    inputText,
    splitMode: "delimiter",
    delimiter: "*",
    regexPattern: "",
    trimItems: true,
    removeEmpty: true,
    batchMode: false,
    selectedOutputIndex: null,
    outputItems: [],
    outputText: "[]",
    error: null,
    ...overrides,
  };
}

function setup(data: ArrayNodeData, edges: Array<Record<string, unknown>> = [], { painted = false } = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
    addNode: vi.fn(),
    onConnect: vi.fn(),
    currentNodeIds: [] as string[],
    setHoveredNodeId: vi.fn(),
    nodes: [
      { id: NODE_ID, type: "array", position: { x: 0, y: 0 }, data },
      { id: "prompt-1", type: "prompt", position: { x: -300, y: 0 }, data: { prompt: data.inputText ?? "" } },
    ],
    edges,
  };
  mockUseWorkflowStore.mockImplementation((selector: (s: typeof state) => unknown) => selector(state));
  mockState = state;
  const node = (
    <ArrayNode
      id={NODE_ID}
      type="array"
      data={data}
      selected={false}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      zIndex={0}
      dragging={false}
      deletable
      selectable
      draggable
    />
  );
  return render(<ReactFlowProvider>{painted ? <PaintedNodes>{node}</PaintedNodes> : node}</ReactFlowProvider>);
}

const incoming = { id: "in", source: "prompt-1", sourceHandle: "text", target: NODE_ID, targetHandle: "text", data: {} };
const outgoing = (index: number) => ({
  id: `out-${index}`, source: NODE_ID, sourceHandle: "text", target: `t-${index}`, targetHandle: "text",
  data: { arrayItemIndex: index, createdAt: index + 1 },
});

describe("ArrayNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for text when nothing is connected", () => {
    setup(nodeData());
    expect(screen.getByText("Connect text to split it")).toBeInTheDocument();
    expect(screen.getByTestId("array-item-count")).toHaveTextContent("No items");
    expect(screen.getByRole("button", { name: /Make Prompts/ })).toBeDisabled();
  });

  it("saves its items when it mounts, as a painted copy too (derived values)", () => {
    const data = nodeData({ inputText: ITEMS.join("*") });
    setup(data, [incoming]);
    expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ outputItems: ITEMS }));

    mockUpdateNodeData.mockClear();
    setup(data, [incoming], { painted: true });
    expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ outputItems: ITEMS }));
  });

  it("previews the first five items and marks the wired ones", () => {
    setup(nodeData({ inputText: ITEMS.join("*"), outputItems: ITEMS }), [incoming, outgoing(0), outgoing(1)]);
    const list = screen.getByTestId("array-items");
    expect(screen.getByTestId("array-item-count")).toHaveTextContent("7 items");
    expect(within(list).getByText("greenhouse")).toBeInTheDocument();
    expect(within(list).queryByText("market")).toBeNull();
    expect(within(list).getAllByTestId("array-item-wired")).toHaveLength(2);
    expect(within(list).queryByText("next")).toBeNull();

    fireEvent.click(within(list).getByText("2 more"));
    expect(within(list).getByText("harbour")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Make 7 Prompts/ })).toBeEnabled();
  });

  it("opens an item to show its full text, and closes it again", () => {
    const long = "a desert motel at noon, film grain, wide shot, sun bleached sign, two cars parked out front";
    const items = ["fox", long];
    setup(nodeData({ inputText: items.join("*"), outputItems: items }), [incoming]);
    expect(screen.queryByTestId("array-item-full")).toBeNull();

    const row = screen.getByText(long).closest("button")!;
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("array-item-full")).toHaveTextContent(long);
    // Opening an item never changes which item a connection takes
    expect(mockUpdateNodeData).not.toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ selectedOutputIndex: expect.anything() }));

    fireEvent.click(row);
    expect(screen.queryByTestId("array-item-full")).toBeNull();
  });

  it("shows the opened item in a painted copy, until the text splits differently", () => {
    useNodeUiStore.getState().forget();
    const long = "a desert motel at noon, film grain, wide shot, sun bleached sign, two cars parked out front";
    const items = ["fox", long];
    useNodeUiStore.getState().set(NODE_ID, "openItem", { index: 1, of: items.join("\u0000") });
    const copy = setup(nodeData({ inputText: items.join("*"), outputItems: items }), [incoming], { painted: true });
    expect(screen.getByTestId("array-item-full")).toHaveTextContent(long);
    copy.unmount();

    setup(nodeData({ inputText: ["koi", long].join("*"), outputItems: ["koi", long] }), [incoming], { painted: true });
    expect(screen.queryByTestId("array-item-full")).toBeNull();
    useNodeUiStore.getState().forget();
  });

  it("explains batch mode and drops the Prompt action", () => {
    setup(nodeData({ inputText: ITEMS.join("*"), outputItems: ITEMS, batchMode: true }), [incoming, outgoing(0)]);
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByText("Each connected Generate, LLM or ComfyUI app node runs 7 times, once per item.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make/ })).toBeNull();
    expect(screen.queryByTestId("array-item-wired")).toBeNull();
  });

  it("shows a parse error in the list", () => {
    const error = "Invalid regular expression: /[a-z/: Unterminated character class";
    setup(nodeData({ inputText: "a b", splitMode: "regex", regexPattern: "[a-z", error }), [incoming]);
    expect(screen.getByRole("alert")).toHaveTextContent("Unterminated character class");
    expect(screen.getByLabelText("Regex pattern")).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the clean-up options behind a button", () => {
    setup(nodeData({ inputText: "a* b", outputItems: ["a", "b"] }), [incoming]);
    expect(screen.queryByText("Trim spaces")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clean-up options" }));
    fireEvent.click(screen.getByRole("button", { name: "Trim spaces" }));
    expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ trimItems: false }));
  });
});
