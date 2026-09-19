"use client";

import { WorkflowFile } from "@/store/workflowStore";
import { WorkflowBrowserView } from "./quickstart/WorkflowBrowserView";
import { Dialog } from "@/components/ui/Dialog";

interface WorkflowBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWorkflowLoaded: (workflow: WorkflowFile, directoryPath: string) => void;
}

export function WorkflowBrowserModal({
  isOpen,
  onClose,
  onWorkflowLoaded,
}: WorkflowBrowserModalProps) {
  return (
    <Dialog open={isOpen} onClose={onClose} labelledBy="workflow-browser-title" className="w-full max-w-2xl">
      <WorkflowBrowserView
        onWorkflowLoaded={onWorkflowLoaded}
        onClose={onClose}
      />
    </Dialog>
  );
}
