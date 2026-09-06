import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowTabs } from "@/components/WorkflowTabs";
import type { WorkflowTab } from "@/store/utils/workflowTabs";

const mockSwitchTab = vi.fn();
const mockCloseTab = vi.fn();
const mockNewTab = vi.fn();
const mockSetCanvasViewport = vi.fn();
const mockSetViewport = vi.fn();
const mockUseOnViewportChange = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ setViewport: mockSetViewport, getViewport: () => ({ x: 1, y: 2, zoom: 3 }) }),
  useOnViewportChange: (handlers: unknown) => mockUseOnViewportChange(handlers),
}));

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) return mockUseWorkflowStore(selector);
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

const parked = (name: string | null, hasUnsavedChanges = false) =>
  ({ workflowName: name, hasUnsavedChanges }) as unknown as NonNullable<WorkflowTab["snapshot"]>;

const twoTabs: WorkflowTab[] = [
  { id: "tab-1", snapshot: parked("Summer campaign", true) },
  { id: "tab-2", snapshot: null },
];

function useState(overrides = {}) {
  const state = {
    tabs: twoTabs,
    activeTabId: "tab-2",
    workflowName: "Product shots",
    hasUnsavedChanges: false,
    isRunning: false,
    isSaving: false,
    pendingMediaSaves: 0,
    canvasViewport: null,
    setCanvasViewport: mockSetCanvasViewport,
    switchTab: mockSwitchTab,
    closeTab: mockCloseTab,
    newTab: mockNewTab,
    ...overrides,
  };
  mockUseWorkflowStore.mockImplementation((selector) => selector(state));
}

describe("WorkflowTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the bar with a single tab, so the name always has a home", () => {
    useState({ tabs: [{ id: "tab-1", snapshot: null }], activeTabId: "tab-1" });
    render(<WorkflowTabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveTextContent("Product shots");
    expect(screen.getByRole("button", { name: "New tab" })).toBeInTheDocument();
  });

  it("closes on middle-click, like a browser", () => {
    render(<WorkflowTabs />);
    fireEvent(screen.getAllByRole("tab")[1], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(mockCloseTab).toHaveBeenCalledWith("tab-2");
  });

  it("lists every open workflow, marking the active one", () => {
    render(<WorkflowTabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[0]).toHaveTextContent("Summer campaign");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveTextContent("Product shots");
  });

  it("shows Untitled for a tab without a name", () => {
    useState({ workflowName: null });
    render(<WorkflowTabs />);
    expect(screen.getAllByRole("tab")[1]).toHaveTextContent("Untitled");
  });

  it("marks unsaved tabs with a dot", () => {
    render(<WorkflowTabs />);
    const [first, second] = screen.getAllByRole("tab");
    expect(first.querySelector('[aria-label="Unsaved"]')).toBeInTheDocument();
    expect(second.querySelector('[aria-label="Unsaved"]')).not.toBeInTheDocument();
    // The dot and the close button share one slot over the label's end, so
    // swapping them on hover never moves the text
    const dot = first.querySelector('[aria-label="Unsaved"]')!;
    const close = first.querySelector('button[aria-label^="Close"]')!;
    expect(dot.parentElement).toBe(close.parentElement);
    expect(dot.parentElement?.className).toContain("absolute");
  });

  it("switches on click of a parked tab, not the active one", () => {
    render(<WorkflowTabs />);
    fireEvent.click(screen.getByText("Product shots"));
    expect(mockSwitchTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Summer campaign"));
    expect(mockSwitchTab).toHaveBeenCalledWith("tab-1");
  });

  it("closes a clean tab straight away", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<WorkflowTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close Product shots" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(mockCloseTab).toHaveBeenCalledWith("tab-2");
  });

  it("asks before closing a tab with unsaved changes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<WorkflowTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close Summer campaign" }));
    expect(confirm).toHaveBeenCalled();
    expect(mockCloseTab).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Summer campaign" }));
    expect(mockCloseTab).toHaveBeenCalledWith("tab-1");
  });

  it("opens a new tab from the plus button", () => {
    render(<WorkflowTabs />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(mockNewTab).toHaveBeenCalledTimes(1);
  });

  it("blocks tab changes while a media save is still writing, and says so", () => {
    useState({ pendingMediaSaves: 2 });
    render(<WorkflowTabs />);
    expect(screen.getByRole("button", { name: "New tab" })).toHaveAttribute("title", "Wait for the media to finish saving");
    expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
  });

  it("mirrors viewport moves into the store and restores the tab's viewport on a switch", () => {
    const { rerender } = render(<WorkflowTabs />);
    expect(mockUseOnViewportChange).toHaveBeenCalledWith({ onEnd: mockSetCanvasViewport });
    // First showing of a tab with no viewport of its own: it adopts the current one
    expect(mockSetViewport).not.toHaveBeenCalled();
    expect(mockSetCanvasViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 3 });

    useState({ activeTabId: "tab-1", canvasViewport: { x: 10, y: 20, zoom: 1.5 } });
    rerender(<WorkflowTabs />);
    expect(mockSetViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 1.5 });
  });

  it("blocks switching, closing and opening while a run is in flight", () => {
    useState({ isRunning: true });
    render(<WorkflowTabs />);
    fireEvent.click(screen.getByText("Summer campaign"));
    expect(mockSwitchTab).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Product shots" })).toBeDisabled();
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("title", "Wait for the run to finish");
  });
});
