"use client";

import { ContentLevel } from "@/lib/quickstart/templates";

interface ContentLevelSelectorProps {
  value: ContentLevel;
  onChange: (level: ContentLevel) => void;
  disabled?: boolean;
}

const CONTENT_LEVELS: { value: ContentLevel; label: string; description: string }[] = [
  {
    value: "empty",
    label: "Empty",
    description: "Structure only, no prompts",
  },
  {
    value: "minimal",
    label: "Minimal",
    description: "Placeholder prompts",
  },
  {
    value: "full",
    label: "Full",
    description: "Complete example prompts",
  },
];

export function ContentLevelSelector({
  value,
  onChange,
  disabled = false,
}: ContentLevelSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-neutral-400">
        Content Level
      </label>
      <div className="flex gap-1 p-1 bg-neutral-900 rounded-lg border border-neutral-700">
        {CONTENT_LEVELS.map((level) => (
          <button
            key={level.value}
            onClick={() => onChange(level.value)}
            disabled={disabled}
            className={`
              flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all
              ${
                value === level.value
                  ? "bg-neutral-700 text-neutral-100 shadow-sm"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
              }
              ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
            `}
            title={level.description}
          >
            {level.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-neutral-500">
        {CONTENT_LEVELS.find((l) => l.value === value)?.description}
      </p>
    </div>
  );
}
