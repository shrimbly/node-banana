"use client";

import { FTUXStepProps } from "@/types/ftux";

export function FTUXWelcomeStep({}: FTUXStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-6">
      <h2 className="text-2xl font-semibold text-neutral-100 mb-3">
        Let's get set up.
      </h2>
      <p className="text-neutral-300 text-center max-w-md leading-relaxed">
        Build AI workflows visually with nodes and connections. Create complex image and video generation pipelines by connecting simple building blocks.
      </p>
      <p className="text-neutral-400 text-sm text-center max-w-md mt-4">
        This will only take a few quick steps.
      </p>
    </div>
  );
}
