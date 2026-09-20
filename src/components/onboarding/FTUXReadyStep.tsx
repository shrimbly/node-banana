"use client";

import { DialogButton } from "@/components/ui/Dialog";

interface FTUXReadyStepProps {
  onStartTutorial: () => void;
  onComplete: () => void;
}

export function FTUXReadyStep({ onStartTutorial, onComplete }: FTUXReadyStepProps) {
  return (
    <div className="flex gap-2 mt-1.5">
      <DialogButton variant="primary" size="md" onClick={onStartTutorial}>
        Start tutorial
      </DialogButton>
      <DialogButton variant="ghost" size="md" onClick={onComplete}>
        Skip
      </DialogButton>
    </div>
  );
}
