"use client";

import { FTUXStepProps } from "@/types/ftux";

export function FTUXWelcomeStep({}: FTUXStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-6">
      <h2 className="text-2xl font-semibold text-neutral-100 mb-3">
        Let's get started.
      </h2>
      <p className="text-neutral-300 text-center max-w-md leading-relaxed">
        Connect AI models like building blocks to generate images, videos, and more.
      </p>
    </div>
  );
}
