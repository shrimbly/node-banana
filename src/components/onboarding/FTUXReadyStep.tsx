"use client";

import { FTUXStepProps } from "@/types/ftux";

export function FTUXReadyStep({ onStartTutorial, onComplete }: FTUXStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-6">
      <h2 className="text-2xl font-semibold text-neutral-100 mb-3">
        All Set Up!
      </h2>
      <p className="text-neutral-300 text-center max-w-md leading-relaxed mb-6">
        You're ready to start building workflows. Would you like a quick tutorial to get started?
      </p>

      <div className="flex gap-3 mt-2">
        <button
          type="button"
          onClick={onComplete}
          className="px-5 py-2.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
        >
          Skip Tutorial
        </button>
        <button
          type="button"
          onClick={onStartTutorial}
          className="px-5 py-2.5 text-sm bg-white text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors font-medium"
        >
          Start Tutorial
        </button>
      </div>
    </div>
  );
}
