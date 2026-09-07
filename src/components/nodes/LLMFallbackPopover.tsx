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

const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

const LLM_MODELS: Record<LLMProvider, { value: LLMModelType; label: string }[]> = {
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  ],
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
  ],
};

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
  const initialModel: LLMModelType = (existing?.modelId as LLMModelType) ||
    LLM_MODELS[initialProvider][0].value;

  const [provider, setProvider] = useState<LLMProvider>(initialProvider);
  const [model, setModel] = useState<LLMModelType>(initialModel);

  // Ensure model is valid whenever provider changes
  useEffect(() => {
    const valid = LLM_MODELS[provider].some((m) => m.value === model);
    if (!valid) setModel(LLM_MODELS[provider][0].value);
  }, [provider, model]);

  const handleSave = () => {
    const label = LLM_MODELS[provider].find((m) => m.value === model)?.label || model;
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
          {LLM_PROVIDERS.map((p) => (
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
          {LLM_MODELS[provider].map((m) => (
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
