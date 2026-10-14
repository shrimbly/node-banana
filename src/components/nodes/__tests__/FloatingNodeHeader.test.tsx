import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { FloatingNodeHeader } from "../FloatingNodeHeader";
import { HoldLiveProvider } from "../paintMode";

let hoveredNodeId: string | null = null;
vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector: (s: { hoveredNodeId: string | null }) => unknown) => selector({ hoveredNodeId }),
    { getState: () => ({ nodes: [], groups: {} }) }
  ),
}));

const base = {
  id: "n1",
  position: { x: 0, y: 0 },
  width: 300,
  selected: false,
  title: "Nano Banana Pro",
};

function renderHeader(props: Partial<React.ComponentProps<typeof FloatingNodeHeader>> = {}) {
  const onRunNode = vi.fn();
  const onExpandNode = vi.fn();
  const onBrowse = vi.fn();
  const onOpenFallback = vi.fn();
  const onToggleOptional = vi.fn();
  const onCommentChange = vi.fn();
  const onCustomTitleChange = vi.fn();
  const utils = render(
    <ReactFlowProvider>
      <FloatingNodeHeader
        {...base}
        type="nanoBanana"
        onRunNode={onRunNode}
        onExpandNode={onExpandNode}
        onBrowse={onBrowse}
        canFallback
        onOpenFallback={onOpenFallback}
        onToggleOptional={onToggleOptional}
        onCommentChange={onCommentChange}
        onCustomTitleChange={onCustomTitleChange}
        {...props}
      />
    </ReactFlowProvider>
  );
  return { onRunNode, onExpandNode, onBrowse, onOpenFallback, onToggleOptional, onCommentChange, onCustomTitleChange, ...utils };
}

const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("menu", { name: "Node actions" });
};

describe("FloatingNodeHeader", () => {
  beforeEach(() => {
    hoveredNodeId = null;
  });

  it("makes the title the model picker on a generate node", () => {
    const { onBrowse } = renderHeader();
    const picker = screen.getByTestId("node-title-picker");
    expect(picker).toHaveTextContent("Nano Banana Pro");
    fireEvent.click(picker);
    expect(onBrowse).toHaveBeenCalledWith("n1");
    expect(screen.queryByText("Browse")).toBeNull();
  });

  it("keeps a plain title elsewhere and renames on double-click", () => {
    const { onCustomTitleChange } = renderHeader({ type: "prompt", onBrowse: undefined, title: "Prompt" });
    expect(screen.queryByTestId("node-title-picker")).toBeNull();
    fireEvent.doubleClick(screen.getByText("Prompt"));
    const input = screen.getByPlaceholderText("Custom title...");
    fireEvent.change(input, { target: { value: "Hero shot" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCustomTitleChange).toHaveBeenCalledWith("n1", "Hero shot");
  });

  it("holds its node live on the GPU canvas while renaming or with the menu open", () => {
    const release = vi.fn();
    const hold = vi.fn(() => release);
    render(
      <ReactFlowProvider>
        <HoldLiveProvider hold={hold}>
          <FloatingNodeHeader {...base} type="prompt" title="Prompt" onCustomTitleChange={vi.fn()} />
        </HoldLiveProvider>
      </ReactFlowProvider>
    );
    expect(hold).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("Prompt"));
    expect(hold).toHaveBeenCalledWith("n1");
    fireEvent.keyDown(screen.getByPlaceholderText("Custom title..."), { key: "Escape" });
    expect(release).toHaveBeenCalledTimes(1);
    openMenu();
    expect(hold).toHaveBeenCalledTimes(2);
  });

  it("has no bordered chips: fallback and comment live in the kebab", () => {
    renderHeader();
    expect(screen.queryByTitle(/fallback/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add comment/i })).toBeNull();
    const menu = openMenu();
    const rows = within(menu).getAllByRole("menuitem").map((r) => r.textContent);
    expect(rows).toEqual(["Browse models…", "Run node⌥↵", "Rename", "Set fallback model…", "Add comment…"]);
  });

  it("runs, browses and opens the fallback dialog from the menu, closing it after", () => {
    const { onRunNode, onOpenFallback } = renderHeader();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /run node/i }));
    expect(onRunNode).toHaveBeenCalledWith("n1");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /fallback/i }));
    expect(onOpenFallback).toHaveBeenCalledWith("n1", "nanoBanana");
  });

  it("marks a set fallback with a dot on the kebab and in its row", () => {
    renderHeader({ fallbackName: "Nano Banana" });
    const more = screen.getByRole("button", { name: "More" });
    expect(more.parentElement?.querySelector(".bg-blue-400")).not.toBeNull();
    expect(within(openMenu()).getByRole("menuitem", { name: /Fallback: Nano Banana/ })).toBeInTheDocument();
  });

  it("shows a comment as a glyph and opens the editor from it or the menu", () => {
    renderHeader({ comment: "Try warmer light" });
    fireEvent.click(screen.getByTestId("node-comment-glyph"));
    expect(screen.getByLabelText("Comment")).toHaveValue("Try warmer light");
    fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    expect(within(openMenu()).getByRole("menuitem", { name: /Edit comment/ })).toBeInTheDocument();
  });

  it("shows no comment glyph without a comment", () => {
    renderHeader();
    expect(screen.queryByTestId("node-comment-glyph")).toBeNull();
  });

  it("hides Expand until the node is hovered, then opens the editor", () => {
    const { onExpandNode, rerender } = renderHeader({ type: "prompt", onBrowse: undefined, canFallback: false, title: "Prompt" });
    let expand = screen.getByRole("button", { name: "Expand editor" });
    expect(expand.closest(".opacity-0")).not.toBeNull();
    hoveredNodeId = "n1";
    rerender(
      <ReactFlowProvider>
        <FloatingNodeHeader {...base} type="prompt" title="Prompt" onExpandNode={onExpandNode} />
      </ReactFlowProvider>
    );
    expand = screen.getByRole("button", { name: "Expand editor" });
    expect(expand.closest(".opacity-0")).toBeNull();
    fireEvent.click(expand);
    expect(onExpandNode).toHaveBeenCalledWith("n1", "prompt");
    expect(expand.textContent).toBe("");
  });

  it("fades Run and the kebab in on hover, and Run's label never changes", () => {
    const { rerender, onRunNode } = renderHeader();
    const run = screen.getByRole("button", { name: "Run node" });
    expect(run.closest(".opacity-0")).not.toBeNull();
    expect(run.textContent).toBe("Run");
    hoveredNodeId = "n1";
    rerender(
      <ReactFlowProvider>
        <FloatingNodeHeader {...base} type="nanoBanana" onRunNode={onRunNode} onBrowse={() => {}} />
      </ReactFlowProvider>
    );
    expect(screen.getByRole("button", { name: "Run node" }).closest(".opacity-0")).toBeNull();
    expect(screen.getByRole("button", { name: "Run node" }).textContent).toBe("Run");
    fireEvent.click(screen.getByRole("button", { name: "Run node" }));
    expect(onRunNode).toHaveBeenCalledWith("n1");
  });

  it("offers Optional input to input nodes and toggles it", () => {
    const { onToggleOptional } = renderHeader({ type: "imageInput", onBrowse: undefined, canFallback: false, canToggleOptional: true, isOptional: false, title: "Image Input", hint: "needs an image" });
    expect(screen.getByTestId("node-readiness-hint")).toHaveTextContent("needs an image");
    const row = within(openMenu()).getByRole("menuitem", { name: /Optional input/ });
    expect(row).toHaveTextContent("off");
    fireEvent.click(row);
    expect(onToggleOptional).toHaveBeenCalledWith("n1", true);
  });

  it("offers Replace workflow on a ComfyUI app node, and only there", () => {
    const onReplaceWorkflow = vi.fn();
    const { unmount } = renderHeader({ type: "comfyApp", onBrowse: undefined, canFallback: false, title: "Blueprint", onReplaceWorkflow });
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Replace workflow…" }));
    expect(onReplaceWorkflow).toHaveBeenCalledWith("n1");
    expect(screen.queryByRole("menu")).toBeNull();
    unmount();

    renderHeader();
    expect(within(openMenu()).queryByRole("menuitem", { name: "Replace workflow…" })).toBeNull();
  });

  it("closes the menu on Escape and on an outside press", () => {
    renderHeader();
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
