"use client";

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
import { useShallow } from "zustand/shallow";
import { ProjectSetupModal } from "./ProjectSetupModal";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WorkflowBrowserModal } from "./WorkflowBrowserModal";

const ICON_BUTTON =
  "relative flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";

const MENU_ROW =
  "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-neutral-300 whitespace-nowrap transition-colors hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:bg-neutral-700 focus-visible:text-neutral-100 [&>svg]:shrink-0 [&>svg]:text-neutral-400";

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

function SaveIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
      />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Row inside the expanded menu. Renders a link when `href` is given. */
function MenuRow({
  icon,
  label,
  hint,
  href,
  onClick,
  title,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  href?: string;
  onClick?: () => void;
  title?: string;
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
      {hint && <span className="ml-auto pl-4 text-[11px] text-neutral-500">{hint}</span>}
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
    <button type="button" role="menuitem" onClick={onClick} className={MENU_ROW} title={title}>
      {content}
    </button>
  );
}

/**
 * Comment navigation, shared by the pill button and the menu row. Subscribes
 * to nodes so the counts follow comments being added, viewed or removed.
 */
function useCommentNavigation() {
  const nodes = useWorkflowStore((state) => state.nodes);
  const getNodesWithComments = useWorkflowStore((state) => state.getNodesWithComments);
  const viewedCommentNodeIds = useWorkflowStore((state) => state.viewedCommentNodeIds);
  const markCommentViewed = useWorkflowStore((state) => state.markCommentViewed);
  const setNavigationTarget = useWorkflowStore((state) => state.setNavigationTarget);

  // `nodes` is a dependency on purpose: it is what changes when comments do
  const nodesWithComments = useMemo(() => getNodesWithComments(), [getNodesWithComments, nodes]);
  const unviewedCount = useMemo(
    () => nodesWithComments.filter((node) => !viewedCommentNodeIds.has(node.id)).length,
    [nodesWithComments, viewedCommentNodeIds]
  );
  const totalCount = nodesWithComments.length;

  const goToNext = useCallback(() => {
    if (totalCount === 0) return;
    // First unviewed comment, or the first comment once all are viewed
    const targetNode =
      nodesWithComments.find((node) => !viewedCommentNodeIds.has(node.id)) || nodesWithComments[0];
    if (targetNode) {
      markCommentViewed(targetNode.id);
      setNavigationTarget(targetNode.id);
    }
  }, [totalCount, nodesWithComments, viewedCommentNodeIds, markCommentViewed, setNavigationTarget]);

  return { totalCount, unviewedCount, goToNext };
}

/**
 * The app's corner chrome: a compact pill anchored top-left over the canvas,
 * under the tab bar, with a menu holding everything the old header offered.
 * The pill is three buttons (menu, open, save) plus the time-sensitive extras
 * (comments, revert) while they apply; the workflow name lives in its tab.
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
    previousWorkflowSnapshot,
    revertToSnapshot,
    shortcutsDialogOpen,
    setShortcutsDialogOpen,
    setShowQuickstart,
    activeTabId,
    newTab,
    closeTab,
    openWorkflowInNewTab,
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
      previousWorkflowSnapshot: state.previousWorkflowSnapshot,
      revertToSnapshot: state.revertToSnapshot,
      shortcutsDialogOpen: state.shortcutsDialogOpen,
      setShortcutsDialogOpen: state.setShortcutsDialogOpen,
      setShowQuickstart: state.setShowQuickstart,
      activeTabId: state.activeTabId,
      newTab: state.newTab,
      closeTab: state.closeTab,
      openWorkflowInNewTab: state.openWorkflowInNewTab,
    }))
  );

  const { totalCount: commentCount, unviewedCount, goToNext: goToNextComment } =
    useCommentNavigation();

  const [isOpen, setIsOpen] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectModalMode, setProjectModalMode] = useState<"new" | "settings">("new");
  const [showWorkflowBrowser, setShowWorkflowBrowser] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isProjectConfigured = !!workflowName;
  const canSave = !!(workflowId && workflowName && saveDirectoryPath);
  const showUnsavedDot = isProjectConfigured ? hasUnsavedChanges && !isSaving : true;

  const lastSavedText = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  // The pill shows no status text; the tab carries the name and this string goes
  // into the Save tooltip and the menu's Save row.
  const saveStatus = !isProjectConfigured
    ? "Not saved"
    : isSaving
      ? "Saving..."
      : hasUnsavedChanges
        ? lastSavedText
          ? `Unsaved · last saved ${lastSavedText}`
          : "Unsaved"
        : lastSavedText
          ? `Saved ${lastSavedText}`
          : "Not saved";

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

  const handleOpenSettings = () => {
    setProjectModalMode("settings");
    setShowProjectModal(true);
  };

  const handleSave = () => {
    if (!isProjectConfigured) {
      handleNewProject();
    } else if (canSave) {
      saveToFile();
    } else {
      handleOpenSettings();
    }
  };

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

  const handleRevertAIChanges = useCallback(() => {
    const confirmed = window.confirm("Are you sure? This will restore your previous workflow.");
    if (confirmed) {
      revertToSnapshot();
    }
  }, [revertToSnapshot]);

  const saveAction = !isProjectConfigured
    ? "Save project"
    : isSaving
      ? "Saving..."
      : canSave
        ? "Save project"
        : "Configure save location";
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
      />
      <WorkflowBrowserModal
        isOpen={showWorkflowBrowser}
        onClose={() => setShowWorkflowBrowser(false)}
        onWorkflowLoaded={async (workflow, dirPath) => {
          setShowWorkflowBrowser(false);
          await openWorkflowInNewTab(workflow, dirPath);
        }}
      />

      <div ref={rootRef} className="absolute top-4 left-4 z-50 flex flex-col items-start gap-1.5">
        <div className="flex h-8 items-center gap-0.5 rounded-lg border border-neutral-700/80 bg-neutral-800/95 px-1 shadow-lg">
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label="Menu"
            title="Menu"
            className={`${ICON_BUTTON} w-auto gap-0.5 px-1 ${isOpen ? "bg-neutral-700 text-neutral-100" : ""}`}
          >
            <img src="/banana_icon.png" alt="" className="h-[18px] w-[18px]" />
            <svg
              className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.25}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
          </button>

          <div className="mx-1 h-5 w-px bg-neutral-600" />

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
            onClick={handleSave}
            disabled={isSaving}
            className={ICON_BUTTON}
            aria-label={saveAction}
            title={saveTitle}
            data-tutorial="save-button"
          >
            <SaveIcon />
            {showUnsavedDot && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-neutral-800" />
            )}
          </button>

          {(commentCount > 0 || previousWorkflowSnapshot) && <div className="mx-1 h-5 w-px bg-neutral-600" />}

          {commentCount > 0 && (
            <button type="button" onClick={goToNextComment} className={ICON_BUTTON} title={commentTitle}>
              <CommentIcon />
              {unviewedCount > 0 && (
                <span className="absolute top-0.5 right-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold text-white">
                  {commentBadge}
                </span>
              )}
            </button>
          )}

          {previousWorkflowSnapshot && (
            <button
              type="button"
              onClick={handleRevertAIChanges}
              className="ml-0.5 h-6 whitespace-nowrap rounded border border-neutral-600 bg-neutral-700/50 px-2 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              title="Restore workflow from before AI changes"
            >
              Revert AI changes
            </button>
          )}
        </div>

        {isOpen && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Node Banana menu"
            onKeyDown={handleMenuKeyDown}
            className="flex min-w-[224px] flex-col rounded-lg border border-neutral-600 bg-neutral-800 p-1 shadow-xl"
          >
            <MenuRow
              icon={<SaveIcon />}
              label="Save project"
              hint={saveStatus}
              onClick={choose(handleSave)}
              title={saveAction}
            />
            <MenuRow
              icon={<OpenIcon />}
              label="Open project…"
              onClick={choose(() => setShowWorkflowBrowser(true))}
              title="Opens in a new tab unless this one is untouched"
            />
            {saveDirectoryPath && (
              <MenuRow
                icon={
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                    />
                  </svg>
                }
                label="Open project folder"
                onClick={choose(handleOpenDirectory)}
              />
            )}
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              }
              label="Project settings"
              onClick={choose(handleOpenSettings)}
            />

            <div role="separator" className="my-1 h-px bg-neutral-700/60" />
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
                  <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                </svg>
              }
              label="New tab"
              onClick={choose(() => newTab())}
            />
            <MenuRow
              icon={<span className="h-4 w-4" />}
              label="Close tab"
              onClick={choose(() => {
                if (hasUnsavedChanges && !window.confirm("Close this tab and discard its unsaved changes?")) return;
                closeTab(activeTabId);
              })}
            />

            {(previousWorkflowSnapshot || commentCount > 0) && (
              <div role="separator" className="my-1 h-px bg-neutral-700/60" />
            )}
            {previousWorkflowSnapshot && (
              <MenuRow
                icon={
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
                  </svg>
                }
                label="Revert AI changes"
                onClick={choose(handleRevertAIChanges)}
                title="Restore workflow from before AI changes"
              />
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

            <div role="separator" className="my-1 h-px bg-neutral-700/60" />
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 6-9 6-9-6 9-6ZM3 15l9 6 9-6" />
                </svg>
              }
              label="Welcome screen"
              onClick={choose(() => setShowQuickstart(true))}
            />
            <MenuRow
              icon={
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.25 6.75A2.25 2.25 0 014.5 4.5h15a2.25 2.25 0 012.25 2.25v10.5A2.25 2.25 0 0119.5 19.5h-15a2.25 2.25 0 01-2.25-2.25V6.75z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"
                  />
                </svg>
              }
              label="Keyboard shortcuts"
              hint="?"
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
          </div>
        )}
      </div>

      <KeyboardShortcutsDialog
        isOpen={shortcutsDialogOpen}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  );
}
