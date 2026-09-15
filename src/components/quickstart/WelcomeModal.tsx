"use client";

import { Dialog } from "@/components/ui/Dialog";
import { useState, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { PromptWorkflowView } from "./PromptWorkflowView";
import { WorkflowBrowserView } from "./WorkflowBrowserView";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile, directoryPath?: string) => void;
  onClose: () => void;
  onNewProject: () => void;
}

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>("initial");

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleSelectTemplates = useCallback(() => {
    setCurrentView("templates");
  }, []);

  const handleSelectVibe = useCallback(() => {
    setCurrentView("vibe");
  }, []);

  const handleSelectLoad = useCallback(() => {
    setCurrentView("browse");
  }, []);

  const handleBack = useCallback(() => {
    setCurrentView("initial");
  }, []);

  const handleWorkflowSelected = useCallback(
    (workflow: WorkflowFile) => {
      onWorkflowGenerated(workflow);
    },
    [onWorkflowGenerated]
  );

  // Template explorer needs more width for two-column layout
  const dialogWidth = currentView === "templates" ? "max-w-6xl" : "max-w-2xl";
  const dialogHeight = currentView === "templates" || currentView === "browse" ? "max-h-[85vh]" : "max-h-[80vh]";

  return (
    <Dialog open onClose={onClose} label="Welcome" className={`w-full ${dialogWidth} ${dialogHeight}`}>
        {currentView === "initial" && (
          <QuickstartInitialView
            onNewProject={handleNewProject}
            onSelectTemplates={handleSelectTemplates}
            onSelectVibe={handleSelectVibe}
            onSelectLoad={handleSelectLoad}
          />
        )}
        {currentView === "templates" && (
          <TemplateExplorerView
            onBack={handleBack}
            onWorkflowSelected={handleWorkflowSelected}
          />
        )}
        {currentView === "vibe" && (
          <PromptWorkflowView
            onBack={handleBack}
            onWorkflowGenerated={handleWorkflowSelected}
          />
        )}
        {currentView === "browse" && (
          <WorkflowBrowserView
            onBack={handleBack}
            onWorkflowLoaded={(workflow, dirPath) =>
              onWorkflowGenerated(workflow, dirPath)
            }
            onClose={onClose}
          />
        )}
    </Dialog>
  );
}
