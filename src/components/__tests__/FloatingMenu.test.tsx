import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { FloatingMenu } from "@/components/FloatingMenu";

const mockSetWorkflowMetadata = vi.fn();
const mockSaveToFile = vi.fn();
const mockLoadWorkflow = vi.fn();
const mockRevertToSnapshot = vi.fn();
const mockSetShortcutsDialogOpen = vi.fn();
const mockSetShowQuickstart = vi.fn();
const mockGetNodesWithComments = vi.fn();
const mockMarkCommentViewed = vi.fn();
const mockSetNavigationTarget = vi.fn();
const mockNewTab = vi.fn();
const mockCloseTab = vi.fn();
const mockOpenWorkflowInNewTab = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

vi.mock("@/components/ProjectSetupModal", () => ({
  ProjectSetupModal: ({ isOpen, mode }: { isOpen: boolean; mode: string }) =>
    isOpen ? <div data-testid="project-setup-modal" data-mode={mode}>Project Setup Modal</div> : null,
}));

vi.mock("@/components/WorkflowBrowserModal", () => ({
  WorkflowBrowserModal: ({
    isOpen,
    onWorkflowLoaded,
  }: {
    isOpen: boolean;
    onWorkflowLoaded: (workflow: unknown, dirPath?: string) => void;
  }) =>
    isOpen ? (
      <div data-testid="workflow-browser-modal">
        <button onClick={() => onWorkflowLoaded({ name: "Picked" }, "/tmp/picked")}>pick</button>
      </div>
    ) : null,
}));

vi.mock("@/components/KeyboardShortcutsDialog", () => ({
  KeyboardShortcutsDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="shortcuts-dialog">Shortcuts</div> : null,
}));

const createDefaultState = (overrides = {}) => ({
  workflowName: "",
  workflowId: "",
  saveDirectoryPath: "",
  hasUnsavedChanges: false,
  lastSavedAt: null,
  isSaving: false,
  previousWorkflowSnapshot: null,
  shortcutsDialogOpen: false,
  tabs: [{ id: "tab-1", snapshot: null }],
  activeTabId: "tab-1",
  nodes: [],
  viewedCommentNodeIds: new Set<string>(),
  setWorkflowMetadata: mockSetWorkflowMetadata,
  saveToFile: mockSaveToFile,
  loadWorkflow: mockLoadWorkflow,
  revertToSnapshot: mockRevertToSnapshot,
  setShortcutsDialogOpen: mockSetShortcutsDialogOpen,
  setShowQuickstart: mockSetShowQuickstart,
  getNodesWithComments: mockGetNodesWithComments,
  markCommentViewed: mockMarkCommentViewed,
  setNavigationTarget: mockSetNavigationTarget,
  newTab: mockNewTab,
  closeTab: mockCloseTab,
  openWorkflowInNewTab: mockOpenWorkflowInNewTab,
  ...overrides,
});

const twoTabs = {
  tabs: [
    { id: "tab-1", snapshot: { workflowName: "Other", hasUnsavedChanges: false } },
    { id: "tab-2", snapshot: null },
  ],
  activeTabId: "tab-2",
};

const configuredState = (overrides = {}) =>
  createDefaultState({
    workflowName: "Summer campaign",
    workflowId: "wf-1",
    saveDirectoryPath: "/tmp/projects/summer",
    ...overrides,
  });

function useState(state: ReturnType<typeof createDefaultState>) {
  mockUseWorkflowStore.mockImplementation((selector) => selector(state));
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Menu" }));
const menuItem = (name: string | RegExp) => within(screen.getByRole("menu")).getByRole("menuitem", { name });

describe("FloatingMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNodesWithComments.mockReturnValue([]);
    mockSaveToFile.mockResolvedValue(undefined);
    useState(createDefaultState());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("collapsed pill", () => {
    it("is three buttons at rest: menu, open, save; no name and no status text", () => {
      render(<FloatingMenu />);
      expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open project" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save project" })).toHaveAttribute("title", "Save project · Not saved");
      expect(screen.queryByText("Untitled")).not.toBeInTheDocument();
      expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("keeps the save button visible and tutorial-addressable", () => {
      render(<FloatingMenu />);
      const save = screen.getByRole("button", { name: "Save project" });
      expect(save).toHaveAttribute("data-tutorial", "save-button");
      expect(save.querySelector(".bg-red-500")).toBeInTheDocument();
    });

    it("keeps the project name off the pill and puts the save time in the Save tooltip", () => {
      useState(configuredState({ lastSavedAt: new Date(2024, 0, 1, 15, 42).getTime() }));
      render(<FloatingMenu />);
      expect(screen.queryByText("Summer campaign")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save project" }).getAttribute("title")).toMatch(/^Save project · Saved /);
    });

    it("says unsaved with the last save time once there are edits", () => {
      useState(configuredState({ lastSavedAt: new Date(2024, 0, 1, 15, 42).getTime(), hasUnsavedChanges: true }));
      render(<FloatingMenu />);
      expect(screen.getByRole("button", { name: "Save project" }).getAttribute("title")).toMatch(
        /^Save project · Unsaved · last saved /
      );
    });

    it("shows 'Saving...' and disables save while a save runs", () => {
      useState(configuredState({ isSaving: true, hasUnsavedChanges: true }));
      render(<FloatingMenu />);
      const save = screen.getByRole("button", { name: "Saving..." });
      expect(save).toHaveAttribute("title", "Saving...");
      expect(save).toBeDisabled();
      expect(save.querySelector(".bg-red-500")).not.toBeInTheDocument();
    });

    it("shows the unsaved dot only when a configured project has changes", () => {
      useState(configuredState({ hasUnsavedChanges: false }));
      const { rerender } = render(<FloatingMenu />);
      expect(screen.getByRole("button", { name: "Save project" }).querySelector(".bg-red-500")).not.toBeInTheDocument();

      useState(configuredState({ hasUnsavedChanges: true }));
      rerender(<FloatingMenu />);
      expect(screen.getByRole("button", { name: "Save project" }).querySelector(".bg-red-500")).toBeInTheDocument();
    });

    it("hides comments and revert until they apply", () => {
      render(<FloatingMenu />);
      expect(screen.queryByTitle(/unviewed comment/)).not.toBeInTheDocument();
      expect(screen.queryByText("Revert AI changes")).not.toBeInTheDocument();
    });
  });

  describe("save button", () => {
    it("opens the project setup modal in 'new' mode for an unconfigured project", () => {
      render(<FloatingMenu />);
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      expect(screen.getByTestId("project-setup-modal")).toHaveAttribute("data-mode", "new");
      expect(mockSaveToFile).not.toHaveBeenCalled();
    });

    it("saves straight to file for a configured project", () => {
      useState(configuredState());
      render(<FloatingMenu />);
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      expect(mockSaveToFile).toHaveBeenCalledTimes(1);
    });

    it("opens settings when the project has a name but no save location", () => {
      useState(configuredState({ saveDirectoryPath: "" }));
      render(<FloatingMenu />);
      fireEvent.click(screen.getByRole("button", { name: "Configure save location" }));
      expect(screen.getByTestId("project-setup-modal")).toHaveAttribute("data-mode", "settings");
      expect(mockSaveToFile).not.toHaveBeenCalled();
    });
  });

  describe("expanded menu", () => {
    it("opens from the logo and closes again on a second click", () => {
      render(<FloatingMenu />);
      const toggle = screen.getByRole("button", { name: "Menu" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(toggle);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("lists every former header action for a configured project", () => {
      useState(configuredState());
      render(<FloatingMenu />);
      openMenu();
      const names = within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => [...item.querySelectorAll("span")].find((span) => !span.className)?.textContent);
      expect(names).toEqual([
        "Save project",
        "Open project…",
        "Open project folder",
        "Project settings",
        "New tab",
        "Close tab",
        "Welcome screen",
        "Keyboard shortcuts",
        "Discord",
        "Made by Willie",
      ]);
    });

    it("omits 'Open project folder' without a save directory", () => {
      render(<FloatingMenu />);
      openMenu();
      expect(within(screen.getByRole("menu")).queryByText("Open project folder")).not.toBeInTheDocument();
    });

    it("saves from the menu and closes it", () => {
      useState(configuredState());
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem(/Save project/));
      expect(mockSaveToFile).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opens the workflow browser from 'Open project…'", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Open project…"));
      expect(screen.getByTestId("workflow-browser-modal")).toBeInTheDocument();
    });

    it("asks the server to open the project folder", async () => {
      useState(configuredState());
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Open project folder"));
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/open-directory",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ path: "/tmp/projects/summer" }),
        })
      );
      vi.unstubAllGlobals();
    });

    it("opens project settings", () => {
      useState(configuredState());
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Project settings"));
      expect(screen.getByTestId("project-setup-modal")).toHaveAttribute("data-mode", "settings");
    });

    it("opens the welcome screen (the old logo click)", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Welcome screen"));
      expect(mockSetShowQuickstart).toHaveBeenCalledWith(true);
    });

    it("opens the keyboard shortcuts dialog", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem(/Keyboard shortcuts/));
      expect(mockSetShortcutsDialogOpen).toHaveBeenCalledWith(true);
    });

    it("renders the shortcuts dialog when the store says it is open", () => {
      useState(createDefaultState({ shortcutsDialogOpen: true }));
      render(<FloatingMenu />);
      expect(screen.getByTestId("shortcuts-dialog")).toBeInTheDocument();
    });

    it("links to Discord and to Willie in new tabs", () => {
      render(<FloatingMenu />);
      openMenu();
      const discord = menuItem(/Discord/);
      expect(discord).toHaveAttribute("href", "https://discord.com/invite/89Nr6EKkTf");
      expect(discord).toHaveAttribute("target", "_blank");
      expect(discord).toHaveAttribute("rel", "noopener noreferrer");
      const willie = menuItem(/Made by Willie/);
      expect(willie).toHaveAttribute("href", "https://x.com/ReflctWillie");
      expect(willie).toHaveAttribute("target", "_blank");
    });
  });

  describe("tabs", () => {
    it("loads a picked workflow through openWorkflowInNewTab", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Open project…"));
      fireEvent.click(screen.getByText("pick"));
      expect(mockOpenWorkflowInNewTab).toHaveBeenCalledWith({ name: "Picked" }, "/tmp/picked");
    });

    it("opens a new tab from the menu", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("New tab"));
      expect(mockNewTab).toHaveBeenCalledTimes(1);
    });

    it("offers Close tab even with one tab, since closing the last one leaves a fresh tab", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Close tab"));
      expect(mockCloseTab).toHaveBeenCalledWith("tab-1");
    });

    it("closes the active tab from the menu, asking first when it is unsaved", () => {
      useState(configuredState({ ...twoTabs, hasUnsavedChanges: true }));
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Close tab"));
      expect(confirm).toHaveBeenCalled();
      expect(mockCloseTab).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      openMenu();
      fireEvent.click(menuItem("Close tab"));
      expect(mockCloseTab).toHaveBeenCalledWith("tab-2");
    });

    it("opens the project browser from the pill's Open button", () => {
      render(<FloatingMenu />);
      fireEvent.click(screen.getByRole("button", { name: "Open project" }));
      expect(screen.getByTestId("workflow-browser-modal")).toBeInTheDocument();
    });
  });

  describe("revert AI changes", () => {
    beforeEach(() => {
      useState(configuredState({ previousWorkflowSnapshot: { nodes: [], edges: [] } }));
    });

    it("shows a pill button and a menu row while a snapshot exists", () => {
      render(<FloatingMenu />);
      expect(screen.getByRole("button", { name: "Revert AI changes" })).toBeInTheDocument();
      openMenu();
      expect(menuItem("Revert AI changes")).toBeInTheDocument();
    });

    it("reverts after the user confirms", () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<FloatingMenu />);
      fireEvent.click(screen.getByRole("button", { name: "Revert AI changes" }));
      expect(mockRevertToSnapshot).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the user cancels", () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem("Revert AI changes"));
      expect(mockRevertToSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("comments navigation", () => {
    const commentNodes = [{ id: "n1" }, { id: "n2" }, { id: "n3" }];

    beforeEach(() => {
      mockGetNodesWithComments.mockReturnValue(commentNodes);
      useState(configuredState({ viewedCommentNodeIds: new Set(["n1"]) }));
    });

    it("shows the unviewed count on the pill", () => {
      render(<FloatingMenu />);
      const button = screen.getByTitle("2 unviewed comments (3 total)");
      expect(button).toHaveTextContent("2");
    });

    it("jumps to the first unviewed comment and marks it viewed", () => {
      render(<FloatingMenu />);
      fireEvent.click(screen.getByTitle("2 unviewed comments (3 total)"));
      expect(mockMarkCommentViewed).toHaveBeenCalledWith("n2");
      expect(mockSetNavigationTarget).toHaveBeenCalledWith("n2");
    });

    it("offers the same jump as a menu row", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.click(menuItem(/Next comment/));
      expect(mockSetNavigationTarget).toHaveBeenCalledWith("n2");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("caps the badge at 9+", () => {
      mockGetNodesWithComments.mockReturnValue(
        Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }))
      );
      useState(configuredState());
      render(<FloatingMenu />);
      expect(screen.getByTitle("12 unviewed comments (12 total)")).toHaveTextContent("9+");
    });
  });

  describe("keyboard and dismissal", () => {
    it("focuses the first row when opened and moves focus with arrow keys", () => {
      render(<FloatingMenu />);
      openMenu();
      const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
      expect(items[0]).toHaveFocus();

      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
      expect(items[1]).toHaveFocus();

      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
      expect(items[0]).toHaveFocus();

      // Wraps from the first row to the last
      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
      expect(items[items.length - 1]).toHaveFocus();

      fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
      expect(items[0]).toHaveFocus();

      fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
      expect(items[items.length - 1]).toHaveFocus();
    });

    it("closes on Escape and returns focus to the logo", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
    });

    it("closes when Tab leaves the menu", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("closes on a click outside", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("stays open on a click inside", () => {
      render(<FloatingMenu />);
      openMenu();
      fireEvent.mouseDown(screen.getByRole("menu"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });
});
