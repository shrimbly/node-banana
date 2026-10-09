"use client";

import { DesktopSession } from "@/components/DesktopSession";
import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { FloatingMenu } from "@/components/FloatingMenu";
import { WorkflowTabs } from "@/components/WorkflowTabs";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { FloatingActionBar } from "@/components/FloatingActionBar";
import { AnnotationModal } from "@/components/AnnotationModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useWorkflowStore } from "@/store/workflowStore";
import { FTUXModal } from "@/components/onboarding/FTUXModal";
import { getFTUXCompleted, setFTUXCompleted } from "@/store/utils/localStorage";
import { useFTUXStore } from "@/store/ftuxStore";
import { anyWorkflowTabUnsaved } from "@/store/utils/workflowTabs";
import { requestSave } from "@/store/saveRequestStore";
import { useAssetStore } from "@/store/assetStore";
import { AssetsView } from "@/components/assets/AssetsView";
import { AgentSessionProvider } from "@/components/agent/AgentSession";
import { clearGenerationToasts } from "@/components/GenerationToast";
import { watchFirstRecording } from "@/components/assets/FirstRunHint";
import { unloadWarning } from "@/components/assets/unloadWarning";
import { initAssetLibrary, pendingRecordings } from "@/lib/assets/client/recorder";
import { fetchLibraryStatus, reportProjects } from "@/lib/assets/client/api";
import { watchMovedProjects } from "@/lib/assets/client/movedProjects";
import { collectProjectReport } from "@/lib/assets/client/projects";

// Loaded on first show, as the floating agent window is: the transcript's markdown and code
// highlighting, the run cards and the sidebar stay out of the page for people who never open
// it. Until then, the empty page the view paints on.
const AgentChatView = dynamic(() => import("@/components/agent/AgentChatView").then((mod) => ({ default: mod.AgentChatView })), {
  ssr: false,
  loading: () => <div className="flex-1 bg-canvas-bg" />,
});

export default function Home() {
  return <DesktopSession><Editor /></DesktopSession>;
}

/** One library init per page load, however often the effect below runs (Strict Mode runs it twice). */
let libraryInit: ReturnType<typeof initAssetLibrary> | null = null;
/** The projects this page's localStorage remembers go to the server once per page load. */
let projectsReport: Promise<void> | null = null;

/**
 * Sends the report once the library is known to work. When the server
 * adopted the old workflows folder as the Node Banana folder, the status
 * the page holds is stale, so it is asked for again.
 */
function reportProjectsOnce(): Promise<void> {
  projectsReport ??= reportProjects(collectProjectReport())
    .then(async (result) => {
      if (result.adopted) useAssetStore.getState().setLibrary(await fetchLibraryStatus());
    })
    .catch((error) => console.warn("Couldn't report projects to the asset library:", error));
  return projectsReport;
}

function Editor() {
  const initializeAutoSave = useWorkflowStore(
    (state) => state.initializeAutoSave
  );
  const cleanupAutoSave = useWorkflowStore((state) => state.cleanupAutoSave);
  const setShowQuickstart = useWorkflowStore((state) => state.setShowQuickstart);
  const [showFTUX, setShowFTUX] = useState(false);
  const appView = useAssetStore((state) => state.appView);
  // Assets or the full-page chat is over the canvas
  const canvasCovered = appView !== "canvas";

  useEffect(() => {
    initializeAutoSave();
    return () => cleanupAutoSave();
  }, [initializeAutoSave, cleanupAutoSave]);

  // File › Save in the desktop app's menu (Cmd/Ctrl+S wherever focus is)
  useEffect(() => window.nodeBananaDesktop?.onSaveRequest?.(() => requestSave("desktop")), []);

  // The asset library: ask the server where it is (recording stays off until
  // it answers that it is available), and say once where the first asset went
  useEffect(() => {
    let cancelled = false;
    let stopHint = () => {};
    libraryInit ??= initAssetLibrary();
    libraryInit
      .then((status) => {
        if (cancelled) return;
        useAssetStore.getState().setLibrary(status);
        // A projects move (from any screen) repoints the open canvas and saved configs at the new folders
        watchMovedProjects(status);
        stopHint = watchFirstRecording(status);
        if (status?.available) void reportProjectsOnce();
      })
      .catch((error) => console.warn("Asset library unavailable:", error));
    return () => {
      cancelled = true;
      stopHint();
    };
  }, []);

  // While another view shows, the canvas behind counts as covered: React
  // Flow's delete, pan and selection stay off (its key handler has its own
  // guard), and the generation cards hanging under its history button go
  useEffect(() => {
    if (!canvasCovered) return;
    clearGenerationToasts();
    useWorkflowStore.getState().incrementModalCount();
    return () => useWorkflowStore.getState().decrementModalCount();
  }, [canvasCovered]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const { tabs, hasUnsavedChanges } = useWorkflowStore.getState();
      // Unsaved tabs, or generations still on their way to the library, each said as what it is
      const warning = unloadWarning({
        unsavedTabs: anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges }),
        pendingRecordings: pendingRecordings(),
      });
      if (warning) {
        e.preventDefault();
        // Browsers show their own words; this is the reason for anything that reads it
        e.returnValue = warning;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Client-side only FTUX check (SSR-safe)
  useEffect(() => {
    if (!getFTUXCompleted()) {
      setShowFTUX(true);
    }
  }, []);

  const handleFTUXComplete = () => {
    setShowFTUX(false);
    setFTUXCompleted(true);
  };

  const handleStartTutorial = () => {
    setShowFTUX(false);
    setFTUXCompleted(true);
    setShowQuickstart(false); // Close WelcomeModal if open
    useFTUXStore.getState().startTutorial();
  };

  return (
    <ReactFlowProvider>
      {/* One agent conversation for the floating window and the full-page chat */}
      <AgentSessionProvider>
      <div className="h-screen flex flex-col bg-[#0f0f0f]">
        <WorkflowTabs />
        {/* The floating menu is positioned against this box, so it clears the tab
            strip. The box is the canvas frame: rounded top corners the active tab
            flows into. It must not isolate its stacking: modals and menus inside
            it are fixed and have to cover the strip too. */}
        <div className="workflow-canvas-frame relative mx-1 mb-1 flex-1 min-h-0 flex flex-col overflow-hidden rounded-t-lg border border-card-border bg-canvas-bg">
        {/* The canvas stays mounted under the Assets and chat views (React Flow
            keeps measuring, a run or an agent turn keeps going), but inert and
            invisible, which also hides its fixed floaters */}
        <div className={`flex min-h-0 flex-1 flex-col ${canvasCovered ? "invisible" : ""}`} inert={canvasCovered}>
        <ErrorBoundary
          label="Canvas"
          onError={(error, info) =>
            console.error("Canvas crashed:", error, info)
          }
          fallback={(error, reset) => (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="text-sm font-semibold text-red-400">
                The canvas hit an unexpected error
              </div>
              <div className="text-xs text-neutral-400 max-w-md break-words">
                {error.message || "Unexpected render error"}
              </div>
              <div className="text-xs text-neutral-500 max-w-md">
                Your workflow is still in memory. Try recovering the canvas, or
                reload the page.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={reset}
                  className="px-3 py-1.5 text-xs rounded-md border border-red-500 text-red-300 hover:bg-red-500/10"
                >
                  Try to recover
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="px-3 py-1.5 text-xs rounded-md border border-neutral-600 text-neutral-300 hover:bg-neutral-700/40"
                >
                  Reload page
                </button>
              </div>
            </div>
          )}
        >
          <WorkflowCanvas />
        </ErrorBoundary>
        </div>
        {/* Hidden, not unmounted, while another view shows: it hosts the
            settings and shortcuts dialogs, which render inline and must still
            open from there. Only its own chrome hides; an open dialog's overlay stays. */}
        <div className={canvasCovered ? "contents [&>:not([data-dialog-overlay])]:hidden" : "contents"}>
          <FloatingMenu />
        </div>
        {appView === "assets" && (
          <CoveringView
            label="Assets"
            title="The Assets view hit an unexpected error"
            note="Your files and workflows are not affected."
          >
            <AssetsView />
          </CoveringView>
        )}
        {appView === "chat" && (
          <CoveringView
            label="Chat"
            title="The chat hit an unexpected error"
            note="Your conversations and workflows are not affected."
          >
            <AgentChatView />
          </CoveringView>
        )}
        </div>
        <div hidden={canvasCovered} inert={canvasCovered}>
          <FloatingActionBar />
        </div>
        <AnnotationModal />
        {showFTUX && (
          <FTUXModal
            onComplete={handleFTUXComplete}
            onStartTutorial={handleStartTutorial}
          />
        )}
      </div>
      </AgentSessionProvider>
    </ReactFlowProvider>
  );
}

/**
 * A view laid over the canvas inside its frame (Assets, the full-page chat).
 * If it crashes, the fallback offers it again or the way back to the canvas.
 */
function CoveringView({ label, title, note, children }: { label: string; title: string; note: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-[60] flex">
      <ErrorBoundary
        label={label}
        onError={(error, info) => console.error(`${label} view crashed:`, error, info)}
        fallback={(error, reset) => (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas-bg p-6 text-center">
            <div className="text-sm font-semibold text-red-400">{title}</div>
            <div className="max-w-md break-words text-xs text-neutral-400">{error.message || "Unexpected render error"}</div>
            <div className="text-xs text-neutral-500">{note}</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700/40"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => useAssetStore.getState().setAppView("canvas")}
                className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700/40"
              >
                Back to canvas
              </button>
            </div>
          </div>
        )}
      >
        {children}
      </ErrorBoundary>
    </div>
  );
}
