"use client";

import { useState, useCallback, useRef } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { PromptWorkflowView } from "./PromptWorkflowView";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile) => void;
  onClose: () => void;
}

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>("initial");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectBlankCanvas = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectTemplates = useCallback(() => {
    setCurrentView("templates");
  }, []);

  const handleSelectVibe = useCallback(() => {
    setCurrentView("vibe");
  }, []);

  const handleSelectLoad = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const workflow = JSON.parse(
            event.target?.result as string
          ) as WorkflowFile;
          if (workflow.version && workflow.nodes && workflow.edges) {
            onWorkflowGenerated(workflow);
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
    },
    [onWorkflowGenerated]
  );

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
  const dialogHeight = currentView === "templates" ? "max-h-[85vh]" : "max-h-[80vh]";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div className={`w-full ${dialogWidth} mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-clip ${dialogHeight} flex flex-col`}>
        {currentView === "initial" && (
          <QuickstartInitialView
            onSelectBlankCanvas={handleSelectBlankCanvas}
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
