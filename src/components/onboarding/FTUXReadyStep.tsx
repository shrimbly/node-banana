"use client";

import { FTUXStepProps } from "@/types/ftux";

export function FTUXReadyStep({ onStartTutorial, onComplete }: FTUXStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-8">
      <h2 className="text-2xl font-semibold text-neutral-100 mb-4">
        You're ready!
      </h2>
      <p className="text-neutral-300 text-center leading-relaxed mb-8">
        Want a quick tutorial?
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onComplete}
          className="px-5 py-2.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onStartTutorial}
          className="px-5 py-2.5 text-sm bg-white text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors font-medium"
        >
          Start tutorial
        </button>
      </div>
    </div>
  );
}
