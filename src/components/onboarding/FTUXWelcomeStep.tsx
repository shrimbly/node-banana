"use client";

import { FTUXStepProps } from "@/types/ftux";

export function FTUXWelcomeStep({}: FTUXStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-6">
      <div className="mb-6">
        <img src="/banana_icon.png" alt="Node Banana" className="w-20 h-20" />
      </div>
      <h2 className="text-2xl font-semibold text-neutral-100 mb-3">
        Welcome to Node Banana
      </h2>
      <p className="text-neutral-300 text-center max-w-md leading-relaxed">
        Build AI workflows visually with nodes and connections. Create complex image and video generation pipelines by connecting simple building blocks.
      </p>
      <p className="text-neutral-400 text-sm text-center max-w-md mt-4">
        Let's get you set up in just a few quick steps.
      </p>
    </div>
  );
}
