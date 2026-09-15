"use client";

/**
 * LLMFallbackPopover
 *
 * Small centered modal for selecting a fallback LLM for an llmGenerate node.
 * Persists the selection as a SelectedModel on nodeData.fallbackModel, with
 * "google" mapped to "gemini" as ProviderType (matches how NBP stores LLM
 * provider info so JSON round-trips cleanly).
 */

import { useState, useEffect } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useWorkflowStore } from "@/store/workflowStore";
import type {
  LLMGenerateNodeData,
  LLMProvider,
  LLMModelType,
  ProviderType,
  SelectedModel,
} from "@/types";

import { LLM_PROVIDER_OPTIONS, defaultLLMModel, llmModelLabel, llmModelOptions } from "@/lib/llm/catalog";

const mapLlmToProviderType = (p: LLMProvider): ProviderType =>
  p === "google" ? "gemini" : p;

const mapProviderTypeToLlm = (p: ProviderType): LLMProvider =>
  p === "gemini" ? "google" : (p as LLMProvider);

interface LLMFallbackPopoverProps {
  nodeId: string;
  onClose: () => void;
}

export function LLMFallbackPopover({ nodeId, onClose }: LLMFallbackPopoverProps) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const data = node?.data as LLMGenerateNodeData | undefined;
  const existing = data?.fallbackModel;

  const initialProvider: LLMProvider = existing
    ? mapProviderTypeToLlm(existing.provider)
    : "anthropic";
  const initialModel: LLMModelType = (existing?.modelId as LLMModelType) || defaultLLMModel(initialProvider);

  const [provider, setProvider] = useState<LLMProvider>(initialProvider);
  const [model, setModel] = useState<LLMModelType>(initialModel);

  // A legacy id already saved as the fallback stays selectable until changed.
  const modelOptions = llmModelOptions(provider, existing?.modelId);

  // Ensure model is valid whenever provider changes
  useEffect(() => {
    const valid = modelOptions.some((m) => m.value === model);
    if (!valid) setModel(defaultLLMModel(provider));
  }, [provider, model, modelOptions]);

  const handleSave = () => {
    const label = llmModelLabel(model);
    const fallbackModel: SelectedModel = {
      provider: mapLlmToProviderType(provider),
      modelId: model,
      displayName: label,
    };
    updateNodeData(nodeId, { fallbackModel, fallbackParameters: {} });
    onClose();
  };

  const handleRemove = () => {
    updateNodeData(nodeId, { fallbackModel: undefined, fallbackParameters: undefined });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} size="xs" portal>
      <DialogHeader compact closeButton={false}>
        <DialogTitle compact>Select fallback LLM</DialogTitle>
      </DialogHeader>
      <DialogBody compact>
        <label className="block text-xs text-neutral-400 mb-1">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as LLMProvider)}
          className="w-full mb-3 px-2 py-1.5 text-sm bg-well border border-card-border rounded-well text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
        >
          {LLM_PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <label className="block text-xs text-neutral-400 mb-1">Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as LLMModelType)}
          className="w-full mb-1 px-2 py-1.5 text-sm bg-well border border-card-border rounded-well text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
        >
          {modelOptions.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

      </DialogBody>
      <DialogFooter compact className="justify-between">
        <DialogButton compact variant="danger" onClick={handleRemove}>
          Remove fallback
        </DialogButton>
        <div className="flex gap-1.5">
          <DialogButton compact variant="ghost" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton compact variant="primary" onClick={handleSave}>
            Save
          </DialogButton>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
