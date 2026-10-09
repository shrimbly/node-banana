import { useLayoutEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { WorkflowTabs } from "@/components/WorkflowTabs";
import type { WorkflowTab } from "@/store/utils/workflowTabs";
import { useAssetStore } from "@/store/assetStore";
import { setAgentTurnStop } from "@/lib/agent/client/stopGuard";

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
  useWorkflowStore: Object.assign((selector?: (state: unknown) => unknown) => {
    if (selector) return mockUseWorkflowStore(selector);
    return mockUseWorkflowStore((s: unknown) => s);
  }, { getState: () => mockUseWorkflowStore((s: unknown) => s) }),
}));

/** What the page's agent session tells the strip: a turn running, a harness that needs the user. */
const agentPresence = vi.hoisted(() => ({
  busy: false,
  presence: { harness: "claude" as const, harnessChosen: true, attention: false },
}));
vi.mock("@/components/agent/AgentSession", () => ({ useAgentPresence: () => agentPresence }));

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
  return state;
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

  describe("while an agent turn runs", () => {
    const stopTurn = vi.fn();
    beforeEach(() => setAgentTurnStop(stopTurn));
    afterEach(() => setAgentTurnStop(null));

    it("asks before switching, and stays put when the user keeps the agent working", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByText("Summer campaign"));
      expect(confirm).toHaveBeenCalledWith("The agent is still working. Switching workflows will stop it.");
      expect(stopTurn).not.toHaveBeenCalled();
      expect(mockSwitchTab).not.toHaveBeenCalled();
    });

    it("stops the turn, then switches, once the user agrees", () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByText("Summer campaign"));
      expect(stopTurn).toHaveBeenCalledTimes(1);
      expect(mockSwitchTab).toHaveBeenCalledWith("tab-1");
      expect(stopTurn.mock.invocationCallOrder[0]).toBeLessThan(mockSwitchTab.mock.invocationCallOrder[0]);
    });

    it("asks before a new tab and before closing the live tab", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      fireEvent.click(screen.getByRole("button", { name: "Close Product shots" }));
      expect(confirm).toHaveBeenNthCalledWith(1, "The agent is still working. Opening a new tab will stop it.");
      expect(confirm).toHaveBeenNthCalledWith(2, "The agent is still working. Closing this tab will stop it.");
      expect(mockNewTab).not.toHaveBeenCalled();
      expect(mockCloseTab).not.toHaveBeenCalled();
    });

    it("closes a parked tab without asking about the agent, which works in the live one", () => {
      // Only the unsaved-changes question: the parked tab holds them.
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole("button", { name: "Close Summer campaign" }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith("Close Summer campaign and discard its unsaved changes?");
      expect(stopTurn).not.toHaveBeenCalled();
      expect(mockCloseTab).toHaveBeenCalledWith("tab-1");
    });
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

  it("captures the incoming viewport before navigation effects can update the store", () => {
    const incoming = { x: 120, y: -50, zoom: 0.7 };
    const state = useState({ canvasViewport: incoming });
    mockUseOnViewportChange.mockImplementationOnce(() => {
      useLayoutEffect(() => {
        // An outgoing navigation event can arrive during the same commit.
        Object.assign(state, { canvasViewport: { x: 999, y: 999, zoom: 1 } });
      }, []);
    });
    render(<WorkflowTabs />);
    expect(mockSetViewport).toHaveBeenCalledWith(incoming);
  });

  describe("Assets entry", () => {
    beforeEach(() => useAssetStore.setState({ appView: "canvas" }));
    afterEach(() => useAssetStore.setState({ appView: "canvas" }));

    it("sits before the workflow tabs as a toggle button, not a tab", () => {
      render(<WorkflowTabs />);
      const assets = screen.getByRole("button", { name: "Assets" });
      expect(assets).toHaveAttribute("aria-pressed", "false");
      expect(assets).not.toHaveAttribute("role", "tab");
      // Before the first workflow tab, and the tabs are still only the workflows
      expect(assets.compareDocumentPosition(screen.getAllByRole("tab")[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });

    it("is only its icon until Assets shows, then takes its label", () => {
      const { rerender } = render(<WorkflowTabs />);
      const assets = screen.getByRole("button", { name: "Assets" });
      expect(assets).not.toHaveTextContent("Assets");
      expect(assets.querySelector("svg")).not.toBeNull();
      act(() => useAssetStore.setState({ appView: "assets" }));
      rerender(<WorkflowTabs />);
      expect(screen.getByRole("button", { name: "Assets" })).toHaveTextContent("Assets");
    });

    it("draws no divider between the Assets icon and the first tab", () => {
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      const [first] = screen.getAllByRole("tab");
      expect(first!.querySelector("span.w-px")).toBeNull();
    });

    it("shows Assets, and a second click goes back to the canvas", () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole("button", { name: "Assets" }));
      expect(useAssetStore.getState().appView).toBe("assets");
      expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Assets" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    it("takes the shown look, in the rail's colour, from the live tab while Assets shows, without changing which tab is live", () => {
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      const [, live] = screen.getAllByRole("tab");
      expect(live).toHaveAttribute("aria-selected", "true");
      expect(live!.className).not.toContain("bg-canvas-bg");
      expect(screen.getByRole("button", { name: "Assets" }).className).toContain("bg-pane");
    });

    it("goes back to the canvas from the live tab without switching", () => {
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByText("Product shots"));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockSwitchTab).not.toHaveBeenCalled();
    });

    it("goes back to the canvas and switches from a parked tab", () => {
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByText("Summer campaign"));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockSwitchTab).toHaveBeenCalledWith("tab-1");
    });

    it("goes back to the canvas from the plus and from closing a tab", () => {
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockNewTab).toHaveBeenCalled();

      useAssetStore.setState({ appView: "assets" });
      fireEvent.click(screen.getByRole("button", { name: "Close Product shots" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    it("keeps the live tab usable during a run, so the way back is never blocked", () => {
      useState({ isRunning: true });
      useAssetStore.setState({ appView: "assets" });
      render(<WorkflowTabs />);
      expect(screen.getByText("Product shots")).not.toBeDisabled();
      expect(screen.getByText("Summer campaign")).toBeDisabled();
      fireEvent.click(screen.getByText("Product shots"));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });
  });

  describe("Chat entry", () => {
    beforeEach(() => useAssetStore.setState({ appView: "canvas" }));
    afterEach(() => {
      useAssetStore.setState({ appView: "canvas" });
      agentPresence.busy = false;
      agentPresence.presence.attention = false;
    });

    const chat = () => screen.getByRole("button", { name: "Chat" });

    it("leads the strip, before Assets, as a toggle button and not a tab", () => {
      render(<WorkflowTabs />);
      expect(chat()).toHaveAttribute("aria-pressed", "false");
      expect(chat()).not.toHaveAttribute("role", "tab");
      expect(screen.getByRole("tablist").firstElementChild).toBe(chat());
      expect(chat().nextElementSibling).toBe(screen.getByRole("button", { name: "Assets" }));
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });

    it("is only its icon until the chat shows, then takes its label and says how to go back", () => {
      const { rerender } = render(<WorkflowTabs />);
      expect(chat()).not.toHaveTextContent("Chat");
      expect(chat().querySelector("svg")).not.toBeNull();
      expect(chat()).toHaveAttribute("title", "Chat (C)");
      act(() => useAssetStore.setState({ appView: "chat" }));
      rerender(<WorkflowTabs />);
      expect(chat()).toHaveTextContent("Chat");
      expect(chat()).toHaveAttribute("title", "Back to the canvas (C)");
    });

    it("shows the chat, and a second click goes back to the canvas", () => {
      render(<WorkflowTabs />);
      fireEvent.click(chat());
      expect(useAssetStore.getState().appView).toBe("chat");
      expect(chat()).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(chat());
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(chat()).toHaveAttribute("aria-pressed", "false");
    });

    it("moves straight between the chat and Assets", () => {
      render(<WorkflowTabs />);
      fireEvent.click(chat());
      fireEvent.click(screen.getByRole("button", { name: "Assets" }));
      expect(useAssetStore.getState().appView).toBe("assets");
      expect(chat()).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(chat());
      expect(useAssetStore.getState().appView).toBe("chat");
      expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "false");
    });

    it("takes the shown look, in the sidebar's colour, from the live tab without changing which tab is live", () => {
      useAssetStore.setState({ appView: "chat" });
      render(<WorkflowTabs />);
      const [, live] = screen.getAllByRole("tab");
      expect(live).toHaveAttribute("aria-selected", "true");
      expect(live!.className).not.toContain("bg-canvas-bg");
      expect(chat().className).toContain("bg-pane");
      // Its feet flow into the sidebar: two ears
      expect(chat().querySelectorAll('svg[viewBox="0 0 9 9"]')).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Assets" }).className).not.toContain("bg-pane");
    });

    it("goes back to the canvas from the live tab, a parked tab, the plus and closing a tab", () => {
      useAssetStore.setState({ appView: "chat" });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByText("Product shots"));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockSwitchTab).not.toHaveBeenCalled();

      useAssetStore.setState({ appView: "chat" });
      fireEvent.click(screen.getByText("Summer campaign"));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockSwitchTab).toHaveBeenCalledWith("tab-1");

      useAssetStore.setState({ appView: "chat" });
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
      expect(mockNewTab).toHaveBeenCalled();

      useAssetStore.setState({ appView: "chat" });
      fireEvent.click(screen.getByRole("button", { name: "Close Product shots" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    const dot = () => chat().querySelector("[data-view-status]");

    it("carries no dot while the agent is idle and ready", () => {
      render(<WorkflowTabs />);
      expect(dot()).toBeNull();
      expect(chat()).not.toHaveAttribute("aria-describedby");
      expect(chat()).toHaveAttribute("title", "Chat (C)");
    });

    it("pulses a dot on its icon while a turn runs, shown or not, and says so", () => {
      agentPresence.busy = true;
      const { rerender } = render(<WorkflowTabs />);
      expect(dot()).toHaveAttribute("data-view-status", "working");
      expect(dot()!.querySelector(".animate-ping")).not.toBeNull();
      expect(dot()!.className).toContain("ring-[#0f0f0f]");
      expect(chat()).toHaveAccessibleDescription("The agent is working");
      expect(chat()).toHaveAttribute("title", "Chat (C) · The agent is working");

      act(() => useAssetStore.setState({ appView: "chat" }));
      rerender(<WorkflowTabs />);
      expect(dot()).toHaveAttribute("data-view-status", "working");
      // Cut out of the sidebar's colour once the toggle takes the shown look
      expect(dot()!.className).toContain("ring-pane");
      // The name stays the plain label
      expect(screen.getByRole("button", { name: "Chat" })).toBe(chat());
    });

    it("shows a still amber dot when the harness needs the user and no turn runs", () => {
      agentPresence.presence.attention = true;
      render(<WorkflowTabs />);
      expect(dot()).toHaveAttribute("data-view-status", "attention");
      expect(dot()!.querySelector(".animate-ping")).toBeNull();
      expect(dot()!.querySelector(".bg-amber-400")).not.toBeNull();
      expect(chat()).toHaveAccessibleDescription("The agent needs attention");
    });

    it("lets a running turn win over the attention dot", () => {
      agentPresence.busy = true;
      agentPresence.presence.attention = true;
      render(<WorkflowTabs />);
      expect(dot()).toHaveAttribute("data-view-status", "working");
    });

    it("never puts the dot on Assets", () => {
      agentPresence.busy = true;
      render(<WorkflowTabs />);
      expect(screen.getByRole("button", { name: "Assets" }).querySelector("[data-view-status]")).toBeNull();
    });
  });

  describe("hairlines between tabs", () => {
    const threeTabs: WorkflowTab[] = [
      { id: "tab-1", snapshot: parked("One") },
      { id: "tab-2", snapshot: parked("Two") },
      { id: "tab-3", snapshot: null },
    ];
    const hairline = (tab: HTMLElement) => tab.querySelector("span.w-px");

    afterEach(() => useAssetStore.setState({ appView: "canvas" }));

    it("divides two tabs neither of which is shown, never beside the shown one or before the first", () => {
      useState({ tabs: threeTabs, activeTabId: "tab-3" });
      render(<WorkflowTabs />);
      const [one, two, three] = screen.getAllByRole("tab");
      expect(hairline(one!)).toBeNull();
      expect(hairline(two!)).not.toBeNull();
      expect(hairline(three!)).toBeNull();
    });

    it.each(["chat", "assets"] as const)("divides every tab but the first while the %s view shows", (view) => {
      useState({ tabs: threeTabs, activeTabId: "tab-3" });
      useAssetStore.setState({ appView: view });
      render(<WorkflowTabs />);
      const [one, two, three] = screen.getAllByRole("tab");
      expect(hairline(one!)).toBeNull();
      expect(hairline(two!)).not.toBeNull();
      expect(hairline(three!)).not.toBeNull();
    });
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
