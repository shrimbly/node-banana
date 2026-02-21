"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import { useWorkflowStore, WorkflowFile } from "@/store/workflowStore";
import { getAllProjectsForDashboard } from "@/store/utils/localStorage";
import { ProjectCard } from "./ProjectCard";
import { TemplateExplorerView } from "../quickstart/TemplateExplorerView";
import { PromptWorkflowView } from "../quickstart/PromptWorkflowView";

type DashboardView = "main" | "templates" | "vibe";

export function ProjectDashboard() {
  const {
    workflowId: currentWorkflowId,
    hasUnsavedChanges,
    setShowDashboard,
    openProject,
    deleteProject,
    loadWorkflow,
    setShowQuickstart,
  } = useWorkflowStore();

  const [view, setView] = useState<DashboardView>("main");
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(
    () => getAllProjectsForDashboard(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey]
  );

  const confirmUnsavedChanges = useCallback((): boolean => {
    if (!hasUnsavedChanges) return true;
    return window.confirm(
      "You have unsaved changes. Are you sure you want to switch projects? Your unsaved changes will be lost."
    );
  }, [hasUnsavedChanges]);

  const handleOpenProject = useCallback(
    async (wfId: string) => {
      if (wfId === currentWorkflowId) {
        setShowDashboard(false);
        return;
      }
      if (!confirmUnsavedChanges()) return;
      await openProject(wfId);
    },
    [currentWorkflowId, confirmUnsavedChanges, openProject, setShowDashboard]
  );

  const handleDeleteProject = useCallback(
    (wfId: string) => {
      deleteProject(wfId);
      setRefreshKey((k) => k + 1);
    },
    [deleteProject]
  );

  const handleNewProject = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    setShowDashboard(false);
    setShowQuickstart(false);
    useWorkflowStore.getState().clearWorkflow();
    window.dispatchEvent(new CustomEvent("dashboard:new-project"));
  }, [confirmUnsavedChanges, setShowDashboard, setShowQuickstart]);

  const handleLoadFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!confirmUnsavedChanges()) {
        e.target.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const workflow = JSON.parse(event.target?.result as string) as WorkflowFile;
          if (workflow.version && workflow.nodes && workflow.edges) {
            await loadWorkflow(workflow);
            setShowDashboard(false);
          } else {
            alert("Invalid workflow file format");
          }
        } catch {
          alert("Failed to parse workflow file");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [confirmUnsavedChanges, loadWorkflow, setShowDashboard]
  );

  const handleWorkflowGenerated = useCallback(
    async (workflow: WorkflowFile) => {
      await loadWorkflow(workflow);
      setShowDashboard(false);
    },
    [loadWorkflow, setShowDashboard]
  );

  const dialogWidth = view === "templates" ? "max-w-6xl" : "max-w-5xl";
  const dialogHeight = view === "templates" ? "max-h-[85vh]" : "max-h-[85vh]";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div
        className={`w-full ${dialogWidth} mx-4 bg-neutral-850 rounded-2xl border border-neutral-700/80 shadow-2xl overflow-clip ${dialogHeight} flex flex-col`}
        style={{ backgroundColor: "rgb(28, 28, 30)" }}
      >
        {view === "templates" && (
          <TemplateExplorerView
            onBack={() => setView("main")}
            onWorkflowSelected={handleWorkflowGenerated}
          />
        )}
        {view === "vibe" && (
          <PromptWorkflowView
            onBack={() => setView("main")}
            onWorkflowGenerated={handleWorkflowGenerated}
          />
        )}
        {view === "main" && (
          <div className="flex h-full max-h-[85vh]">
            {/* Left column — Branding + links */}
            <div className="w-64 flex-shrink-0 flex flex-col p-8 border-r border-neutral-700/40 bg-neutral-900/40">
              <div className="mb-5">
                <div className="flex items-center gap-2.5">
                  <img src="/banana_icon.png" alt="" className="w-8 h-8" />
                  <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">
                    Node Banana
                  </h1>
                </div>
              </div>
              <p className="text-sm text-neutral-400 leading-relaxed mb-8">
                A node based workflow editor for AI image generation. Connect nodes to build pipelines.
              </p>

              {/* Quick stats */}
              {projects.length > 0 && (
                <div className="mb-8 p-3.5 rounded-lg bg-neutral-800/50 border border-neutral-700/30">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-lg font-semibold text-neutral-200">{projects.length}</p>
                      <p className="text-[11px] text-neutral-500">Projects</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-neutral-200">
                        {projects.reduce((sum, p) => sum + (p.nodeCount ?? 0), 0)}
                      </p>
                      <p className="text-[11px] text-neutral-500">Total Nodes</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3 mt-auto">
                <a
                  href="https://node-banana-docs.vercel.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                  </svg>
                  Documentation
                </a>
                <a
                  href="https://discord.com/invite/89Nr6EKkTf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z" />
                  </svg>
                  Discord Community
                </a>
                <a
                  href="https://x.com/ReflctWillie"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  Made by Willie
                </a>
              </div>
            </div>

            {/* Right column — Projects + actions */}
            <div className="flex-1 flex flex-col min-w-0 p-8">
              {/* Header with title + close */}
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-medium text-neutral-200">Your Projects</h2>
                {currentWorkflowId && (
                  <button
                    onClick={() => setShowDashboard(false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-800/50 hover:bg-neutral-700/50 border border-neutral-700/50 rounded-lg transition-colors"
                    title="Return to current project"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                    </svg>
                    Back to project
                  </button>
                )}
              </div>

              {/* Action buttons row */}
              <div className="flex items-center gap-2 mb-5">
                <button
                  onClick={handleNewProject}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neutral-100 bg-blue-600/90 hover:bg-blue-600 rounded-lg transition-colors shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  New Project
                </button>
                <button
                  onClick={handleLoadFile}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100 bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/50 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                  </svg>
                  Load File
                </button>
                <div className="w-px h-5 bg-neutral-700/50 mx-1" />
                <button
                  onClick={() => setView("templates")}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100 bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/50 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                  </svg>
                  Templates
                </button>
                <button
                  onClick={() => setView("vibe")}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100 bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/50 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                  </svg>
                  Prompt
                  <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/20">
                    Beta
                  </span>
                </button>
              </div>

              {/* Projects list */}
              <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
                {projects.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-16">
                    <div className="w-16 h-16 rounded-2xl bg-neutral-800/50 border border-neutral-700/30 flex items-center justify-center mb-4">
                      <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-neutral-300 mb-1.5">No projects yet</p>
                    <p className="text-xs text-neutral-500 max-w-xs leading-relaxed">
                      Create a new project, load an existing workflow file, or start from a template to get going.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {projects.map((project) => (
                      <ProjectCard
                        key={project.workflowId}
                        project={project}
                        isCurrent={project.workflowId === currentWorkflowId}
                        onOpen={handleOpenProject}
                        onDelete={handleDeleteProject}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hidden file input for loading workflows */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json"
        className="hidden"
      />
    </div>
  );
}
