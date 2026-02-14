"use client";

import { useState, useRef, useMemo, useCallback } from "react";
import { useWorkflowStore, WorkflowFile } from "@/store/workflowStore";
import { ProjectSetupModal } from "./ProjectSetupModal";
import { CostIndicator } from "./CostIndicator";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

function CommentsNavigationIcon() {
  // Subscribe to nodes so we re-render when comments change
  const nodes = useWorkflowStore((state) => state.nodes);
  const getNodesWithComments = useWorkflowStore((state) => state.getNodesWithComments);
  const viewedCommentNodeIds = useWorkflowStore((state) => state.viewedCommentNodeIds);
  const markCommentViewed = useWorkflowStore((state) => state.markCommentViewed);
  const setNavigationTarget = useWorkflowStore((state) => state.setNavigationTarget);

  // Recalculate when nodes change (nodes in dependency triggers re-render)
  const nodesWithComments = useMemo(() => getNodesWithComments(), [getNodesWithComments, nodes]);
  const unviewedCount = useMemo(() => {
    return nodesWithComments.filter((node) => !viewedCommentNodeIds.has(node.id)).length;
  }, [nodesWithComments, viewedCommentNodeIds]);
  const totalCount = nodesWithComments.length;

  const handleClick = useCallback(() => {
    if (totalCount === 0) return;

    // Find first unviewed comment, or first comment if all viewed
    const targetNode = nodesWithComments.find((node) => !viewedCommentNodeIds.has(node.id)) || nodesWithComments[0];
    if (targetNode) {
      markCommentViewed(targetNode.id);
      setNavigationTarget(targetNode.id);
    }
  }, [totalCount, nodesWithComments, viewedCommentNodeIds, markCommentViewed, setNavigationTarget]);

  // Don't render if no comments
  if (totalCount === 0) {
    return null;
  }

  const displayCount = unviewedCount > 9 ? "9+" : unviewedCount.toString();

  return (
    <button
      onClick={handleClick}
      className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
      title={`${unviewedCount} unviewed comment${unviewedCount !== 1 ? 's' : ''} (${totalCount} total)`}
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
      </svg>
      {unviewedCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold text-white bg-blue-500 rounded-full px-0.5">
          {displayCount}
        </span>
      )}
    </button>
  );
}

export function Header() {
  const {
    workflowName,
    workflowId,
    saveDirectoryPath,
    hasUnsavedChanges,
    lastSavedAt,
    isSaving,
    setWorkflowMetadata,
    saveToFile,
    loadWorkflow,
    previousWorkflowSnapshot,
    revertToSnapshot,
    shortcutsDialogOpen,
    setShortcutsDialogOpen,
  } = useWorkflowStore();

  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectModalMode, setProjectModalMode] = useState<"new" | "settings">("new");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isProjectConfigured = !!workflowName;
  const canSave = !!(workflowId && workflowName && saveDirectoryPath);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const handleNewProject = () => {
    setProjectModalMode("new");
    setShowProjectModal(true);
  };

  const handleOpenSettings = () => {
    setProjectModalMode("settings");
    setShowProjectModal(true);
  };

  const handleOpenFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const workflow = JSON.parse(event.target?.result as string) as WorkflowFile;
        if (workflow.version && workflow.nodes && workflow.edges) {
          await loadWorkflow(workflow);
        } else {
          alert("Invalid workflow file format");
        }
      } catch {
        alert("Failed to parse workflow file");
      }
    };
    reader.readAsText(file);

    // Reset input so same file can be loaded again
    e.target.value = "";
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: saveDirectoryPath }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        console.error("Failed to open directory:", result.error);
        alert(`Failed to open project folder: ${result.error || "Unknown error"}`);
        return;
      }
    } catch (error) {
      console.error("Failed to open directory:", error);
      alert("Failed to open project folder. Please try again.");
    }
  };

  const handleRevertAIChanges = useCallback(() => {
    const confirmed = window.confirm(
      "Are you sure? This will restore your previous workflow."
    );
    if (confirmed) {
      revertToSnapshot();
    }
  }, [revertToSnapshot]);

  const settingsButtons = (
    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-neutral-700/50">
      <button
        onClick={handleOpenSettings}
        className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
        title="Project settings"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      <ProjectSetupModal
        isOpen={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        onSave={handleProjectSave}
        mode={projectModalMode}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
      />
      <header className="h-11 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <img src="/banana_icon.png" alt="Banana" className="w-6 h-6" />
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">
            Node Banana
          </h1>

          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-neutral-700">
            {isProjectConfigured ? (
              <>
                <span className="text-sm text-neutral-300">{workflowName}</span>
                <span className="text-neutral-600">|</span>
                <CostIndicator />

                {/* File operations group */}
                <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-neutral-700/50">
                  <button
                    onClick={() => canSave ? saveToFile() : handleOpenSettings()}
                    disabled={isSaving}
                    className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors disabled:opacity-50"
                    title={isSaving ? "Saving..." : canSave ? "Save project" : "Configure save location"}
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    {hasUnsavedChanges && !isSaving && (
                      <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-neutral-900" />
                    )}
                  </button>
                  {saveDirectoryPath && (
                    <button
                      onClick={handleOpenDirectory}
                      className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                      title="Open Project Folder"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                        />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={handleOpenFile}
                    className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Open project"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                      />
                    </svg>
                  </button>
                </div>

                {settingsButtons}
              </>
            ) : (
              <>
                <span className="text-sm text-neutral-500 italic">Untitled</span>

                {/* File operations group */}
                <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-neutral-700/50">
                  <button
                    onClick={handleNewProject}
                    className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Save project"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-neutral-900" />
                  </button>
                  <button
                    onClick={handleOpenFile}
                    className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Open project"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                      />
                    </svg>
                  </button>
                </div>

                {settingsButtons}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {previousWorkflowSnapshot && (
            <button
              onClick={handleRevertAIChanges}
              className="px-2.5 py-1.5 text-xs text-neutral-300 hover:text-neutral-100 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600 rounded transition-colors"
              title="Restore workflow from before AI changes"
            >
              Revert AI Changes
            </button>
          )}
          <CommentsNavigationIcon />
          <span className="text-neutral-400">
            {isProjectConfigured ? (
              isSaving ? (
                "Saving..."
              ) : lastSavedAt ? (
                `Saved ${formatTime(lastSavedAt)}`
              ) : (
                "Not saved"
              )
            ) : (
              "Not saved"
            )}
          </span>
          <span className="text-neutral-500">·</span>
          <a
            href="https://x.com/ReflctWillie"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            Made by Willie
          </a>
          <span className="text-neutral-500">·</span>
          <button
            onClick={() => setShortcutsDialogOpen(true)}
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
            title="Keyboard shortcuts (?)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75A2.25 2.25 0 014.5 4.5h15a2.25 2.25 0 012.25 2.25v10.5A2.25 2.25 0 0119.5 19.5h-15a2.25 2.25 0 01-2.25-2.25V6.75z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
          </button>
          <span className="text-neutral-500">·</span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
            title="Support"
          >
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
          </a>
        </div>
      </header>
      <KeyboardShortcutsDialog
        isOpen={shortcutsDialogOpen}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  );
}
