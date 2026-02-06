"use client";

import { useCallback, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { LLMGenerateNodeData, LLMProvider, LLMModelType } from "@/types";

const PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-auth", label: "OpenAI (Auth)" },
];

const MODELS: Record<LLMProvider, { value: LLMModelType; label: string }[]> = {
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
  ],
  openai: [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  "openai-auth": [
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
};

type LLMGenerateNodeType = Node<LLMGenerateNodeData, "llmGenerate">;

export function LLMGenerateNode({ id, data, selected }: NodeProps<LLMGenerateNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [openaiAuthStatus, setOpenaiAuthStatus] = useState<{ connected: boolean; expired?: boolean } | null>(null);

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value as LLMProvider;
      const firstModelForProvider = MODELS[newProvider][0].value;
      updateNodeData(id, {
        provider: newProvider,
        model: firstModelForProvider
      });
    },
    [id, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(id, { model: e.target.value as LLMModelType });
    },
    [id, updateNodeData]
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { temperature: parseFloat(e.target.value) });
    },
    [id, updateNodeData]
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { maxTokens: parseInt(e.target.value, 10) });
    },
    [id, updateNodeData]
  );

  const handleSystemPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { systemPrompt: e.target.value });
    },
    [id, updateNodeData]
  );

  const [showParams, setShowParams] = useState(false);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleClearOutput = useCallback(() => {
    updateNodeData(id, { outputText: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const [copied, setCopied] = useState(false);

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

  const provider = nodeData.provider || "google";
  const availableModels = MODELS[provider] || MODELS.google;
  const model = availableModels.some(m => m.value === nodeData.model)
    ? nodeData.model
    : availableModels[0].value;

  useEffect(() => {
    if (provider !== "openai-auth") return;
    fetch("/api/auth/openai/status")
      .then((res) => res.json())
      .then((data) => setOpenaiAuthStatus(data))
      .catch(() => setOpenaiAuthStatus(null));
  }, [provider]);

  return (
    <BaseNode
      id={id}
      title="LLM Generate"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      hasError={nodeData.status === "error"}
      commentNavigation={commentNavigation ?? undefined}
    >
      {/* Image input - optional */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
        data-handletype="image"
      />
      {/* Text input */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
        data-handletype="text"
      />
      {/* Text output */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
      />

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Output preview area */}
        <div className="nodrag nopan nowheel relative w-full flex-1 min-h-[80px] border border-dashed border-neutral-600 rounded p-2 overflow-auto">
          {nodeData.status === "loading" ? (
            <div className="h-full flex items-center justify-center">
              <svg
                className="w-4 h-4 animate-spin text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
          ) : nodeData.status === "error" ? (
            <span className="text-[10px] text-red-400">
              {nodeData.error || "Failed"}
            </span>
          ) : nodeData.outputText ? (
            <>
              <p className="text-[10px] text-neutral-300 whitespace-pre-wrap break-words pr-6">
                {nodeData.outputText}
              </p>
              <div className="absolute top-1 right-1 flex gap-1">
                <button
                  onClick={handleCopyOutput}
                  className={`w-5 h-5 ${copied ? "bg-green-600/80" : "bg-neutral-900/80 hover:bg-neutral-700/80"} rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors`}
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
                  className="w-5 h-5 bg-neutral-900/80 hover:bg-blue-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                  title="Regenerate"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                <button
                  onClick={handleClearOutput}
                  className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                  title="Clear output"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center">
              <span className="text-neutral-500 text-[10px]">
                Run to generate
              </span>
            </div>
          )}
        </div>

        {/* Provider selector */}
        <select
          value={provider}
          onChange={handleProviderChange}
          className="w-full text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300 shrink-0"
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        {provider === "openai-auth" && (!openaiAuthStatus?.connected || openaiAuthStatus.expired) && (
          <div className="text-[9px] text-yellow-400">
            {openaiAuthStatus?.expired ? "OpenAI Auth expired. Reconnect in Settings." : "OpenAI Auth not connected."}
          </div>
        )}

        {/* Model selector */}
        <select
          value={model}
          onChange={handleModelChange}
          className="w-full text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300 shrink-0"
        >
          {availableModels.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Collapsible parameters section */}
        <div className="shrink-0">
          <button
            onClick={() => setShowParams(!showParams)}
            className="w-full flex items-center justify-between text-[9px] text-neutral-400 hover:text-neutral-300 py-1"
          >
            <span>Parameters</span>
            <svg
              className={`w-3 h-3 transition-transform ${showParams ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showParams && (
            <div className="flex flex-col gap-2 pt-1 border-t border-neutral-700/50">
              <div className="flex flex-col gap-0.5">
                <label className="text-[9px] text-neutral-500">System Prompt</label>
                <textarea
                  value={nodeData.systemPrompt || ""}
                  onChange={handleSystemPromptChange}
                  placeholder="Leave empty to use the default system prompt"
                  className="nodrag w-full min-h-[60px] text-[10px] bg-neutral-900/50 border border-neutral-700 rounded p-1 text-neutral-300 focus:outline-none focus:ring-1 focus:ring-neutral-600"
                />
              </div>
              {/* Temperature slider */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[9px] text-neutral-500">Temperature: {nodeData.temperature.toFixed(1)}</label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={nodeData.temperature}
                  onChange={handleTemperatureChange}
                  className="nodrag w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-neutral-400"
                />
              </div>
              {/* Max tokens slider */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[9px] text-neutral-500">Max Tokens: {nodeData.maxTokens.toLocaleString()}</label>
                <input
                  type="range"
                  min="256"
                  max="16384"
                  step="256"
                  value={nodeData.maxTokens}
                  onChange={handleMaxTokensChange}
                  className="nodrag w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-neutral-400"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </BaseNode>
  );
}
