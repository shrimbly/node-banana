"use client";

/**
 * Node components for the split-grid cell template editor (the mini canvas).
 * Each card mirrors the real node it will instantiate — the same NodeShell
 * anatomy (media card, sockets in the border, controls card), floating
 * uppercase header, handle ids, and (for the generate node) the same settings
 * surface as GenerateImageNode: gemini controls, external-provider
 * ModelParameters, and the ModelSearchDialog browser for the full
 * multi-provider model catalog.
 */

import { createContext, memo, useCallback, useContext, useEffect, useState } from "react";
import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import type {
  AspectRatio,
  LLMModelType,
  LLMProvider,
  ModelType,
  NodeType,
  Resolution,
  SelectedModel,
} from "@/types";
import { GEMINI_IMAGE_MODELS } from "@/types";
import type { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "../modals/ModelSearchDialog";
import { ModelParameters } from "../nodes/ModelParameters";
import { ProviderBadge } from "../nodes/ProviderBadge";
import { NodeShell } from "../nodes/NodeShell";
import {
  CheckboxField,
  ControlsCard,
  EmptyState,
  RangeField,
  SelectField,
  SummaryValues,
  SOCKET_PITCH,
  SOCKET_TOP,
  type SocketSpec,
  type SocketType,
} from "../nodes/ui";
import { getTemplateEntry, getTemplateNodeIcon, type TemplateHandleDef } from "./templateCatalog";

export interface TemplateNodeData extends Record<string, unknown> {
  nodeType: NodeType;
  overrides: Record<string, unknown>;
  isBase: boolean;
  sourceImage?: string | null;
}

export type TemplateRFNode = Node<TemplateNodeData, "splitGridTemplateNode">;

interface TemplateEditorContextValue {
  setOverrides: (nodeId: string, overrides: Record<string, unknown>) => void;
}

export const TemplateEditorContext = createContext<TemplateEditorContextValue>({
  setOverrides: () => {},
});

/**
 * Editor connection ("noodle") — a curved bezier with a wide invisible hit
 * path, exactly like the main canvas. Deletion is handled the same way too: the
 * modal shows a floating toolbar above the cursor when a noodle is clicked (see
 * SplitGridTemplateModal), so the edge itself carries no inline control.
 */
export function TemplateEditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {/* Wide invisible hit path — makes the noodle easy to click */}
      <path d={edgePath} fill="none" strokeWidth={16} stroke="transparent" className="react-flow__edge-interaction" />
    </>
  );
}

const BASE_ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

// Mirrors LLMGenerateNode's provider/model lists
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

/** Centre of the n-th socket on a side, from the media card's top edge. */
export function templateHandleTop(index: number): number {
  return SOCKET_TOP + SOCKET_PITCH * index;
}

/** Template handle defs → shell sockets. The catalog's ids double as types. */
function toSockets(handles: TemplateHandleDef[]): SocketSpec[] {
  return handles.map((handle) => ({ id: handle.id, type: handle.id as SocketType, title: handle.label }));
}

const EMPTY_MEDIA_HEIGHT = 120;

/** Floating uppercase title above the card — parity with FloatingNodeHeader */
function MiniFloatingHeader({
  title,
  provider,
  right,
}: {
  title: string;
  provider?: SelectedModel["provider"];
  right?: React.ReactNode;
}) {
  return (
    <div className="absolute left-0 right-0 -top-[26px] px-1 py-1 flex items-center justify-between pointer-events-none">
      {/* Title strip doubles as a drag handle (bodies are nodrag). No `nodrag`
          class + pointer-events-auto lets React Flow start a node drag here,
          mirroring the main-canvas FloatingNodeHeader. */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-2 pointer-events-auto cursor-grab active:cursor-grabbing">
        {provider && <ProviderBadge provider={provider} />}
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400 truncate select-none">
          {title}
        </span>
      </div>
      {right && <div className="shrink-0 flex items-center gap-1 pr-1 pointer-events-auto">{right}</div>}
    </div>
  );
}

function BaseImageBody({
  sourceImage,
  onAspect,
}: {
  sourceImage?: string | null;
  onAspect: (aspect: number) => void;
}) {
  return sourceImage ? (
    <>
      <img
        src={sourceImage}
        alt="Source"
        className="absolute inset-0 w-full h-full object-cover opacity-50"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) onAspect(img.naturalWidth / img.naturalHeight);
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="px-2 py-1 rounded bg-neutral-950/80 text-[10px] text-neutral-300">
          One slice of this image per cell
        </span>
      </div>
    </>
  ) : (
    <EmptyState
      message="Split image lands here"
      icon={
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
        </svg>
      }
    />
  );
}

function PromptBody({ nodeId, overrides }: { nodeId: string; overrides: Record<string, unknown> }) {
  const { setOverrides } = useContext(TemplateEditorContext);
  const prompt = typeof overrides.prompt === "string" ? overrides.prompt : "";
  return (
    <textarea
      value={prompt}
      onChange={(event) => setOverrides(nodeId, { ...overrides, prompt: event.target.value })}
      placeholder="Describe what to generate..."
      className="nodrag nopan nowheel absolute inset-0 w-full h-full p-3 text-xs leading-relaxed text-neutral-100 bg-neutral-900/40 resize-none focus:outline-none placeholder:text-neutral-500"
    />
  );
}

/**
 * Generate node settings — same surface as the main canvas GenerateImageNode:
 * gemini selects, external-provider ModelParameters, ModelSearchDialog browse.
 * Returns the controls card and the header's Browse button.
 */
function useGenerateControls(nodeId: string, overrides: Record<string, unknown>) {
  const { setOverrides } = useContext(TemplateEditorContext);
  const [isParamsExpanded, setIsParamsExpanded] = useState(true);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  // While the browse dialog is open, Escape must close only the dialog — not
  // bubble to the template modal's own close/discard handler
  useEffect(() => {
    if (!isBrowseDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsBrowseDialogOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isBrowseDialogOpen]);

  const selectedModel = overrides.selectedModel as SelectedModel | undefined;
  const currentProvider = selectedModel?.provider ?? "gemini";
  const isGeminiProvider = currentProvider === "gemini";
  const currentModelId = isGeminiProvider
    ? selectedModel?.modelId ?? ((overrides.model as ModelType | undefined) || "nano-banana-pro")
    : null;
  const aspectRatio = (overrides.aspectRatio as AspectRatio | undefined) ?? "1:1";
  const resolution = (overrides.resolution as Resolution | undefined) ?? "1K";
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;

  const handleGeminiModelChange = useCallback(
    (value: string) => {
      const model = value as ModelType;
      const nextAspectRatios = model === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
      const nextResolutions = model === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
      setOverrides(nodeId, {
        ...overrides,
        model,
        selectedModel: {
          provider: "gemini",
          modelId: model,
          displayName: GEMINI_IMAGE_MODELS.find((m) => m.value === model)?.label || model,
        },
        aspectRatio: nextAspectRatios.includes(aspectRatio) ? aspectRatio : nextAspectRatios[0],
        resolution: nextResolutions.includes(resolution) ? resolution : nextResolutions[0],
      });
    },
    [nodeId, overrides, aspectRatio, resolution, setOverrides]
  );

  // Same shape as GenerateImageNode.handleBrowseModelSelect
  const handleBrowseModelSelect = useCallback(
    (model: ProviderModel) => {
      const newSelectedModel: SelectedModel = {
        provider: model.provider,
        modelId: model.id,
        displayName: model.name,
        capabilities: model.capabilities,
      };
      setOverrides(nodeId, { ...overrides, selectedModel: newSelectedModel, parameters: {} });
      setIsBrowseDialogOpen(false);
    },
    [nodeId, overrides, setOverrides]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      setOverrides(nodeId, { ...overrides, parameters });
    },
    [nodeId, overrides, setOverrides]
  );

  const title =
    selectedModel?.displayName ??
    GEMINI_IMAGE_MODELS.find((m) => m.value === currentModelId)?.label ??
    "Select model...";

  const settings = isGeminiProvider && currentModelId ? (
    <>
      <SelectField
        label="Model"
        value={currentModelId}
        options={GEMINI_IMAGE_MODELS.map((m) => ({ value: m.value, label: m.label }))}
        onChange={handleGeminiModelChange}
      />
      <SelectField
        label="Aspect ratio"
        value={aspectRatio}
        options={aspectRatios}
        onChange={(v) => setOverrides(nodeId, { ...overrides, aspectRatio: v })}
      />
      {supportsResolution && (
        <SelectField
          label="Resolution"
          value={resolution}
          options={resolutions}
          onChange={(v) => setOverrides(nodeId, { ...overrides, resolution: v })}
        />
      )}
      {(currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") && (
        <CheckboxField
          label="Google Search"
          checked={Boolean(overrides.useGoogleSearch)}
          onChange={(v) => setOverrides(nodeId, { ...overrides, useGoogleSearch: v })}
        />
      )}
      {currentModelId === "nano-banana-2" && (
        <CheckboxField
          label="Image Search"
          checked={Boolean(overrides.useImageSearch)}
          onChange={(v) => setOverrides(nodeId, { ...overrides, useImageSearch: v })}
        />
      )}
    </>
  ) : selectedModel?.modelId ? (
    <ModelParameters
      modelId={selectedModel.modelId}
      provider={currentProvider}
      parameters={(overrides.parameters as Record<string, unknown>) || {}}
      onParametersChange={handleParametersChange}
    />
  ) : undefined;

  const controls = (
    <ControlsCard
      id={`tmpl-${nodeId}`}
      summary={{
        icon: <ProviderBadge provider={currentProvider} />,
        title,
        values: <SummaryValues items={isGeminiProvider ? [aspectRatio, supportsResolution ? resolution : null] : []} />,
      }}
      expanded={isParamsExpanded}
      onToggle={() => setIsParamsExpanded((prev) => !prev)}
    >
      {settings}
    </ControlsCard>
  );

  const browse = (
    <>
      <button
        onClick={() => setIsBrowseDialogOpen(true)}
        className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
      >
        Browse
      </button>
      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="image"
        />
      )}
    </>
  );

  return { controls, browse, provider: currentProvider, title };
}

/**
 * LLM node settings — same controls as the main canvas LLMGenerateNode:
 * provider, model, temperature, and max tokens.
 */
function useLlmControls(nodeId: string, overrides: Record<string, unknown>) {
  const { setOverrides } = useContext(TemplateEditorContext);
  const [isParamsExpanded, setIsParamsExpanded] = useState(true);

  const provider = (overrides.provider as LLMProvider | undefined) ?? "google";
  const availableModels = LLM_MODELS[provider] ?? LLM_MODELS.google;
  const model = (overrides.model as LLMModelType | undefined) ?? availableModels[0].value;
  const temperature = typeof overrides.temperature === "number" ? overrides.temperature : 0.7;
  const maxTokens = typeof overrides.maxTokens === "number" ? overrides.maxTokens : 2048;
  const modelLabel = availableModels.find((m) => m.value === model)?.label ?? model;

  const handleProviderChange = useCallback(
    (value: string) => {
      const newProvider = value as LLMProvider;
      const next: Record<string, unknown> = {
        ...overrides,
        provider: newProvider,
        model: LLM_MODELS[newProvider][0].value,
      };
      // Anthropic caps temperature at 1, mirroring the main node
      if (newProvider === "anthropic" && temperature > 1) next.temperature = 1;
      setOverrides(nodeId, next);
    },
    [nodeId, overrides, temperature, setOverrides]
  );

  return (
    <ControlsCard
      id={`tmpl-${nodeId}`}
      summary={{ title: modelLabel, values: <SummaryValues items={[`temp ${temperature.toFixed(2)}`]} /> }}
      expanded={isParamsExpanded}
      onToggle={() => setIsParamsExpanded((prev) => !prev)}
    >
      <SelectField label="Provider" value={provider} options={LLM_PROVIDERS} onChange={handleProviderChange} />
      <SelectField
        label="Model"
        value={model}
        options={availableModels}
        onChange={(v) => setOverrides(nodeId, { ...overrides, model: v })}
      />
      <RangeField
        label="Temperature"
        value={temperature}
        min={0}
        max={provider === "anthropic" ? 1 : 2}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => setOverrides(nodeId, { ...overrides, temperature: v })}
      />
      <RangeField
        label="Max tokens"
        value={maxTokens}
        min={256}
        max={16384}
        step={256}
        format={(v) => v.toLocaleString()}
        onChange={(v) => setOverrides(nodeId, { ...overrides, maxTokens: v })}
      />
    </ControlsCard>
  );
}

function GenerateTemplateNode({ id, data, selected }: NodeProps<TemplateRFNode>) {
  const entry = getTemplateEntry(data.nodeType);
  const { controls, browse, provider, title } = useGenerateControls(id, data.overrides);
  return (
    <div className="relative w-full">
      <MiniFloatingHeader title={title} provider={provider} right={browse} />
      <NodeShell
        id={id}
        selected={selected}
        media={{ kind: "fixed", height: EMPTY_MEDIA_HEIGHT }}
        inputs={toSockets(entry.inputs)}
        outputs={toSockets(entry.outputs)}
        controls={controls}
      >
        <EmptyState message="Run to generate" />
      </NodeShell>
    </div>
  );
}

function LlmTemplateNode({ id, data, selected }: NodeProps<TemplateRFNode>) {
  const entry = getTemplateEntry(data.nodeType);
  const controls = useLlmControls(id, data.overrides);
  return (
    <div className="relative w-full">
      <MiniFloatingHeader title={entry.title} />
      <NodeShell
        id={id}
        selected={selected}
        media={{ kind: "fixed", height: 100 }}
        inputs={toSockets(entry.inputs)}
        outputs={toSockets(entry.outputs)}
        controls={controls}
      >
        <EmptyState
          message="AI text generation"
          icon={<span className="[&>svg]:w-6 [&>svg]:h-6">{getTemplateNodeIcon("llmGenerate")}</span>}
        />
      </NodeShell>
    </div>
  );
}

function GenericBody({ nodeType, description }: { nodeType: NodeType; description: string }) {
  const icon = getTemplateNodeIcon(nodeType);
  return <EmptyState message={description} icon={<span className="[&>svg]:w-6 [&>svg]:h-6">{icon}</span>} />;
}

function TemplateNodeComponent(props: NodeProps<TemplateRFNode>) {
  const { id, data, selected } = props;
  const entry = getTemplateEntry(data.nodeType);
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);

  if (!data.isBase && data.nodeType === "nanoBanana") return <GenerateTemplateNode {...props} />;
  if (!data.isBase && data.nodeType === "llmGenerate") return <LlmTemplateNode {...props} />;

  const media =
    data.isBase && data.sourceImage
      ? { kind: "aspect" as const, aspect: sourceAspect ?? 1 }
      : data.nodeType === "prompt"
        ? { kind: "fixed" as const, height: 140 }
        : { kind: "fixed" as const, height: EMPTY_MEDIA_HEIGHT };

  return (
    <div className="relative w-full">
      <MiniFloatingHeader
        title={entry.title}
        right={
          data.isBase ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/25">
              1 per cell
            </span>
          ) : undefined
        }
      />
      <NodeShell
        id={id}
        selected={selected}
        media={media}
        inputs={toSockets(entry.inputs)}
        outputs={toSockets(entry.outputs)}
      >
        {data.isBase ? (
          <BaseImageBody sourceImage={data.sourceImage} onAspect={setSourceAspect} />
        ) : data.nodeType === "prompt" ? (
          <PromptBody nodeId={id} overrides={data.overrides} />
        ) : (
          <GenericBody nodeType={data.nodeType} description={entry.description} />
        )}
      </NodeShell>
    </div>
  );
}

export const SplitGridTemplateNode = memo(TemplateNodeComponent);
