"use client";

import { WorkflowFile } from "@/store/workflowStore";
import { WorkflowBrowserView } from "./quickstart/WorkflowBrowserView";
import { Dialog, splitPanelClass } from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";

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
    <Dialog open={isOpen} onClose={onClose} labelledBy="workflow-browser-title" className={cn(splitPanelClass, "w-[820px] h-[470px] max-w-[92vw] max-h-[85vh]")}>
      <WorkflowBrowserView
        onWorkflowLoaded={onWorkflowLoaded}
        onClose={onClose}
      />
    </Dialog>
  );
}
