"use client";

import { Dialog, splitPanelClass } from "@/components/ui/Dialog";
import { useState, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { PromptWorkflowView } from "./PromptWorkflowView";
import { WorkflowBrowserView } from "./WorkflowBrowserView";
import { cn } from "@/components/nodes/ui/cn";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile, directoryPath?: string) => void;
  onClose: () => void;
  onNewProject: () => void;
  /** View to open on; the menu's Templates entry passes "templates". */
  initialView?: QuickstartView;
}

/**
 * The welcome dialog is a split dialog: every view keeps the dark pane on
 * the left and swaps what it carries (the identity, the template filters,
 * the folder). Sizes are the design canvas's: 820×470 for the initial,
 * prompt and browse views, 1000×620 for the template explorer.
 */
const VIEW_SIZE: Record<QuickstartView, string> = {
  initial: "w-[820px] h-[470px]",
  vibe: "w-[820px] h-[470px]",
  browse: "w-[820px] h-[470px]",
  templates: "w-[1000px] h-[620px]",
};

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
  initialView = "initial",
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>(initialView);

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

  return (
    <Dialog
      open
      onClose={onClose}
      label="Welcome"
      className={cn(splitPanelClass, "max-w-[92vw] max-h-[85vh]", VIEW_SIZE[currentView])}
    >
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
