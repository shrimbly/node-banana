"use client";

import { useCallback, useEffect, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { LLMGenerateNodeData, LLMProvider, LLMModelType } from "@/types";
import { SettingsTabBar } from "./SettingsTabBar";
import {
  ControlsCard,
  EmptyState,
  Field,
  RangeField,
  SelectField,
  Spinner,
  SummaryValues,
  ellipsisClass,
  type SocketSpec,
} from "./ui";

// LLM providers and models
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

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "Image" },
  { id: "text", type: "text", label: "Prompt" },
];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text" }];
const MEDIA_HEIGHT = 160;

/** A provider's glyph for the summary row. */
function ProviderMark({ provider }: { provider: LLMProvider }) {
  const letter = provider === "google" ? "G" : provider === "openai" ? "O" : "A";
  return (
    <span className="w-4 h-4 rounded-full bg-neutral-700 text-neutral-300 text-[9px] font-semibold flex items-center justify-center" aria-hidden>
      {letter}
    </span>
  );
}

type LLMGenerateNodeType = Node<LLMGenerateNodeData, "llmGenerate">;

export function LLMGenerateNode({ id, data, selected }: NodeProps<LLMGenerateNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleClearOutput = useCallback(() => {
    updateNodeData(id, { outputText: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const [copied, setCopied] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"primary" | "fallback">("primary");

  useEffect(() => {
    if (!nodeData.fallbackModel && settingsTab === "fallback") {
      setSettingsTab("primary");
    }
  }, [nodeData.fallbackModel, settingsTab]);

  const handleCopyOutput = useCallback(async () => {
    if (nodeData.outputText) {
      try {
        await navigator.clipboard.writeText(nodeData.outputText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        console.error("Failed to copy text:", err);
      }
    }
  }, [nodeData.outputText]);

  const isParamsExpanded = nodeData.parametersExpanded ?? true; // default expanded

  const handleToggleParams = useCallback(() => {
    updateNodeData(id, { parametersExpanded: !isParamsExpanded });
  }, [id, isParamsExpanded, updateNodeData]);

  const handleProviderChange = useCallback(
    (value: string) => {
      const newProvider = value as LLMProvider;
      const firstModelForProvider = LLM_MODELS[newProvider][0].value;
      const updates: Partial<LLMGenerateNodeData> = {
        provider: newProvider,
        model: firstModelForProvider,
      };
      if (newProvider === "anthropic" && (nodeData.temperature ?? 0.7) > 1) {
        updates.temperature = 1;
      }
      updateNodeData(id, updates);
    },
    [id, nodeData.temperature, updateNodeData]
  );

  const handleModelChange = useCallback(
    (value: string) => {
      updateNodeData(id, { model: value as LLMModelType });
    },
    [id, updateNodeData]
  );

  const provider = nodeData.provider || "google";
  const availableModels = LLM_MODELS[provider] || LLM_MODELS.google;
  const currentModel = nodeData.model || availableModels[0].value;
  const modelLabel = availableModels.find((m) => m.value === currentModel)?.label || currentModel;
  const temperature = nodeData.temperature ?? 0.7;
  const maxTokens = nodeData.maxTokens || 2048;

  const fbParams = nodeData.fallbackParameters || {};
  const fbTemp = (fbParams.temperature as number | undefined) ?? 0.7;
  const fbMaxTokens = (fbParams.maxTokens as number | undefined) ?? 2048;
  const isAnthropicFb = nodeData.fallbackModel?.provider === "anthropic";

  const settings = (
    <>
      {nodeData.fallbackModel && (
        <SettingsTabBar
          activeTab={settingsTab}
          onTabChange={setSettingsTab}
          primaryLabel={nodeData.model || "Primary"}
          fallbackLabel={nodeData.fallbackModel.displayName}
        />
      )}

      {settingsTab === "primary" && (
        <>
          <SelectField label="Provider" value={provider} options={LLM_PROVIDERS} onChange={handleProviderChange} />
          <SelectField label="Model" value={currentModel} options={availableModels} onChange={handleModelChange} />
          <RangeField
            label="Temperature"
            value={temperature}
            min={0}
            max={provider === "anthropic" ? 1 : 2}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => updateNodeData(id, { temperature: v })}
          />
          <RangeField
            label="Max tokens"
            value={maxTokens}
            min={256}
            max={16384}
            step={256}
            format={(v) => v.toLocaleString()}
            onChange={(v) => updateNodeData(id, { maxTokens: v })}
          />
        </>
      )}

      {settingsTab === "fallback" && nodeData.fallbackModel && (
        <>
          <Field label="Model">
            <span className={`text-node text-neutral-200 ${ellipsisClass}`}>{nodeData.fallbackModel.displayName}</span>
          </Field>
          <RangeField
            label="Temperature"
            value={fbTemp}
            min={0}
            max={isAnthropicFb ? 1 : 2}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => updateNodeData(id, { fallbackParameters: { ...fbParams, temperature: v } })}
          />
          <RangeField
            label="Max tokens"
            value={fbMaxTokens}
            min={256}
            max={16384}
            step={256}
            format={(v) => v.toLocaleString()}
            onChange={(v) => updateNodeData(id, { fallbackParameters: { ...fbParams, maxTokens: v } })}
          />
        </>
      )}
    </>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      hasError={nodeData.status === "error"}
      isExecuting={isRunning}
      media={{ kind: "fixed", height: MEDIA_HEIGHT }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group/text"
      controls={
        <ControlsCard
          id={id}
          summary={{
            icon: <ProviderMark provider={provider} />,
            title: modelLabel,
            values: <SummaryValues items={[`temp ${temperature.toFixed(2)}`]} />,
          }}
          expanded={isParamsExpanded}
          onToggle={handleToggleParams}
        >
          {settings}
        </ControlsCard>
      }
    >
      {nodeData.status === "loading" ? (
        <div className="absolute inset-0 bg-neutral-900/40 flex items-center justify-center">
          <Spinner className="text-neutral-400" />
        </div>
      ) : nodeData.status === "error" ? (
        <div className="absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1">
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-white text-xs font-medium">Generation failed</span>
          {nodeData.error && (
            <span className="text-red-200 text-[10px] text-center px-3 mt-1 line-clamp-3">{nodeData.error}</span>
          )}
        </div>
      ) : nodeData.outputText ? (
        <div className="absolute inset-0 bg-neutral-900/40 p-2 overflow-auto nowheel nodrag">
          {nodeData.__usedFallback && (
            <div
              className="mb-1 inline-block px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-300 text-[9px] font-medium"
              title={`Primary failed: ${nodeData.__primaryError ?? "unknown"}\nUsed fallback: ${nodeData.__fallbackModelUsed ?? ""}`}
            >
              Fallback used
            </div>
          )}
          <p className="text-[10px] text-neutral-300 whitespace-pre-wrap break-words">
            {nodeData.outputText}
          </p>
          <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover/text:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={handleCopyOutput}
              className={`nodrag nopan w-5 h-5 ${copied ? "bg-green-600/80" : "bg-neutral-900/80 hover:bg-neutral-700/80"} rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors`}
              title={copied ? "Copied!" : "Copy to clipboard"}
            >
              {copied ? (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
            <button
              onClick={handleRegenerate}
              disabled={isRunning}
              className="nodrag nopan w-5 h-5 bg-neutral-900/80 hover:bg-blue-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Regenerate"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={handleClearOutput}
              className="nodrag nopan w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Clear output"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <EmptyState message="Run to generate" hint="Connect a prompt and run" />
      )}
    </NodeShell>
  );
}
