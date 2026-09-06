"use client";

import { useEffect, useState } from "react";
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

export default function Home() {
  const initializeAutoSave = useWorkflowStore(
    (state) => state.initializeAutoSave
  );
  const cleanupAutoSave = useWorkflowStore((state) => state.cleanupAutoSave);
  const setShowQuickstart = useWorkflowStore((state) => state.setShowQuickstart);
  const [showFTUX, setShowFTUX] = useState(false);

  useEffect(() => {
    initializeAutoSave();
    return () => cleanupAutoSave();
  }, [initializeAutoSave, cleanupAutoSave]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const { tabs, hasUnsavedChanges } = useWorkflowStore.getState();
      if (anyWorkflowTabUnsaved(tabs, { hasUnsavedChanges })) {
        e.preventDefault();
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
      <div className="h-screen flex flex-col bg-[#0f0f0f]">
        <WorkflowTabs />
        {/* The floating menu is positioned against this box, so it clears the tab
            strip. The box is the canvas frame: rounded top corners the active tab
            flows into. It must not isolate its stacking: modals and menus inside
            it are fixed and have to cover the strip too. */}
        <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-t-md border border-card-border bg-canvas-bg">
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
        <FloatingMenu />
        </div>
        <FloatingActionBar />
        <AnnotationModal />
        {showFTUX && (
          <FTUXModal
            onComplete={handleFTUXComplete}
            onStartTutorial={handleStartTutorial}
          />
        )}
      </div>
    </ReactFlowProvider>
  );
}
