/**
 * Provider models on generation nodes, as the agent sets them.
 *
 * `settings.model` on Generate Image / Video / 3D / Audio names a model from
 * any provider the user has a key for. Finding it needs the network (model
 * listings, schemas), and settings are resolved synchronously inside a
 * transaction, so the tool runtime looks every model of a call up first and
 * hands the answers in through an `AgentModelResolver`. This file holds the
 * pure half: the shapes, the value normalisation both sides key on, the node
 * type ↔ capability map, and what a chosen model writes onto a node.
 *
 * No server imports: the draft (and so this) is also loaded by the prompt
 * builder and the browser's snapshot code.
 */

import type { ModelCapability, ModelInput, ModelParameter, ProviderModel } from "@/lib/providers/types";
import type { NodeType } from "@/types";
import { GENERATE_NODE_TYPES, isGenerateNodeType, modelSelectionData, type GenerateNodeType } from "@/store/utils/modelSelection";

export type { GenerateNodeType };
export { GENERATE_NODE_TYPES, isGenerateNodeType };

/** What the browse dialog filters on per node type (ModelSearchDialog's capability filter). */
export const NODE_TYPE_CAPABILITIES: Record<GenerateNodeType, readonly ModelCapability[]> = {
  nanoBanana: ["text-to-image", "image-to-image"],
  generateVideo: ["text-to-video", "image-to-video", "audio-to-video"],
  generate3d: ["text-to-3d", "image-to-3d"],
  generateAudio: ["text-to-audio"],
};

/** The node types a model with these capabilities can go on, in the browse dialog's order (video, 3D, audio, image). */
export function nodeTypesForCapabilities(capabilities: readonly ModelCapability[]): GenerateNodeType[] {
  const order: GenerateNodeType[] = ["generateVideo", "generate3d", "generateAudio", "nanoBanana"];
  return order.filter((type) => NODE_TYPE_CAPABILITIES[type].some((cap) => capabilities.includes(cap)));
}

export function fitsNodeType(model: Pick<ProviderModel, "capabilities">, type: GenerateNodeType): boolean {
  return NODE_TYPE_CAPABILITIES[type].some((cap) => model.capabilities.includes(cap));
}

/** Providers a model can come from, with the names Settings shows. */
export const MODEL_PROVIDERS = ["gemini", "openai", "kie", "fal", "replicate", "wavespeed", "comfy"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  kie: "Kie.ai",
  fal: "fal.ai",
  replicate: "Replicate",
  wavespeed: "WaveSpeed",
  comfy: "ComfyUI",
};

const PROVIDER_ALIASES: Record<string, ModelProvider> = {
  gemini: "gemini",
  google: "gemini",
  googleai: "gemini",
  openai: "openai",
  chatgpt: "openai",
  kie: "kie",
  kieai: "kie",
  fal: "fal",
  falai: "fal",
  replicate: "replicate",
  wavespeed: "wavespeed",
  wavespeedai: "wavespeed",
  comfy: "comfy",
  comfyui: "comfy",
  comfyrouter: "comfy",
  comfyorg: "comfy",
};

/** A provider name as people write it ("OpenAI", "fal.ai", "ComfyUI") → its id. */
export function normalizeProvider(value: unknown): ModelProvider | undefined {
  if (typeof value !== "string") return undefined;
  return PROVIDER_ALIASES[value.toLowerCase().replace(/[\s_\-.]/g, "")];
}

/** A `settings.model` value, normalised: a bare string, or a provider + id pair. */
export type ModelRef = { kind: "name"; value: string } | { kind: "pair"; provider: string; modelId: string };

/**
 * Accepts "nano-banana-2", {provider, modelId} (or {provider, id}), and the
 * same object sent as a JSON string, which models sometimes do.
 */
export function parseModelRef(value: unknown): ModelRef | { error: string } {
  let raw = value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return { error: `model ${JSON.stringify(trimmed.slice(0, 80))} is not valid JSON; use a model id string or {"provider": "...", "modelId": "..."}.` };
      }
    } else {
      if (!trimmed) return { error: "model is empty; use a model id from search_models." };
      return { kind: "name", value: trimmed };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as Record<string, unknown>;
    const modelId = [object.modelId, object.id, object.model].find((v): v is string => typeof v === "string" && v.trim() !== "");
    const provider = typeof object.provider === "string" ? object.provider.trim() : "";
    if (!modelId) return { error: 'model {…} needs "modelId": the exact id search_models shows.' };
    if (!provider) return { kind: "name", value: modelId.trim() };
    return { kind: "pair", provider, modelId: modelId.trim() };
  }
  return { error: 'model must be a model id string or {"provider": "...", "modelId": "..."} (see search_models).' };
}

/** Stable key for a `settings.model` value, shared by the runtime's lookups and the settings resolver. */
export function modelRefKey(type: NodeType, value: unknown): string {
  const ref = parseModelRef(value);
  if ("error" in ref) return `${type}|invalid|${JSON.stringify(value) ?? ""}`;
  return ref.kind === "name" ? `${type}|name|${ref.value}` : `${type}|pair|${normalizeProvider(ref.provider) ?? ref.provider}|${ref.modelId}`;
}

export interface ModelSchemaLike {
  parameters: ModelParameter[];
  inputs: ModelInput[];
}

export interface ResolvedModel {
  model: ProviderModel;
  schema: ModelSchemaLike;
}

export type ModelLookup = { ok: true; resolved: ResolvedModel } | { ok: false; error: string };
export type SchemaLookup = { ok: true; schema: ModelSchemaLike } | { ok: false; error: string };

/**
 * What the tool runtime looked up before a call ran. Both methods answer
 * from memory; `undefined` means the value was never prepared (the caller
 * then refuses rather than guessing).
 */
export interface AgentModelResolver {
  /** A `settings.model` value on a node of `nodeType`. */
  resolve(nodeType: GenerateNodeType, value: unknown): ModelLookup | undefined;
  /** The settings and inputs of a model a node already uses (for modelParameters). */
  schema(provider: string, modelId: string): SchemaLookup | undefined;
}

/** Every parameter default, as ModelParameters.tsx pre-fills them once the schema loads. */
export function schemaDefaults(parameters: readonly ModelParameter[], current: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const param of parameters) {
    if (param.default !== undefined && out[param.name] === undefined) out[param.name] = structuredCloneSafe(param.default);
  }
  return out;
}

/**
 * The node data a provider model writes, exactly as the node ends up once it
 * has rendered: the browse dialog's selection (modelSelectionData), the
 * schema's defaults filled in, and the schema's inputs as `inputSchema`, so
 * the node's own schema load finds nothing to change.
 */
export function providerModelPatch(type: GenerateNodeType, resolved: ResolvedModel): Record<string, unknown> {
  const selection = modelSelectionData(type, resolved.model) as Record<string, unknown>;
  return {
    ...selection,
    parameters: schemaDefaults(resolved.schema.parameters),
    inputSchema: resolved.schema.inputs.map((input) => ({ ...input })),
  };
}

/** One line per parameter: name, type or values, range and default. For errors and tool results. */
export function describeParameters(parameters: readonly ModelParameter[], max = 20): string {
  if (parameters.length === 0) return "none";
  const lines = parameters.slice(0, max).map((p) => {
    const values = Array.isArray(p.enum) && p.enum.length > 0
      ? p.enum.length > 12 ? `${p.enum.slice(0, 12).map(String).join("|")}|… (${p.enum.length})` : p.enum.map(String).join("|")
      : p.type;
    const range = p.minimum !== undefined || p.maximum !== undefined ? ` ${p.minimum ?? "…"}-${p.maximum ?? "…"}` : "";
    const fallback = p.default !== undefined ? ` default ${JSON.stringify(p.default)}` : "";
    return `${p.name} (${values}${range}${fallback})`;
  });
  return `${lines.join(", ")}${parameters.length > max ? `, … (${parameters.length - max} more)` : ""}`;
}

function structuredCloneSafe<T>(value: T): T {
  return value === null || typeof value !== "object" ? value : (JSON.parse(JSON.stringify(value)) as T);
}
