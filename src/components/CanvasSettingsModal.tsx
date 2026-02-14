"use client";

import { useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { CanvasNavigationSettings, PanMode, ZoomMode, SelectionMode } from "@/types";

interface CanvasSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CanvasSettingsModal({ isOpen, onClose }: CanvasSettingsModalProps) {
  const { canvasNavigationSettings, updateCanvasNavigationSettings } = useWorkflowStore();
  const [settings, setSettings] = useState<CanvasNavigationSettings>(canvasNavigationSettings);

  if (!isOpen) return null;

  const handleSave = () => {
    updateCanvasNavigationSettings(settings);
    onClose();
  };

  const handleCancel = () => {
    setSettings(canvasNavigationSettings); // Reset to current settings
    onClose();
  };

  const panModeOptions: { value: PanMode; label: string; description: string }[] = [
    { value: "space", label: "Space + Drag", description: "Hold Space and drag to pan (default)" },
    { value: "middleMouse", label: "Middle Mouse", description: "Click and drag with middle mouse button" },
    { value: "always", label: "Always On", description: "Pan without holding any keys (like ComfyUI)" },
  ];

  const zoomModeOptions: { value: ZoomMode; label: string; description: string }[] = [
    { value: "altScroll", label: "Alt + Scroll", description: "Hold Alt and scroll to zoom (default)" },
    { value: "ctrlScroll", label: "Ctrl + Scroll", description: "Hold Ctrl/Cmd and scroll to zoom" },
    { value: "scroll", label: "Scroll", description: "Scroll to zoom without holding any keys" },
  ];

  const selectionModeOptions: { value: SelectionMode; label: string; description: string }[] = [
    { value: "click", label: "Click", description: "Click to select nodes (default)" },
    { value: "altDrag", label: "Alt + Drag", description: "Hold Alt and drag to select multiple nodes" },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={handleCancel}>
      <div
        className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl w-[600px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-700">
          <h2 className="text-lg font-semibold text-neutral-100">Canvas Navigation Settings</h2>
          <button
            onClick={handleCancel}
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-6">
          {/* Pan Mode */}
          <div>
            <h3 className="text-sm font-medium text-neutral-200 mb-3">Pan Mode</h3>
            <div className="space-y-2">
              {panModeOptions.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-start p-3 rounded-lg border cursor-pointer transition-colors ${
                    settings.panMode === option.value
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-neutral-700 hover:border-neutral-600 bg-neutral-900/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="panMode"
                    value={option.value}
                    checked={settings.panMode === option.value}
                    onChange={(e) => setSettings({ ...settings, panMode: e.target.value as PanMode })}
                    className="mt-0.5 mr-3"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-200">{option.label}</div>
                    <div className="text-xs text-neutral-400 mt-0.5">{option.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Zoom Mode */}
          <div>
            <h3 className="text-sm font-medium text-neutral-200 mb-3">Zoom Mode</h3>
            <div className="space-y-2">
              {zoomModeOptions.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-start p-3 rounded-lg border cursor-pointer transition-colors ${
                    settings.zoomMode === option.value
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-neutral-700 hover:border-neutral-600 bg-neutral-900/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="zoomMode"
                    value={option.value}
                    checked={settings.zoomMode === option.value}
                    onChange={(e) => setSettings({ ...settings, zoomMode: e.target.value as ZoomMode })}
                    className="mt-0.5 mr-3"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-200">{option.label}</div>
                    <div className="text-xs text-neutral-400 mt-0.5">{option.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Selection Mode */}
          <div>
            <h3 className="text-sm font-medium text-neutral-200 mb-3">Selection Mode</h3>
            <div className="space-y-2">
              {selectionModeOptions.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-start p-3 rounded-lg border cursor-pointer transition-colors ${
                    settings.selectionMode === option.value
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-neutral-700 hover:border-neutral-600 bg-neutral-900/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="selectionMode"
                    value={option.value}
                    checked={settings.selectionMode === option.value}
                    onChange={(e) => setSettings({ ...settings, selectionMode: e.target.value as SelectionMode })}
                    className="mt-0.5 mr-3"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-200">{option.label}</div>
                    <div className="text-xs text-neutral-400 mt-0.5">{option.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-neutral-700">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
