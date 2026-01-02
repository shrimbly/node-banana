"use client";

import { getAllPresets } from "@/lib/quickstart/templates";

interface QuickstartPresetChipsProps {
  selectedId: string | null;
  onSelect: (templateId: string | null) => void;
  disabled?: boolean;
}

export function QuickstartPresetChips({
  selectedId,
  onSelect,
  disabled = false,
}: QuickstartPresetChipsProps) {
  const presets = getAllPresets();

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs font-medium text-neutral-400">
        Quick Start Templates
      </label>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            onClick={() => onSelect(selectedId === preset.id ? null : preset.id)}
            disabled={disabled}
            className={`
              group flex items-center gap-2 px-3 py-2 rounded-lg border transition-all
              ${
                selectedId === preset.id
                  ? "bg-blue-600/20 border-blue-500/50 text-blue-300"
                  : "bg-neutral-800/50 border-neutral-700 text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800"
              }
              ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
            `}
            title={preset.description}
          >
            <svg
              className={`w-4 h-4 ${
                selectedId === preset.id ? "text-blue-400" : "text-neutral-500 group-hover:text-neutral-400"
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={preset.icon} />
            </svg>
            <span className="text-xs font-medium">{preset.name}</span>
          </button>
        ))}
      </div>
      {selectedId && (
        <p className="text-[10px] text-neutral-500">
          {presets.find((p) => p.id === selectedId)?.description}
        </p>
      )}
    </div>
  );
}
