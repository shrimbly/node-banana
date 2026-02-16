"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { GenerateAudioNodeData, SelectedModel } from "@/types";
import { ProviderModel } from "@/lib/providers/types";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";

type GenerateAudioNodeType = Node<GenerateAudioNodeData, "generateAudio">;

// Common TTS parameters by provider
const TTS_PARAMETERS: Record<string, { name: string; type: "select" | "number"; options?: string[]; min?: number; max?: number; step?: number; default?: unknown }[]> = {
  openai: [
    { name: "voice", type: "select", options: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"], default: "alloy" },
    { name: "speed", type: "number", min: 0.25, max: 4.0, step: 0.1, default: 1.0 },
    { name: "format", type: "select", options: ["mp3", "opus", "aac", "flac", "wav", "pcm"], default: "mp3" },
  ],
  elevenlabs: [
    { name: "voice_id", type: "select", options: ["default"], default: "default" },
    { name: "stability", type: "number", min: 0, max: 1, step: 0.1, default: 0.5 },
    { name: "similarity_boost", type: "number", min: 0, max: 1, step: 0.1, default: 0.75 },
  ],
  deepgram: [
    { name: "model", type: "select", options: ["aura-asteria-en", "aura-2"], default: "aura-asteria-en" },
    { name: "format", type: "select", options: ["mp3"], default: "mp3" },
  ],
  cartesia: [
    { name: "voice", type: "select", options: ["default"], default: "default" },
  ],
  google: [
    { name: "languageCode", type: "select", options: ["en-US", "es-ES", "fr-FR", "de-DE"], default: "en-US" },
    { name: "ssmlGender", type: "select", options: ["MALE", "FEMALE", "NEUTRAL"], default: "NEUTRAL" },
  ],
  azure: [
    { name: "voice", type: "select", options: ["en-US-ChristopherNeural", "en-US-JennyNeural"], default: "en-US-JennyNeural" },
  ],
};

export function GenerateAudioNode({ id, data, selected }: NodeProps<GenerateAudioNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [ttsModels, setTtsModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Fetch TTS models on mount
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoadingModels(true);
      try {
        const response = await deduplicatedFetch("/api/models?capabilities=text-to-audio");
        if (response.ok) {
          const data = await response.json();
          setTtsModels(data.models || []);
        }
      } catch (error) {
        console.error("Failed to fetch TTS models:", error);
      } finally {
        setIsLoadingModels(false);
      }
    };
    fetchModels();
  }, []);

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      const model = ttsModels.find((m) => m.id === modelId);
      if (model) {
        const newSelectedModel: SelectedModel = {
          provider: model.provider,
          modelId: model.id,
          displayName: model.name,
        };
        // Reset parameters when switching models
        const defaultParams = TTS_PARAMETERS[model.provider]?.reduce((acc, param) => {
          acc[param.name] = param.default;
          return acc;
        }, {} as Record<string, unknown>) || {};
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: defaultParams });
      }
    },
    [id, updateNodeData, ttsModels]
  );

  const handleParameterChange = useCallback(
    (paramName: string, value: unknown) => {
      updateNodeData(id, {
        parameters: { ...nodeData.parameters, [paramName]: value },
      });
    },
    [id, updateNodeData, nodeData.parameters]
  );

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current || !nodeData.outputAudio) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }, [isPlaying, nodeData.outputAudio]);

  useEffect(() => {
    if (nodeData.outputAudio && !audioRef.current) {
      const audio = new Audio(nodeData.outputAudio);
      audioRef.current = audio;
      audio.addEventListener("ended", () => setIsPlaying(false));
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [nodeData.outputAudio]);

  const currentProvider = nodeData.selectedModel?.provider || "openai";
  const parameters = TTS_PARAMETERS[currentProvider] || [];

  return (
    <BaseNode
      id={id}
      title="Generate Audio (TTS)"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
      minWidth={300}
      minHeight={280}
    >
      <div className="flex flex-col gap-2 flex-1 overflow-auto">
        {/* Model Selection */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">Model</label>
          <select
            value={nodeData.selectedModel?.modelId || ""}
            onChange={handleModelChange}
            className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs text-white"
            disabled={isLoadingModels}
          >
            {isLoadingModels ? (
              <option>Loading models...</option>
            ) : (
              <>
                <option value="">Select model...</option>
                {ttsModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>

        {/* Parameters */}
        {parameters.map((param) => (
          <div key={param.name}>
            <label className="text-[10px] text-neutral-400 block mb-1 capitalize">
              {param.name.replace(/_/g, " ")}
            </label>
            {param.type === "select" ? (
              <select
                value={(nodeData.parameters?.[param.name] as string) || String(param.default)}
                onChange={(e) => handleParameterChange(param.name, e.target.value)}
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs text-white"
              >
                {param.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                value={(nodeData.parameters?.[param.name] as number) || Number(param.default)}
                onChange={(e) => handleParameterChange(param.name, parseFloat(e.target.value))}
                min={param.min}
                max={param.max}
                step={param.step}
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs text-white"
              />
            )}
          </div>
        ))}

        {/* Status */}
        {nodeData.status === "loading" && (
          <div className="text-xs text-violet-400 animate-pulse">Generating audio...</div>
        )}
        {nodeData.error && (
          <div className="text-xs text-red-400">{nodeData.error}</div>
        )}

        {/* Audio Player */}
        {nodeData.outputAudio && (
          <div className="mt-2 p-2 bg-neutral-900/50 rounded">
            <button
              onClick={handlePlayPause}
              className="w-full py-2 bg-violet-600 hover:bg-violet-500 text-white rounded transition-colors text-xs flex items-center justify-center gap-1.5"
            >
              {isPlaying ? (
                <>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Play
                </>
              )}
            </button>
          </div>
        )}
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="text"
        data-handletype="text"
        style={{ background: "rgb(245, 158, 11)" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="audio"
        data-handletype="audio"
        style={{ background: "rgb(167, 139, 250)" }}
      />
    </BaseNode>
  );
}
