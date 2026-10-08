"use client";

import { FolderOpen, KeyRound, Keyboard, Layers, LayoutTemplate, LibraryBig, Menu, MessageSquareText, MessagesSquare, Plus, Save, Settings, SquareArrowOutUpRight } from "lucide-react";
import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import { useShallow } from "zustand/shallow";
import { ProjectSetupModal, type SettingsTab } from "./ProjectSetupModal";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WorkflowBrowserModal } from "./WorkflowBrowserModal";
import { KbdGroup } from "@/components/ui/Kbd";
import { MenuDivider, MenuShortcut, MenuSurface, menuItemClass } from "@/components/ui/Menu";
import {
  CHROME_DIVIDER,
  CHROME_ICON_BUTTON,
  CHROME_ICON_BUTTON_OPEN,
  CHROME_ICON_BUTTON_SIZE,
  CHROME_SURFACE,
} from "./chromeStyles";
import { LibraryNotices } from "./LibraryNotices";
import { useSettingsDialogStore } from "@/store/settingsDialogStore";
import { useSaveRequestStore, type SaveReason } from "@/store/saveRequestStore";
import { saveShortcutLabel } from "@/utils/saveShortcut";

/** The bar's buttons are the navigator card's: 32px squircles in a 40px row. */
const ICON_BUTTON = `relative ${CHROME_ICON_BUTTON} ${CHROME_ICON_BUTTON_SIZE.md}`;

const MENU_ROW = `${menuItemClass} whitespace-nowrap [&>svg]:shrink-0 [&>svg]:text-neutral-400`;

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

/** A floppy disk, at the same 1.75 stroke as the Open folder beside it. */
function SaveIcon() {
  return (
    <Save size={16} strokeWidth={1.75} />
  );
}

function OpenIcon() {
  return (
    <FolderOpen size={16} strokeWidth={1.75} />
  );
}

function CommentIcon() {
  return (
    <MessageSquareText size={16} strokeWidth={1.75} />
  );
}

/** Row inside the expanded menu. Renders a link when `href` is given. */
function MenuRow({
  icon,
  label,
  hint,
  shortcut,
  href,
  onClick,
  title,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  /** Keys that open this entry, drawn as caps. */
  shortcut?: string;
  href?: string;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
      {hint && <MenuShortcut>{hint}</MenuShortcut>}
      {shortcut && <KbdGroup keys={shortcut} className="ml-auto pl-3" />}
    </>
  );
  if (href) {
    return (
      <a
        role="menuitem"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={MENU_ROW}
        title={title}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`${MENU_ROW} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
      title={title}
    >
      {content}
    </button>
  );
}

/**
 * Comment navigation, shared by the pill button and the menu row. Subscribes
 * to nodes so the counts follow comments being added, viewed or removed.
 */
function useCommentNavigation() {
  const commentNodeIds = useWorkflowStore(useShallow((state) => state.getNodesWithComments().map((node) => node.id)));
  const viewedCommentNodeIds = useWorkflowStore((state) => state.viewedCommentNodeIds);
  const markCommentViewed = useWorkflowStore((state) => state.markCommentViewed);
  const setNavigationTarget = useWorkflowStore((state) => state.setNavigationTarget);

  const unviewedCount = useMemo(
    () => commentNodeIds.filter((id) => !viewedCommentNodeIds.has(id)).length,
    [commentNodeIds, viewedCommentNodeIds]
  );
  const totalCount = commentNodeIds.length;

  const goToNext = useCallback(() => {
    if (totalCount === 0) return;
    // First unviewed comment, or the first comment once all are viewed
    const targetId =
      commentNodeIds.find((id) => !viewedCommentNodeIds.has(id)) || commentNodeIds[0];
    if (targetId) {
      markCommentViewed(targetId);
      setNavigationTarget(targetId);
    }
  }, [totalCount, commentNodeIds, viewedCommentNodeIds, markCommentViewed, setNavigationTarget]);

  return { totalCount, unviewedCount, goToNext };
}

/**
 * The app's corner chrome: a compact pill anchored top-left over the canvas,
 * under the tab bar, with a menu holding everything the old header offered.
 * The pill is three buttons (menu, open, save) plus the time-sensitive extras
 * (comments) while they apply; the workflow name lives in its tab.
 */
export function FloatingMenu() {
  const {
    workflowName,
    workflowId,
    saveDirectoryPath,
    hasUnsavedChanges,
    lastSavedAt,
    isSaving,
    setWorkflowMetadata,
    saveToFile,
    shortcutsDialogOpen,
    setShortcutsDialogOpen,
    setShowQuickstart,
    activeTabId,
    newTab,
    closeTab,
    openWorkflowInNewTab,
    isRunning,
    pendingMediaSaves,
  } = useWorkflowStore(
    useShallow((state) => ({
      workflowName: state.workflowName,
      workflowId: state.workflowId,
      saveDirectoryPath: state.saveDirectoryPath,
      hasUnsavedChanges: state.hasUnsavedChanges,
      lastSavedAt: state.lastSavedAt,
      isSaving: state.isSaving,
      setWorkflowMetadata: state.setWorkflowMetadata,
      saveToFile: state.saveToFile,
      shortcutsDialogOpen: state.shortcutsDialogOpen,
      setShortcutsDialogOpen: state.setShortcutsDialogOpen,
      setShowQuickstart: state.setShowQuickstart,
      activeTabId: state.activeTabId,
      newTab: state.newTab,
      closeTab: state.closeTab,
      openWorkflowInNewTab: state.openWorkflowInNewTab,
      isRunning: state.isRunning,
      pendingMediaSaves: state.pendingMediaSaves,
    }))
  );

  const { totalCount: commentCount, unviewedCount, goToNext: goToNextComment } =
    useCommentNavigation();

  const [isOpen, setIsOpen] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectModalMode, setProjectModalMode] = useState<"new" | "settings">("new");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("project");
  const [showWorkflowBrowser, setShowWorkflowBrowser] = useState(false);
  // Settings asked for from elsewhere in the app (the first-run hint, the Assets view)
  const settingsRequest = useSettingsDialogStore((state) => state.request);
  const consumeSettingsRequest = useSettingsDialogStore((state) => state.consumeRequest);
  // How many such requests arrived; each one moves an open dialog to its page
  const [settingsRequests, setSettingsRequests] = useState<number | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isProjectConfigured = !!workflowName;
  // The store refuses tab changes mid-run or mid-save; say so instead of asking
  const tabsBusy = isRunning || isSaving || pendingMediaSaves > 0;
  const tabsBusyReason = isRunning
    ? "Wait for the run to finish"
    : isSaving
      ? "Wait for the save to finish"
      : "Wait for the media to finish saving";
  const canSave = !!(workflowId && workflowName && saveDirectoryPath);
  const showUnsavedDot = isProjectConfigured ? hasUnsavedChanges && !isSaving : true;

  const lastSavedText = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  // The pill shows no status text; the tab carries the name and this string goes
  // into the Save tooltip and the menu's Save row: saved, saving, or unsaved
  // with the shortcut that fixes it.
  const shortcut = saveShortcutLabel();
  const saveStatus = !isProjectConfigured
    ? `Not saved · ${shortcut}`
    : isSaving
      ? "Saving..."
      : hasUnsavedChanges
        ? lastSavedText
          ? `Unsaved · last saved ${lastSavedText} · ${shortcut}`
          : `Unsaved changes · ${shortcut}`
        : lastSavedText
          ? `Saved ${lastSavedText}`
          : `Not saved · ${shortcut}`;

  const closeMenu = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  // Outside click and Escape close the menu
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, closeMenu]);

  // Focus the first row whenever the menu opens, so arrow keys work immediately
  useEffect(() => {
    if (!isOpen) return;
    menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
  }, [isOpen]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        next = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case "ArrowUp":
        next = index <= 0 ? items.length - 1 : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      case "Tab":
        // Tab leaves the menu: close it and let the key move on from the toggle
        closeMenu(true);
        return;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  /** Wrap a menu action so choosing it also closes the menu. */
  const choose = (action: () => void) => () => {
    closeMenu();
    action();
  };

  const handleNewProject = () => {
    setProjectModalMode("new");
    setShowProjectModal(true);
  };

  const handleOpenSettings = (tab: SettingsTab = "project") => {
    setProjectModalMode("settings");
    setSettingsTab(tab);
    setShowProjectModal(true);
  };

  // This menu hosts the settings dialog, so it answers requests to open it at
  // a page; the request counter moves an already open dialog there too.
  useEffect(() => {
    if (!settingsRequest) return;
    closeMenu();
    handleOpenSettings(settingsRequest.page);
    setSettingsRequests((count) => (count ?? 0) + 1);
    consumeSettingsRequest();
    // handleOpenSettings only sets state; the request is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRequest]);

  // One save for the button, the menu row, Cmd/Ctrl+S and the desktop's File ›
  // Save: a workflow with a folder saves; one without is asked for a name and
  // location once, then saves.
  const handleSave = (_reason: SaveReason = "button") => {
    if (canSave) {
      void saveToFile({ reason: "manual" });
    } else {
      handleNewProject();
    }
  };

  const saveRequest = useSaveRequestStore((state) => state.request);
  const consumeSaveRequest = useSaveRequestStore((state) => state.consumeRequest);
  useEffect(() => {
    if (!saveRequest) return;
    consumeSaveRequest();
    if (isSaving) return;
    handleSave(saveRequest.reason);
    // The request is the trigger; handleSave reads the latest state when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveRequest]);

  const handleProjectSave = async (id: string, name: string, path: string) => {
    setWorkflowMetadata(id, name, path); // generationsPath is auto-derived
    setShowProjectModal(false);
    // Small delay to let state update
    setTimeout(() => {
      saveToFile().catch((error) => {
        console.error("Failed to save project:", error);
        alert("Failed to save project. Please try again.");
      });
    }, 50);
  };

  const handleOpenDirectory = async () => {
    if (!saveDirectoryPath) return;

    try {
      const response = await fetch("/api/open-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: saveDirectoryPath }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        console.error("Failed to open directory:", result.error);
        alert(`Failed to open project folder: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Failed to open directory:", error);
      alert("Failed to open project folder. Please try again.");
    }
  };

  const saveAction = isSaving ? "Saving..." : "Save project";
  const saveTitle = saveAction === saveStatus ? saveAction : `${saveAction} · ${saveStatus}`;

  const commentTitle = `${unviewedCount} unviewed comment${unviewedCount !== 1 ? "s" : ""} (${commentCount} total)`;
  const commentBadge = unviewedCount > 9 ? "9+" : unviewedCount.toString();

  return (
    <>
      <ProjectSetupModal
        isOpen={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        onSave={handleProjectSave}
        mode={projectModalMode}
        initialTab={settingsTab}
        pageRequest={settingsRequests}
      />
      <LibraryNotices />
      <WorkflowBrowserModal
        isOpen={showWorkflowBrowser}
        onClose={() => setShowWorkflowBrowser(false)}
        onWorkflowLoaded={async (workflow, dirPath) => {
          setShowWorkflowBrowser(false);
          await openWorkflowInNewTab(workflow, dirPath);
        }}
      />

      <div ref={rootRef} className="absolute top-4 left-4 z-50 flex flex-col items-start gap-1.5">
        <div className={`${CHROME_SURFACE} flex h-10 items-center gap-0.5 rounded-xl px-1`}>
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label="Menu"
            title="Menu"
            className={`${ICON_BUTTON} ${isOpen ? CHROME_ICON_BUTTON_OPEN : ""}`}
          >
            <Menu size={16} strokeWidth={1.75} />
          </button>

          <div className={CHROME_DIVIDER} />

          <button
            type="button"
            onClick={() => setShowWorkflowBrowser(true)}
            className={ICON_BUTTON}
            aria-label="Open project"
            title="Open project…"
          >
            <OpenIcon />
          </button>

          <button
            type="button"
            onClick={() => handleSave("button")}
            disabled={isSaving}
            className={ICON_BUTTON}
            aria-label={saveAction}
            title={saveTitle}
            data-tutorial="save-button"
          >
            <SaveIcon />
            {showUnsavedDot && (
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-neutral-800" />
            )}
            {isSaving && (
              <span
                data-testid="saving-dot"
                className="absolute top-1.5 right-1.5 h-2 w-2 animate-pulse rounded-full bg-amber-400 ring-2 ring-neutral-800"
              />
            )}
          </button>

          {commentCount > 0 && <div className={CHROME_DIVIDER} />}

          {commentCount > 0 && (
            <button type="button" onClick={goToNextComment} className={ICON_BUTTON} title={commentTitle}>
              <CommentIcon />
              {unviewedCount > 0 && (
                <span className="absolute top-1 right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold text-white">
                  {commentBadge}
                </span>
              )}
            </button>
          )}
        </div>

        {isOpen && (
          <MenuSurface
            ref={menuRef}
            floating={false}
            role="menu"
            aria-label="Node Banana menu"
            onKeyDown={handleMenuKeyDown}
            className="flex min-w-[224px] flex-col py-1"
          >
            <MenuRow
              icon={<SaveIcon />}
              label="Save project"
              hint={saveStatus}
              onClick={choose(() => handleSave("menu"))}
              title={saveAction}
            />
            <MenuRow
              icon={<OpenIcon />}
              label="Open project…"
              onClick={choose(() => setShowWorkflowBrowser(true))}
              title="Opens in a new tab unless this one is untouched"
            />
            <MenuRow
              icon={
                <LayoutTemplate size={16} strokeWidth={1.75} />
              }
              label="Templates"
              onClick={choose(() => setShowQuickstart(true, "templates"))}
            />
            <MenuRow
              icon={<MessagesSquare size={16} strokeWidth={1.75} />}
              label="Chat"
              shortcut="C"
              onClick={choose(() => useAssetStore.getState().setAppView("chat"))}
              title="The agent, full screen"
            />
            <MenuRow
              icon={<LibraryBig size={16} strokeWidth={1.75} />}
              label="Assets"
              shortcut="A"
              onClick={choose(() => useAssetStore.getState().setAppView("assets"))}
              title="Every generation, from every workflow"
            />
            {saveDirectoryPath && (
              <MenuRow
                icon={
                  <SquareArrowOutUpRight size={16} strokeWidth={1.75} />
                }
                label="Open project folder"
                onClick={choose(handleOpenDirectory)}
              />
            )}
            <MenuRow
              icon={
                <Plus size={16} strokeWidth={2.25} />
              }
              label="New tab"
              onClick={choose(() => newTab())}
              disabled={tabsBusy}
              title={tabsBusy ? tabsBusyReason : undefined}
            />
            <MenuRow
              icon={<span className="h-4 w-4" />}
              label="Close tab"
              onClick={choose(() => {
                if (hasUnsavedChanges && !window.confirm("Close this tab and discard its unsaved changes?")) return;
                closeTab(activeTabId);
              })}
              disabled={tabsBusy}
              title={tabsBusy ? tabsBusyReason : undefined}
            />

            <MenuDivider role="separator" className="my-1" />
            <MenuRow
              icon={
                <Settings size={16} strokeWidth={1.75} />
              }
              label="Project settings"
              onClick={choose(() => handleOpenSettings())}
            />

            <MenuRow
              icon={
                <KeyRound size={16} strokeWidth={1.75} />
              }
              label="API keys"
              onClick={choose(() => handleOpenSettings("providers"))}
              title="Provider keys, in project settings"
            />

            {commentCount > 0 && (
              <MenuDivider role="separator" className="my-1" />
            )}
            {commentCount > 0 && (
              <MenuRow
                icon={<CommentIcon />}
                label="Next comment"
                hint={`${unviewedCount} unviewed`}
                onClick={choose(goToNextComment)}
                title={commentTitle}
              />
            )}

            <MenuDivider role="separator" className="my-1" />
            <MenuRow
              icon={
                <Layers size={16} strokeWidth={1.75} />
              }
              label="Welcome screen"
              onClick={choose(() => setShowQuickstart(true))}
            />
            <MenuRow
              icon={
                <Keyboard size={16} strokeWidth={1.5} />
              }
              label="Keyboard shortcuts"
              shortcut="?"
              onClick={choose(() => setShortcutsDialogOpen(true))}
              title="Keyboard shortcuts (?)"
            />
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              }
              label="Discord"
              hint="↗"
              href="https://discord.com/invite/89Nr6EKkTf"
              title="Support"
            />
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              }
              label="Made by Willie"
              hint="↗"
              href="https://x.com/ReflctWillie"
            />
          </MenuSurface>
        )}
      </div>

      <KeyboardShortcutsDialog
        isOpen={shortcutsDialogOpen}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  );
}
