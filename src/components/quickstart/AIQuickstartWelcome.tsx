"use client";

import { useState, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { ContentLevel } from "@/lib/quickstart/templates";
import { ContentLevelSelector } from "./ContentLevelSelector";
import { QuickstartPresetChips } from "./QuickstartPresetChips";

interface AIQuickstartWelcomeProps {
  onWorkflowGenerated: (workflow: WorkflowFile) => void;
  onClose: () => void;
}

export function AIQuickstartWelcome({
  onWorkflowGenerated,
  onClose,
}: AIQuickstartWelcomeProps) {
  const [description, setDescription] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [contentLevel, setContentLevel] = useState<ContentLevel>("minimal");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    // Clear previous error
    setError(null);

    // Validate input
    if (!selectedPreset && (!description || description.trim().length < 3)) {
      setError("Please select a template or describe your workflow");
      return;
    }

    setIsGenerating(true);

    try {
      const response = await fetch("/api/quickstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          contentLevel,
          templateId: selectedPreset,
        }),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to generate workflow");
      }

      if (result.workflow) {
        onWorkflowGenerated(result.workflow);
      }
    } catch (err) {
      console.error("Quickstart error:", err);
      setError(err instanceof Error ? err.message : "Failed to generate workflow");
    } finally {
      setIsGenerating(false);
    }
  }, [description, selectedPreset, contentLevel, onWorkflowGenerated]);

  const handlePresetSelect = useCallback((templateId: string | null) => {
    setSelectedPreset(templateId);
    // Clear description when selecting a preset
    if (templateId) {
      setDescription("");
    }
    setError(null);
  }, []);

  const handleDescriptionChange = useCallback((value: string) => {
    setDescription(value);
    // Clear preset when typing a description
    if (value.trim()) {
      setSelectedPreset(null);
    }
    setError(null);
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-900/80 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">
              AI Quickstart
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Choose a template or describe your workflow
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 transition-colors"
            title="Start with empty canvas"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Preset Templates */}
          <QuickstartPresetChips
            selectedId={selectedPreset}
            onSelect={handlePresetSelect}
            disabled={isGenerating}
          />

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-neutral-700" />
            <span className="text-xs text-neutral-500 font-medium">OR</span>
            <div className="flex-1 h-px bg-neutral-700" />
          </div>

          {/* Custom Description */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-neutral-400">
              Describe Your Workflow
            </label>
            <textarea
              value={description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              placeholder="e.g., Create product photography with consistent lighting and style from reference images..."
              disabled={isGenerating}
              rows={3}
              className={`
                w-full px-4 py-3 rounded-lg border bg-neutral-900/50 text-sm text-neutral-100
                placeholder:text-neutral-500 resize-none
                focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50
                ${isGenerating ? "opacity-50 cursor-not-allowed" : ""}
                ${selectedPreset ? "border-neutral-700" : "border-neutral-600"}
              `}
            />
          </div>

          {/* Content Level */}
          <ContentLevelSelector
            value={contentLevel}
            onChange={setContentLevel}
            disabled={isGenerating}
          />

          {/* Error Message */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <svg className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="text-xs text-red-400/70 hover:text-red-400 mt-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-700 flex items-center justify-between bg-neutral-800/50">
          <button
            onClick={onClose}
            disabled={isGenerating}
            className="px-4 py-2 text-sm font-medium text-neutral-400 hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            Skip
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || (!selectedPreset && description.trim().length < 3)}
            className={`
              flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all
              ${
                isGenerating || (!selectedPreset && description.trim().length < 3)
                  ? "bg-neutral-700 text-neutral-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20"
              }
            `}
          >
            {isGenerating ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Generating...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>{selectedPreset ? "Use Template" : "Generate Workflow"}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
