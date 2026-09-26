/**
 * Turning the agent's `settings` into a `node.data` patch.
 *
 * Settings are a whitelist per node type (catalog.ts). Friendly fields map to
 * the real data: a Gemini `model` on Generate Image writes both `model` and
 * `selectedModel`; any other provider's model (looked up by the tool runtime
 * beforehand, see ./models.ts) writes what the node ends up with once it has
 * loaded the model's schema; `modelParameters` and the Veo settings land in
 * `parameters`; `switches` and `rules` keep the ids (= handle ids) of the
 * entries they match. Every rejection names the valid values so the model can
 * fix its call in one step.
 */

import type { LLMProvider, NodeType } from "@/types";
import { getEasingBezier } from "@/lib/easing-presets";
import {
  defaultLLMModel,
  getEasingNames,
  getImageModel,
  getLLMProvider,
  getSettings,
  getVideoModel,
  IMAGE_MODEL_ALIASES,
  IMAGE_MODELS,
  LEGACY_LLM_MODEL_IDS,
  LLM_PROVIDERS,
  LLM_TEMPERATURE_MAX,
  MATCH_MODES,
  NEVER_SETTABLE,
  NODE_CATALOG,
  normalizeKey,
  REMOVE_BACKGROUND_MODELS,
  VIDEO_MODELS,
  type CatalogSetting,
  type ImageModelSpec,
  type VideoModelSpec,
} from "./catalog";
import type { GraphNodeLike } from "./handles";
import { buildCellTemplate } from "./splitGridCells";
import { createDefaultSplitGridTemplate } from "@/store/utils/nodeDefaults";
import {
  describeParameters,
  fitsNodeType,
  MODEL_PROVIDER_LABELS,
  NODE_TYPE_CAPABILITIES,
  providerModelPatch,
  normalizeProvider,
  parseModelRef,
  type AgentModelResolver,
  type GenerateNodeType,
  type ModelProvider,
  type ModelSchemaLike,
  type ResolvedModel,
} from "./models";
import { validateOpenAIImageParameters } from "@/lib/providers/openaiImages";
import type { ModelParameter } from "@/lib/providers/types";
import {
  cloneJson,
  containsMarker,
  containsOmitted,
  fullTextLength,
  isMediaString,
  isTruncatedText,
  MEDIA_PLACEHOLDER,
  SHORTEST_TEXT_VIEW,
  TRUNCATED_MARKER,
} from "./scrub";

export interface SettingsOutcome {
  /** Real data fields to shallow-merge into node.data. */
  patch: Record<string, unknown>;
  errors: string[];
  /** Adjustments made on the model's behalf (clamped values, provider switches). */
  warnings: string[];
  /** "aspectRatio=16:9", for the tool result. */
  changes: string[];
  /** The model changed in a way that can change the node's handles. */
  handlesMayChange: boolean;
  /** Worth telling the agent, e.g. the settings a newly chosen model takes. */
  notes: string[];
}

export interface SettingsContext {
  /** A fresh random id (7 base36 chars), for new switch outputs and rules. */
  newId: () => string;
  /**
   * Provider models looked up before the call (search, schemas). Without it
   * only Gemini models can be set, from the built-in catalog.
   */
  models?: AgentModelResolver;
  /**
   * New-node data per type (the user's saved defaults), for nodes that exist
   * only inside another node's settings: a Split Grid's cells.
   */
  createDefaultNodeData?: (type: NodeType) => Record<string, unknown>;
}

const MAX_STRING = 50_000;
const GENERATOR_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generate3d", "generateAudio", "llmGenerate"]);
const PROMPT_LIKE_FIELDS = new Set(["prompt", "text", "systemprompt", "system", "instructions", "negativeprompt", "inputprompt"]);

type Handler = (ctx: FieldRun) => void;

interface FieldRun {
  node: GraphNodeLike;
  /** Remaining settings, keyed by the model's field name. */
  settings: Map<string, unknown>;
  out: SettingsOutcome;
  context: SettingsContext;
  label: string;
}

/**
 * Validates `settings` for `node` and returns the patch. Nothing is applied:
 * the caller merges `patch` only when `errors` is empty.
 */
export function resolveSettings(
  node: GraphNodeLike,
  settings: Record<string, unknown> | undefined,
  context: SettingsContext,
): SettingsOutcome {
  const out: SettingsOutcome = { patch: {}, errors: [], warnings: [], changes: [], handlesMayChange: false, notes: [] };
  if (!settings) return out;
  if (typeof settings !== "object" || Array.isArray(settings)) {
    out.errors.push("settings must be an object of field → value.");
    return out;
  }

  const entry = NODE_CATALOG[node.type];
  const label = `${node.id} (${entry.displayName})`;
  const remaining = new Map<string, unknown>();
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    // The title is a node field, but models reach for it in settings.
    if (key === "title" || key === "customTitle") {
      applyTitle(value, out);
      continue;
    }
    remaining.set(key, value);
  }

  const run: FieldRun = { node, settings: remaining, out, context, label };
  CUSTOM_HANDLERS[node.type]?.(run);

  const allowed = getSettings(node.type);
  for (const [key, value] of remaining) {
    const setting = allowed.find((s) => s.field === key) ?? allowed.find((s) => normalizeKey(s.field) === normalizeKey(key));
    if (!setting) {
      out.errors.push(unknownFieldError(node.type, label, key, allowed));
      continue;
    }
    const result = coerce(setting, value);
    if ("error" in result) {
      out.errors.push(`${label}: ${result.error}`);
      continue;
    }
    set(out, setting.field, result.value);
  }
  return out;
}

/** Title as written by the model; empty clears it. */
export function applyTitle(value: unknown, out: SettingsOutcome): void {
  if (value !== null && typeof value !== "string") {
    out.errors.push("title must be a string (empty string clears it).");
    return;
  }
  const title = (value ?? "").trim();
  out.patch.customTitle = title ? title.slice(0, 120) : null;
  out.changes.push(title ? `title="${title.slice(0, 120)}"` : "title cleared");
}

function set(out: SettingsOutcome, field: string, value: unknown, change?: string): void {
  out.patch[field] = value;
  out.changes.push(change ?? `${field}=${formatValue(value)}`);
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value.length > 60 ? JSON.stringify(`${value.slice(0, 57)}...`) : JSON.stringify(value);
  const json = JSON.stringify(value);
  return json && json.length > 80 ? `${json.slice(0, 77)}...` : String(json);
}

function unknownFieldError(type: NodeType, label: string, key: string, allowed: readonly CatalogSetting[]): string {
  const valid = allowed.map((s) => s.field).join(", ");
  const normalized = normalizeKey(key);
  if (GENERATOR_TYPES.has(type) && PROMPT_LIKE_FIELDS.has(normalized)) {
    return `${label} has no "${key}" setting: its prompt comes from the node connected to its text input. Put the text in a Prompt node (settings.prompt) and connect it to this node's text input.`;
  }
  if (isModelNodeType(type) && (normalized === "provider" || normalized === "modelid")) {
    return `${label}: set "model" instead, to an id from search_models (a string, or {"provider": "...", "modelId": "..."}). Settable: ${valid || "none"}.`;
  }
  if (normalized === "parameters") {
    const own = isModelNodeType(type) ? ` Use modelParameters {name: value} for the model's own settings (names from the error or the result of setting the model).${type === "generateVideo" ? " For Gemini video models aspectRatio, resolution, durationSeconds (Veo) and task (Omni) also work." : ""}` : "";
    return `${label}: "parameters" cannot be set directly.${own} Settable: ${valid || "none"}.`;
  }
  const reason = Object.entries(NEVER_SETTABLE).find(([field]) => normalizeKey(field) === normalized)?.[1];
  if (reason) {
    return `${label}: "${key}" cannot be set (${reason}). Settable: ${valid || "none"}.`;
  }
  return `${label} has no setting "${key}". Settable: ${valid || "none"}.`;
}

// ---------------------------------------------------------------------------
// Generic coercion
// ---------------------------------------------------------------------------

type Coerced = { value: unknown } | { error: string };

function coerce(setting: CatalogSetting, value: unknown): Coerced {
  const field = setting.field;
  switch (setting.kind) {
    case "string": {
      if (value === null) return { value: "" };
      if (typeof value === "number" || typeof value === "boolean") return { value: String(value) };
      if (typeof value !== "string") return { error: `${field} must be a string.` };
      if (value.length > MAX_STRING) return { error: `${field} is too long (${value.length} characters; max ${MAX_STRING}).` };
      if (isMediaString(value)) return { error: `${field} cannot hold media data; images, audio and video come from connections or the user's uploads.` };
      if (containsMarker(value)) return { error: markerError(field, value) };
      return { value };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      if (value === "true" || value === "false") return { value: value === "true" };
      return { error: `${field} must be true or false.` };
    }
    case "number":
    case "integer": {
      const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(num)) return { error: `${field} must be a number${rangeText(setting)}.` };
      if (setting.kind === "integer" && !Number.isInteger(num)) return { error: `${field} must be a whole number${rangeText(setting)}.` };
      if ((setting.min !== undefined && num < setting.min) || (setting.max !== undefined && num > setting.max)) {
        return { error: `${field} must be${rangeText(setting)} (got ${num}).` };
      }
      return { value: num };
    }
    case "enum": {
      const match = matchEnum(setting.values ?? [], value);
      if (match === undefined) return { error: `${field} must be one of: ${(setting.values ?? []).join(", ")} (got ${formatValue(value)}).` };
      return { value: match };
    }
    default:
      return { error: `${field} cannot be set this way.` };
  }
}

/**
 * A value copied from one of the agent's cut views still carries the marker
 * that stood in for the rest; writing it back would replace the real content.
 */
function markerError(field: string, value: string): string {
  if (value.includes(TRUNCATED_MARKER)) {
    return `${field} still contains the "${TRUNCATED_MARKER} …]" marker: you were shown only part of the text, and writing it back would delete the rest. Change part of a prompt or template with promptEdit/templateEdit, or write a complete new text.`;
  }
  const marker = value.includes(MEDIA_PLACEHOLDER) ? MEDIA_PLACEHOLDER : "[omitted: …]";
  return `${field} contains the placeholder "${marker}", which stands in for content you were not shown; it is not a real value. Leave ${field} out or give a real value.`;
}

function rangeText(setting: { min?: number; max?: number }): string {
  if (setting.min !== undefined && setting.max !== undefined) return ` between ${setting.min} and ${setting.max}`;
  if (setting.min !== undefined) return ` of at least ${setting.min}`;
  if (setting.max !== undefined) return ` of at most ${setting.max}`;
  return "";
}

/**
 * Exact, then case/separator-insensitive, then number↔string. Placeholders a
 * cut list carries ("[omitted: N more items]") are never a match.
 */
export function matchEnum<T extends string | number>(allValues: readonly T[], value: unknown): T | undefined {
  if (typeof value === "string" && containsMarker(value)) return undefined;
  const values = allValues.filter((v) => typeof v !== "string" || !containsMarker(v));
  if (values.includes(value as T)) return value as T;
  if (typeof value === "string") {
    const key = normalizeKey(value);
    const found = values.find((v) => normalizeKey(String(v)) === key);
    if (found !== undefined) return found;
  }
  if (typeof value === "number") return values.find((v) => String(v) === String(value));
  return undefined;
}

function take(run: FieldRun, field: string): { present: boolean; value: unknown } {
  for (const key of run.settings.keys()) {
    if (key === field || normalizeKey(key) === normalizeKey(field)) {
      const value = run.settings.get(key);
      run.settings.delete(key);
      return { present: true, value };
    }
  }
  return { present: false, value: undefined };
}

function coerceField(run: FieldRun, field: string, value: unknown): Coerced {
  const setting = getSettings(run.node.type).find((s) => s.field === field);
  if (!setting) return { error: `${field} is not a setting of ${run.label}.` };
  return coerce(setting, value);
}

// ---------------------------------------------------------------------------
// Per-type handlers
// ---------------------------------------------------------------------------

const CUSTOM_HANDLERS: Partial<Record<NodeType, Handler>> = {
  nanoBanana: handleGenerateImage,
  generateVideo: handleGenerateVideo,
  generate3d: handleProviderModelNode,
  generateAudio: handleProviderModelNode,
  llmGenerate: handleLLM,
  prompt: handlePrompt,
  promptConstructor: handlePromptConstructor,
  array: handleArray,
  splitGrid: handleSplitGrid,
  easeCurve: handleEaseCurve,
  videoTrim: handleVideoTrim,
  removeBackground: handleRemoveBackground,
  videoFrameGrab: handleFrameGrab,
  imageResize: handleImageResize,
  gifEncoder: handleGifEncoder,
  switch: handleSwitch,
  conditionalSwitch: handleConditionalSwitch,
  comfyApp: handleComfyApp,
};

// --- Generate Image -------------------------------------------------------

export function resolveImageModelId(value: unknown): ImageModelSpec | undefined {
  if (typeof value !== "string") return undefined;
  const direct = getImageModel(value);
  if (direct) return direct;
  const key = normalizeKey(value);
  const aliased = Object.entries(IMAGE_MODEL_ALIASES).find(([alias]) => normalizeKey(alias) === key)?.[1];
  if (aliased) return getImageModel(aliased);
  return IMAGE_MODELS.find((m) => normalizeKey(m.id) === key || normalizeKey(m.label) === key);
}

function normalizeAspectRatio(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+)\s*[:x/×]\s*(\d+)$/i);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function ratioOf(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

/** The supported aspect ratio closest to `aspect` (compared on a log scale). */
function nearestAspectRatio(aspect: string, supported: readonly string[]): string {
  const target = Math.log(ratioOf(aspect));
  let best = supported[0];
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = Math.abs(Math.log(ratioOf(candidate)) - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeResolution(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const lower = text.toLowerCase().replace(/px$/, "");
  if (lower === "512") return "512";
  const k = lower.match(/^(\d)k$/);
  if (k) return `${k[1]}K`;
  const map: Record<string, string> = { "1024": "1K", "2048": "2K", "4096": "4K" };
  return map[lower];
}

function handleGenerateImage(run: FieldRun): void {
  const { node, out, label } = run;
  const selected = node.data.selectedModel as { provider?: string; modelId?: string; displayName?: string } | undefined;
  const currentProvider = selected?.provider ?? "gemini";
  const currentModelId = currentProvider === "gemini" ? selected?.modelId || (node.data.model as string | undefined) : undefined;

  const modelSetting = take(run, "model");
  const modelParameters = take(run, "modelParameters");
  const aspect = take(run, "aspectRatio");
  const resolution = take(run, "resolution");
  const googleSearch = take(run, "useGoogleSearch");
  const imageSearch = take(run, "useImageSearch");
  let spec: ImageModelSpec | undefined = getImageModel(currentModelId);
  let modelChanged = false;
  let chosen: ResolvedModel | undefined;
  if (modelSetting.present) {
    const decision = decideModel(run, "nanoBanana", modelSetting.value);
    if (decision.kind === "error") {
      out.errors.push(`${label}: ${decision.error}`);
      return;
    }
    if (decision.kind === "provider") {
      // Another provider's model: what the browse dialog writes, completed as
      // the node completes it once its schema loads. Gemini-only fields stay
      // as they are, unused, exactly as when the user picks the model.
      spec = undefined;
      chosen = decision.resolved;
      modelChanged = true;
      applyProviderModel(run, "nanoBanana", decision.resolved);
    } else if (decision.kind === "gemini-image") {
      const resolved = decision.spec;
      spec = resolved;
      modelChanged = resolved.id !== currentModelId || currentProvider !== "gemini";
      set(out, "model", resolved.id, `model=${resolved.id}`);
      out.patch.selectedModel = { provider: "gemini", modelId: resolved.id, displayName: resolved.label };
      if (currentProvider !== "gemini") {
        // The node's sockets are fixed (image, text), so its handles stay; only the old model's settings go.
        out.patch.parameters = {};
        out.patch.inputSchema = [];
        out.warnings.push(`${node.id} switched from ${selected?.displayName || currentProvider} (${currentProvider}) to ${resolved.label}; that model's parameters were cleared.`);
      }
    }
  }

  const touchesGeminiOptions = aspect.present || resolution.present || googleSearch.present || imageSearch.present;

  if (!spec) {
    if (touchesGeminiOptions) {
      const name = chosen ? `${chosen.model.name} (${chosen.model.provider})` : `${selected?.displayName || "a non-Gemini model"} (${currentProvider})`;
      out.errors.push(
        `${label} uses ${name}; aspectRatio, resolution and the search options apply to Gemini models only. Set this model's own settings with modelParameters (e.g. {"modelParameters": {"size": "1536x1024"}}), or set model to a Gemini model in the same call.`,
      );
    }
    applyModelParameters(run, "nanoBanana", modelParameters, chosen);
    return;
  }
  if (modelParameters.present) {
    out.errors.push(`${label}: ${spec.label} (Gemini) has no modelParameters; its settings are aspectRatio, resolution, useGoogleSearch and useImageSearch.`);
  }

  if (aspect.present) {
    const normalized = normalizeAspectRatio(aspect.value);
    if (!normalized || !spec.aspectRatios.includes(normalized as never)) {
      const extra = normalized && ["1:4", "1:8", "4:1", "8:1"].includes(normalized) ? " (1:4, 1:8, 4:1 and 8:1 need nano-banana-2)" : "";
      out.errors.push(`${label}: aspectRatio ${formatValue(aspect.value)} is not available on ${spec.id}${extra}. Use one of: ${spec.aspectRatios.join(", ")}.`);
    } else {
      set(out, "aspectRatio", normalized);
    }
  } else if (modelChanged) {
    const current = typeof node.data.aspectRatio === "string" ? node.data.aspectRatio : undefined;
    if (current && !spec.aspectRatios.includes(current as never)) {
      const nearest = nearestAspectRatio(current, spec.aspectRatios);
      set(out, "aspectRatio", nearest);
      out.warnings.push(`${node.id}: ${spec.id} does not support aspect ratio ${current}; changed it to ${nearest}.`);
    }
  }

  if (resolution.present) {
    const normalized = normalizeResolution(resolution.value);
    if (spec.resolutions.length === 0) {
      out.errors.push(`${label}: ${spec.id} has no resolution setting (only nano-banana-pro and nano-banana-2 do). Change model too, or leave resolution out.`);
    } else if (!normalized || !spec.resolutions.includes(normalized as never)) {
      out.errors.push(`${label}: resolution ${formatValue(resolution.value)} is not available on ${spec.id}. Use one of: ${spec.resolutions.join(", ")}.`);
    } else {
      set(out, "resolution", normalized);
    }
  } else if (modelChanged && spec.resolutions.length > 0) {
    const current = typeof node.data.resolution === "string" ? node.data.resolution : undefined;
    if (current && !spec.resolutions.includes(current as never)) {
      set(out, "resolution", spec.resolutions[0]);
      out.warnings.push(`${node.id}: ${spec.id} does not support resolution ${current}; changed it to ${spec.resolutions[0]}.`);
    }
  }

  const searchFlag = (setting: { present: boolean; value: unknown }, field: "useGoogleSearch" | "useImageSearch", supported: boolean, supportedBy: string) => {
    if (setting.present) {
      const coerced = coerceField(run, field, setting.value);
      if ("error" in coerced) {
        out.errors.push(`${label}: ${coerced.error}`);
      } else if (coerced.value === true && !supported) {
        out.errors.push(`${label}: ${field} is not available on ${spec!.id} (${supportedBy} only).`);
      } else {
        set(out, field, coerced.value);
      }
    } else if (modelChanged && node.data[field] === true && !supported) {
      set(out, field, false);
      out.warnings.push(`${node.id}: turned ${field} off; ${spec!.id} does not support it.`);
    }
  };
  searchFlag(googleSearch, "useGoogleSearch", spec.googleSearch, "nano-banana-pro and nano-banana-2");
  searchFlag(imageSearch, "useImageSearch", spec.imageSearch, "nano-banana-2");
}

// --- Generate Video -------------------------------------------------------

export function resolveVideoModelId(value: unknown): { id: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "model must be a Gemini video model id (Veo or Gemini Omni)." };
  const direct = getVideoModel(value.trim());
  if (direct) return { id: direct.id };
  const key = (text: string) => normalizeKey(text).replace(/\//g, "");
  const expanded = value.trim().toLowerCase().replace(/\bi2v\b/, "image-to-video").replace(/\bt2v\b/, "text-to-video");
  const byId = VIDEO_MODELS.find((m) => key(m.id) === key(expanded));
  if (byId) return { id: byId.id };
  // "veo-3.1" (or its label "Veo 3.1") names a family: text- or image-to-video
  // is a real choice (it changes the node's inputs), so ask for it.
  const family = VIDEO_MODELS.filter((m) => normalizeKey(m.id.split("/")[0]) === normalizeKey(value));
  if (family.length > 1) {
    return { error: `model "${value}" is ambiguous: use ${family.map((m) => `"${m.id}" (${m.mode === "image-to-video" ? "animates a connected image" : "prompt only"})`).join(" or ")}.` };
  }
  const byLabel = VIDEO_MODELS.find((m) => normalizeKey(m.label) === normalizeKey(value));
  if (byLabel) return { id: byLabel.id };
  return {
    error: `model ${formatValue(value)} is not one you can set. Use a Gemini video model: ${VIDEO_MODELS.map((m) => m.id).join(", ")}. For other providers' video models, tell the user to pick one in the node.`,
  };
}

const VIDEO_PARAMETER_FIELDS = ["aspectRatio", "durationSeconds", "resolution", "task"] as const;

function handleGenerateVideo(run: FieldRun): void {
  const { node, out, label } = run;
  const selected = node.data.selectedModel as { provider?: string; modelId?: string; displayName?: string } | undefined;
  let spec: VideoModelSpec | undefined = selected?.provider === "gemini" || !selected?.provider ? getVideoModel(selected?.modelId) : undefined;
  let parameters: Record<string, unknown> = isRecord(node.data.parameters) ? cloneJson(node.data.parameters) : {};

  const modelSetting = take(run, "model");
  const modelParameters = take(run, "modelParameters");
  const provided = VIDEO_PARAMETER_FIELDS.map((field) => ({ field, ...take(run, field) })).filter((f) => f.present);
  let chosen: ResolvedModel | undefined;
  if (modelSetting.present) {
    const decision = decideModel(run, "generateVideo", modelSetting.value);
    if (decision.kind === "error") {
      out.errors.push(`${label}: ${decision.error}`);
      return;
    }
    if (decision.kind === "provider" || (decision.kind === "gemini-video" && decision.resolved)) {
      // What the node ends up with: the browse dialog's selection, then the
      // schema's defaults and inputs (which define the handles).
      chosen = decision.resolved!;
      spec = decision.kind === "gemini-video" ? decision.spec : undefined;
      applyProviderModel(run, "generateVideo", chosen);
      parameters = cloneJson(out.patch.parameters as Record<string, unknown>);
    } else if (decision.kind === "gemini-video") {
      spec = decision.spec;
      parameters = {};
      // What picking the model in the node writes (modelSelectionData): the
      // selection, cleared parameters and the schema that defines the handles.
      set(out, "selectedModel", { provider: "gemini", modelId: spec.id, displayName: spec.label }, `model=${spec.id}`);
      out.patch.parameters = parameters;
      out.patch.inputSchema = cloneJson(spec.inputSchema);
      out.handlesMayChange = true;
    }
  }

  if (provided.length > 0) {
    if (!spec) {
      const name = chosen ? chosen.model.name : selected?.displayName || "no model yet";
      out.errors.push(
        `${label}: ${provided.map((f) => f.field).join(", ")} can only be set this way for Gemini video models (Veo, Gemini Omni), and this node uses ${name}. Use modelParameters for this model's own settings, or set model to a Gemini video model in the same call.`,
      );
      return;
    }
    if (!modelSetting.present && containsOmitted(parameters)) {
      out.errors.push(`${label}: its current parameters are too large to edit safely here; ask the user to change them in the node.`);
      return;
    }
    for (const { field, value } of provided) {
      const values = spec.parameters[field];
      if (!values) {
        const own = Object.keys(spec.parameters);
        out.errors.push(`${label}: ${spec.label} has no ${field} setting${field === "durationSeconds" && spec.family === "omni" ? " (Omni takes the duration, 3-10 seconds, from the prompt)" : ""}. Its settings: ${own.join(", ")}.`);
        continue;
      }
      const match = matchEnum(values, typeof value === "number" ? String(value) : value);
      if (match === undefined) {
        out.errors.push(`${label}: ${field} must be one of: ${values.join(", ")} on ${spec.label} (got ${formatValue(value)}).`);
        continue;
      }
      parameters[field] = match;
      out.changes.push(`${field}=${match}`);
    }
    out.patch.parameters = parameters;
  }
  applyModelParameters(run, "generateVideo", modelParameters, chosen);
}

// --- Generate 3D / Generate Audio -------------------------------------------

/** Nodes whose only settings are a provider model and its parameters. */
function handleProviderModelNode(run: FieldRun): void {
  const type = run.node.type as GenerateNodeType;
  const modelSetting = take(run, "model");
  const modelParameters = take(run, "modelParameters");
  let chosen: ResolvedModel | undefined;
  if (modelSetting.present) {
    const decision = decideModel(run, type, modelSetting.value);
    if (decision.kind === "error") {
      run.out.errors.push(`${run.label}: ${decision.error}`);
      return;
    }
    if (decision.kind !== "provider") {
      run.out.errors.push(`${run.label}: Gemini has no ${NODE_CATALOG[type].displayName} models; call search_models with nodeType "${type}".`);
      return;
    }
    chosen = decision.resolved;
    applyProviderModel(run, type, chosen);
  }
  applyModelParameters(run, type, modelParameters, chosen);
}

// --- Provider models (all generation nodes) ---------------------------------

export function isModelNodeType(type: NodeType): type is GenerateNodeType {
  return type === "nanoBanana" || type === "generateVideo" || type === "generate3d" || type === "generateAudio";
}

type ModelDecision =
  | { kind: "error"; error: string }
  | { kind: "gemini-image"; spec: ImageModelSpec }
  /** `resolved` is present when the model was looked up (its schema is then what the node loads). */
  | { kind: "gemini-video"; spec: VideoModelSpec; resolved?: ResolvedModel }
  | { kind: "provider"; resolved: ResolvedModel };

/**
 * What a `settings.model` value names. With the runtime's lookups, any
 * provider's model (the runtime already checked keys, capability and
 * ambiguity); without them, only the Gemini models of the built-in catalog.
 */
function decideModel(run: FieldRun, type: GenerateNodeType, value: unknown): ModelDecision {
  const models = run.context.models;
  if (!models) return decideGeminiOnly(type, value);
  const lookup = models.resolve(type, value);
  if (!lookup) return { kind: "error", error: `model ${formatValue(value)} was not looked up before this call ran; call the tool again.` };
  if (!lookup.ok) return { kind: "error", error: lookup.error };
  const { model } = lookup.resolved;
  if (!fitsNodeType(model, type)) {
    return { kind: "error", error: `${model.name} (${model.provider} ${model.id}) makes ${model.capabilities.join(", ") || "nothing this node can use"}, not ${NODE_TYPE_CAPABILITIES[type].join(" or ")}.` };
  }
  if (model.provider === "gemini") {
    if (type === "nanoBanana") {
      const spec = getImageModel(model.id);
      if (spec) return { kind: "gemini-image", spec };
    }
    if (type === "generateVideo") {
      const spec = getVideoModel(model.id);
      if (spec) return { kind: "gemini-video", spec, resolved: lookup.resolved };
    }
  }
  return { kind: "provider", resolved: lookup.resolved };
}

function decideGeminiOnly(type: GenerateNodeType, value: unknown): ModelDecision {
  const parsed = parseModelRef(value);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  if (parsed.kind === "pair" && normalizeProvider(parsed.provider) !== "gemini") {
    return { kind: "error", error: `${parsed.provider} models can only be set after search_models has found them; call search_models, then set the model again.` };
  }
  const id = parsed.kind === "pair" ? parsed.modelId : parsed.value;
  if (type === "nanoBanana") {
    const spec = resolveImageModelId(id);
    if (spec) return { kind: "gemini-image", spec };
    return { kind: "error", error: `model ${formatValue(value)} is not a Gemini image model. Use one of: ${IMAGE_MODELS.map((m) => m.id).join(", ")}, or find another provider's model with search_models.` };
  }
  if (type === "generateVideo") {
    const resolved = resolveVideoModelId(id);
    if ("error" in resolved) return { kind: "error", error: resolved.error };
    return { kind: "gemini-video", spec: getVideoModel(resolved.id)! };
  }
  return { kind: "error", error: `${NODE_CATALOG[type].displayName} models come from other providers; find one with search_models (nodeType "${type}") and set it.` };
}

/**
 * Writes a looked-up model as the node ends up with it once rendered
 * (selection, schema defaults, schema inputs), and tells the agent the
 * settings it now takes.
 */
function applyProviderModel(run: FieldRun, type: GenerateNodeType, resolved: ResolvedModel): void {
  const { model, schema } = resolved;
  Object.assign(run.out.patch, providerModelPatch(type, resolved));
  run.out.changes.push(`model=${model.id}${model.provider === "gemini" ? "" : ` (${model.provider})`}`);
  run.out.handlesMayChange = true;
  const provider = MODEL_PROVIDER_LABELS[model.provider as ModelProvider] ?? model.provider;
  const inputs = type === "nanoBanana"
    ? ""
    : ` Its inputs: ${schema.inputs.map((i) => `${i.name} (${i.type}${i.required ? ", required" : ""}${i.isArray ? ", accepts many" : ""})`).join(", ") || "none listed"}.`;
  run.out.notes.push(`${run.node.id} now uses ${model.name} (${provider}, ${model.id}). Its modelParameters: ${describeParameters(schema.parameters)}.${inputs}`);
}

/**
 * `modelParameters`: the model's own settings (what the node's settings card
 * shows), checked against its schema. Merged over the defaults of a model set
 * in the same call, else over the node's current parameters. null resets one
 * to its default.
 */
function applyModelParameters(run: FieldRun, type: GenerateNodeType, setting: { present: boolean; value: unknown }, chosen: ResolvedModel | undefined): void {
  if (!setting.present) return;
  const { node, out, label } = run;
  const values = typeof setting.value === "string" ? parseJsonObject(setting.value) : setting.value;
  if (!isRecord(values)) {
    out.errors.push(`${label}: modelParameters must be an object {parameterName: value}, e.g. {"quality": "high"}.`);
    return;
  }
  let schema: ModelSchemaLike;
  let provider: string;
  let modelId: string;
  let name: string;
  if (chosen) {
    ({ schema } = chosen);
    provider = chosen.model.provider;
    modelId = chosen.model.id;
    name = chosen.model.name;
  } else {
    const selected = node.data.selectedModel as { provider?: string; modelId?: string; displayName?: string } | undefined;
    if (!selected?.provider || !selected.modelId) {
      out.errors.push(`${label} has no model yet: set model (an id from search_models) in the same call as modelParameters.`);
      return;
    }
    provider = selected.provider;
    modelId = selected.modelId;
    name = selected.displayName || selected.modelId;
    const lookup = run.context.models?.schema(provider, modelId);
    if (!lookup) {
      out.errors.push(`${label}: the settings of ${name} were not looked up before this call ran; call the tool again.`);
      return;
    }
    if (!lookup.ok) {
      out.errors.push(`${label}: could not read the settings of ${name} (${lookup.error}); ask the user to change them in the node.`);
      return;
    }
    schema = lookup.schema;
  }
  const base = isRecord(out.patch.parameters) ? out.patch.parameters : isRecord(node.data.parameters) ? node.data.parameters : {};
  if (out.patch.parameters === undefined && containsOmitted(base)) {
    out.errors.push(`${label}: its current parameters are too large to edit safely here; ask the user to change them in the node.`);
    return;
  }
  const next: Record<string, unknown> = cloneJson(base);
  let failed = false;
  for (const [key, value] of Object.entries(values)) {
    const param = schema.parameters.find((p) => p.name === key) ?? schema.parameters.find((p) => normalizeKey(p.name) === normalizeKey(key));
    if (!param) {
      const input = schema.inputs.find((i) => i.name === key || normalizeKey(i.name) === normalizeKey(key));
      out.errors.push(
        input
          ? `${label}: "${input.name}" is an input of ${name}, not a setting: connect a ${input.type} node to it${type === "nanoBanana" ? "" : ` (handle "${input.name}")`}.`
          : `${label}: ${name} has no parameter "${key}". Its parameters: ${describeParameters(schema.parameters, 40)}.`,
      );
      failed = true;
      continue;
    }
    if (value === null) {
      if (param.default !== undefined) next[param.name] = cloneJson(param.default);
      else delete next[param.name];
      out.changes.push(`${param.name} reset`);
      continue;
    }
    const coerced = coerceModelParameter(param, value);
    if ("error" in coerced) {
      out.errors.push(`${label}: ${coerced.error}`);
      failed = true;
      continue;
    }
    next[param.name] = coerced.value;
    out.changes.push(`${param.name}=${formatValue(coerced.value)}`);
  }
  if (failed) return;
  if (provider === "openai") {
    const problem = validateOpenAIImageParameters(modelId, next);
    if (problem) {
      out.errors.push(`${label}: ${problem}`);
      return;
    }
  }
  out.patch.parameters = next;
}

const MODEL_ENUM_LISTED = 30;

function coerceModelParameter(param: ModelParameter, value: unknown): Coerced {
  const name = param.name;
  if (Array.isArray(param.enum) && param.enum.length > 0) {
    const options = param.enum.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
    const match = matchEnum(options, value);
    if (match !== undefined) return { value: match };
    const listed = options.slice(0, MODEL_ENUM_LISTED).join(", ");
    return { error: `${name} must be one of: ${listed}${options.length > MODEL_ENUM_LISTED ? `, … (${options.length} options)` : ""} (got ${formatValue(value)}).` };
  }
  switch (param.type) {
    case "boolean":
      return coerce({ field: name, kind: "boolean", description: "" }, value);
    case "number":
    case "integer":
      return coerce({ field: name, kind: param.type, min: param.minimum, max: param.maximum, description: "" }, value);
    case "array": {
      const items = Array.isArray(value) ? value : [value];
      const out: unknown[] = [];
      for (const item of items) {
        if (typeof item === "number" || typeof item === "boolean") {
          out.push(item);
          continue;
        }
        const text = coerce({ field: name, kind: "string", description: "" }, item);
        if ("error" in text) return { error: `${name}: every item must be a plain value. ${text.error}` };
        out.push(text.value);
      }
      return { value: out };
    }
    default:
      return coerce({ field: name, kind: "string", description: "" }, value);
  }
}

// --- LLM Generate ---------------------------------------------------------

const LLM_PROVIDER_ALIASES: Record<string, LLMProvider> = {
  google: "google",
  gemini: "google",
  openai: "openai",
  gpt: "openai",
  chatgpt: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
};

type LLMModelChoice = { id: string; label: string; provider: LLMProvider };

/**
 * A model the node's menu offers, by id or label. An id from an older release
 * is not offered any more: a retired one resolves to its replacement (what
 * the LLM route would run instead), one the provider still serves is refused.
 */
export function resolveLLMModelSetting(value: unknown): { model: LLMModelChoice; note?: string } | { error: string } {
  const all: LLMModelChoice[] = LLM_PROVIDERS.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id })));
  const current = LLM_PROVIDERS.map((p) => `${p.id}: ${p.models.map((m) => m.id).join(", ")}`).join("; ");
  const key = typeof value === "string" ? normalizeKey(value) : "";
  const model = all.find((m) => m.id === value) ?? (key ? all.find((m) => normalizeKey(m.id) === key || normalizeKey(m.label) === key) : undefined);
  if (model) return { model };
  const legacy = key ? [...LEGACY_LLM_MODEL_IDS.values()].find((m) => m.id === value || normalizeKey(m.id) === key || normalizeKey(m.label) === key) : undefined;
  if (!legacy) return { error: `model ${formatValue(value)} is not available. ${current}.` };
  const replacement = legacy.status === "retired" && legacy.replacement ? all.find((m) => m.id === legacy.replacement) : undefined;
  if (replacement) {
    return { model: replacement, note: `${legacy.label} (${legacy.id}) is retired; used ${replacement.label} (${replacement.id}) instead.` };
  }
  return { error: `${legacy.id} is an older model the node no longer offers. Use one of: ${current}.` };
}

function handleLLM(run: FieldRun): void {
  const { node, out, label } = run;
  const currentProvider = (getLLMProvider(node.data.provider as string)?.id ?? "google") as LLMProvider;
  const providerSetting = take(run, "provider");
  const modelSetting = take(run, "model");
  const temperatureSetting = take(run, "temperature");

  let provider = currentProvider;
  if (providerSetting.present) {
    const resolved = typeof providerSetting.value === "string" ? LLM_PROVIDER_ALIASES[normalizeKey(providerSetting.value)] : undefined;
    if (!resolved) {
      out.errors.push(`${label}: provider must be one of: ${LLM_PROVIDERS.map((p) => p.id).join(", ")} (got ${formatValue(providerSetting.value)}).`);
      return;
    }
    provider = resolved;
  }

  // The node's current model is kept as is, even an older one its menu still lists for it.
  const keepsCurrent = modelSetting.present && modelSetting.value === node.data.model && (!providerSetting.present || provider === currentProvider);
  if (modelSetting.present && !keepsCurrent) {
    const resolved = resolveLLMModelSetting(modelSetting.value);
    if ("error" in resolved) {
      out.errors.push(`${label}: ${resolved.error}`);
      return;
    }
    const model = resolved.model;
    if (resolved.note) out.warnings.push(`${node.id}: ${resolved.note}`);
    if (providerSetting.present && model.provider !== provider) {
      out.errors.push(`${label}: model ${model.id} belongs to provider ${model.provider}, not ${provider}.`);
      return;
    }
    if (model.provider !== currentProvider && !providerSetting.present) {
      out.warnings.push(`${node.id}: switched provider to ${model.provider} to use ${model.id}.`);
    }
    provider = model.provider;
    set(out, "model", model.id);
  } else if (!keepsCurrent && provider !== currentProvider) {
    const first = defaultLLMModel(provider);
    set(out, "model", first);
    out.warnings.push(`${node.id}: provider ${provider} starts on its first model, ${first}.`);
  }
  if (provider !== currentProvider || providerSetting.present) set(out, "provider", provider);

  const maxTemperature = LLM_TEMPERATURE_MAX[provider];
  if (temperatureSetting.present) {
    const coerced = coerce({ field: "temperature", kind: "number", min: 0, max: maxTemperature, description: "" }, temperatureSetting.value);
    if ("error" in coerced) out.errors.push(`${label}: ${coerced.error.replace(/\.$/, "")}${provider === "anthropic" ? " (anthropic allows 0-1)." : "."}`);
    else set(out, "temperature", coerced.value);
  } else if (provider !== currentProvider && typeof node.data.temperature === "number" && node.data.temperature > maxTemperature) {
    set(out, "temperature", maxTemperature);
    out.warnings.push(`${node.id}: temperature lowered to ${maxTemperature}, the ${provider} maximum.`);
  }

  const spec = getLLMProvider(provider)!;
  if (spec.id !== "google" && (providerSetting.present || modelSetting.present)) {
    out.warnings.push(`${node.id}: ${spec.label} models need ${spec.requires} in Node Banana's settings.`);
  }
}

// --- Prompt ---------------------------------------------------------------

function handlePrompt(run: FieldRun): void {
  const { out, label } = run;
  handleLongText(run, "prompt", "promptEdit");
  const variable = take(run, "variableName");
  if (!variable.present) return;
  if (variable.value === null || variable.value === "") {
    set(out, "variableName", null, "variableName cleared");
    return;
  }
  if (typeof variable.value !== "string") {
    out.errors.push(`${label}: variableName must be a string.`);
    return;
  }
  const name = variable.value.trim().replace(/^@/, "");
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30);
  if (sanitized !== name || !sanitized) {
    out.errors.push(`${label}: variableName may only use letters, digits and underscores (max 30 characters)${sanitized ? `; for example "${sanitized}"` : ""}.`);
    return;
  }
  set(out, "variableName", sanitized);
}

// --- Prompt Constructor ---------------------------------------------------

function handlePromptConstructor(run: FieldRun): void {
  handleLongText(run, "template", "templateEdit");
}

// --- Long text (prompt, template) -----------------------------------------

/** Characters a rewrite must share with the start of the current text to count as an edit of it. */
const EDIT_PREFIX_MIN = 200;
/** Characters of the current ending a rewrite must keep to show it was made from the whole text. */
const KEPT_ENDING_MIN = 40;

/**
 * Prompt and template text: a rewrite, or a lossless edit (`promptEdit` /
 * `templateEdit`) applied to the whole text the draft holds. The views the
 * model reads show only the start of long text, so a rewrite that keeps that
 * start but loses the ending was almost certainly written from a cut view and
 * is refused unless `replaceWholeText` says the loss is intended.
 */
function handleLongText(run: FieldRun, field: "prompt" | "template", editField: "promptEdit" | "templateEdit"): void {
  const { node, out, label } = run;
  const value = take(run, field);
  const edit = take(run, editField);
  const whole = take(run, "replaceWholeText");
  const current = typeof node.data[field] === "string" ? (node.data[field] as string) : "";
  if (whole.present && typeof whole.value !== "boolean") {
    out.errors.push(`${label}: replaceWholeText must be true or false.`);
    return;
  }
  if (value.present && edit.present) {
    out.errors.push(`${label}: set either ${field} (the whole new text) or ${editField} (a change to the current text), not both.`);
    return;
  }
  if (edit.present) {
    applyTextEdits(run, field, editField, current, edit.value);
    return;
  }
  if (!value.present) {
    if (whole.present) out.errors.push(`${label}: replaceWholeText only goes together with ${field}.`);
    return;
  }
  const coerced = coerceField(run, field, value.value);
  if ("error" in coerced) {
    out.errors.push(`${label}: ${coerced.error}`);
    return;
  }
  const next = coerced.value as string;
  if (whole.value !== true) {
    const total = fullTextLength(current);
    const readHint = `read the whole text with get_workflow {nodeIds:["${node.id}"], detail:"full"}`;
    if (isTruncatedText(current)) {
      out.errors.push(
        `${label}: its ${field} is ${total} characters, more than you can see or edit here, and writing ${field} replaces all of it. Pass replaceWholeText: true with ${field} only if the user wants the whole text replaced; otherwise ask them to edit it in the node.`,
      );
      return;
    }
    if (looksWrittenFromCutView(current, next)) {
      out.errors.push(
        `${label}: the new ${field} keeps the start of the current one but drops its last ${total - commonPrefixLength(current, next)} characters, as if it was written from a cut preview (the canvas and get_workflow summaries show only the start of long text). Change part of it with ${editField} ({find, replace}, {append} or {prepend}), ${readHint} and rewrite it from that, or pass replaceWholeText: true if dropping the rest is intended.`,
      );
      return;
    }
  }
  set(out, field, next);
}

/** A shorter text that keeps the current text's start but none of its ending. */
function looksWrittenFromCutView(current: string, next: string): boolean {
  if (current.length <= SHORTEST_TEXT_VIEW || next.length >= current.length) return false;
  if (commonPrefixLength(current, next) < EDIT_PREFIX_MIN) return false;
  return commonSuffixLength(current, next) < KEPT_ENDING_MIN;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

interface TextEditInput {
  find?: unknown;
  replace?: unknown;
  append?: unknown;
  prepend?: unknown;
}

function applyTextEdits(run: FieldRun, field: "prompt" | "template", editField: string, current: string, value: unknown): void {
  const { node, out, label } = run;
  const shape = `${editField} is {find, replace}, {append} or {prepend}, or a list of those applied in order`;
  const edits = Array.isArray(value) ? value : [value];
  if (edits.length === 0) {
    out.errors.push(`${label}: ${shape}.`);
    return;
  }
  if (isTruncatedText(current)) {
    // The draft holds only the start of a text this long; any edit would cut the rest.
    out.errors.push(`${label}: its ${field} is ${fullTextLength(current)} characters, longer than you can edit here. Ask the user to edit it in the node, or replace the whole text with ${field} and replaceWholeText: true.`);
    return;
  }
  let text = current;
  const done: string[] = [];
  for (const [index, raw] of edits.entries()) {
    const at = Array.isArray(value) ? `${editField}[${index}]` : editField;
    const edit = raw as TextEditInput;
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      out.errors.push(`${label}: ${shape}.`);
      return;
    }
    const strings = [edit.find, edit.replace, edit.append, edit.prepend].filter((s): s is string => typeof s === "string");
    const marked = strings.find((s) => containsMarker(s) || isMediaString(s));
    if (marked !== undefined) {
      out.errors.push(`${label}: ${at} contains a placeholder or media data from a cut view; use only real text.`);
      return;
    }
    if (edit.find !== undefined) {
      if (typeof edit.find !== "string" || !edit.find) {
        out.errors.push(`${label}: ${at}.find must be the exact text to change (not empty).`);
        return;
      }
      if (typeof edit.replace !== "string") {
        out.errors.push(`${label}: ${at}.replace must be a string (an empty string deletes the found text).`);
        return;
      }
      const first = text.indexOf(edit.find);
      if (first === -1) {
        out.errors.push(`${label}: ${at}.find ${formatValue(edit.find)} does not occur in the ${field}. Copy the exact text (read it with get_workflow {nodeIds:["${node.id}"], detail:"full"}).`);
        return;
      }
      const count = text.split(edit.find).length - 1;
      if (count > 1) {
        out.errors.push(`${label}: ${at}.find ${formatValue(edit.find)} occurs ${count} times in the ${field}; include more of the surrounding text so it matches once.`);
        return;
      }
      text = `${text.slice(0, first)}${edit.replace}${text.slice(first + edit.find.length)}`;
      done.push(edit.replace ? `replaced ${formatValue(edit.find)} with ${formatValue(edit.replace)}` : `deleted ${formatValue(edit.find)}`);
      continue;
    }
    if (typeof edit.append === "string" && edit.prepend === undefined) {
      text = `${text}${edit.append}`;
      done.push(`appended ${formatValue(edit.append)}`);
      continue;
    }
    if (typeof edit.prepend === "string" && edit.append === undefined) {
      text = `${edit.prepend}${text}`;
      done.push(`prepended ${formatValue(edit.prepend)}`);
      continue;
    }
    out.errors.push(`${label}: ${shape}.`);
    return;
  }
  if (text.length > MAX_STRING) {
    out.errors.push(`${label}: the edited ${field} would be too long (${text.length} characters; max ${MAX_STRING}).`);
    return;
  }
  set(out, field, text, `${field} edited: ${done.join("; ")} (now ${text.length} characters)`);
}

// --- Array ----------------------------------------------------------------

function handleArray(run: FieldRun): void {
  const pattern = take(run, "regexPattern");
  if (!pattern.present) return;
  if (typeof pattern.value !== "string") {
    run.out.errors.push(`${run.label}: regexPattern must be a string.`);
    return;
  }
  if (pattern.value.length > 100) {
    run.out.errors.push(`${run.label}: regexPattern is limited to 100 characters.`);
    return;
  }
  try {
    const slash = pattern.value.match(/^\/(.+)\/([a-z]*)$/i);
    if (pattern.value) new RegExp(slash ? slash[1] : pattern.value, slash ? slash[2] : undefined);
  } catch (error) {
    run.out.errors.push(`${run.label}: regexPattern is not a valid regular expression (${error instanceof Error ? error.message : "invalid"}).`);
    return;
  }
  set(run.out, "regexPattern", pattern.value);
}

// --- Split Grid -----------------------------------------------------------

function handleSplitGrid(run: FieldRun): void {
  const cells = take(run, "cells");
  if (cells.present) {
    if (cells.value === null) {
      // Back to the bare slice: no per-cell nodes, no shared Router.
      set(run.out, "template", createDefaultSplitGridTemplate(), "cells cleared (each cell is just its image slice)");
    } else {
      const result = buildCellTemplate(cells.value, run.context, resolveSettings, run.label);
      if (!result.ok) run.out.errors.push(...result.errors);
      else {
        set(run.out, "template", result.built.template, `cells: ${result.built.summary}`);
        run.out.warnings.push(...result.built.warnings);
      }
    }
  }
  for (const [field, offsets] of [["gridRows", "rowOffsets"], ["gridCols", "colOffsets"]] as const) {
    const setting = take(run, field);
    if (!setting.present) continue;
    const coerced = coerceField(run, field, setting.value);
    if ("error" in coerced) {
      run.out.errors.push(`${run.label}: ${coerced.error}`);
      continue;
    }
    set(run.out, field, coerced.value);
    // The node resets custom slice lines when the grid size changes.
    if (coerced.value !== run.node.data[field]) run.out.patch[offsets] = null;
  }
}

// --- Ease Curve -----------------------------------------------------------

function handleEaseCurve(run: FieldRun): void {
  const { out, label } = run;
  const preset = take(run, "easingPreset");
  const bezier = take(run, "bezierHandles");
  if (preset.present && bezier.present) {
    out.errors.push(`${label}: set either easingPreset or bezierHandles, not both.`);
    return;
  }
  if (preset.present) {
    const names = getEasingNames();
    const name = matchEnum(names, preset.value);
    if (!name) {
      out.errors.push(`${label}: easingPreset must be one of: ${names.join(", ")} (got ${formatValue(preset.value)}).`);
      return;
    }
    set(out, "easingPreset", name);
    out.patch.bezierHandles = getEasingBezier(name);
  }
  if (bezier.present) {
    const value = bezier.value;
    const valid =
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1;
    if (!valid) {
      out.errors.push(`${label}: bezierHandles must be [x1, y1, x2, y2] numbers with x1 and x2 between 0 and 1.`);
      return;
    }
    set(out, "bezierHandles", value);
    out.patch.easingPreset = null;
  }
}

// --- Video Trim -----------------------------------------------------------

function handleVideoTrim(run: FieldRun): void {
  const { node, out, label } = run;
  const start = take(run, "startTime");
  const end = take(run, "endTime");
  let startValue = typeof node.data.startTime === "number" ? node.data.startTime : 0;
  let endValue = typeof node.data.endTime === "number" ? node.data.endTime : 0;
  for (const [field, setting] of [["startTime", start], ["endTime", end]] as const) {
    if (!setting.present) continue;
    const coerced = coerceField(run, field, setting.value);
    if ("error" in coerced) {
      out.errors.push(`${label}: ${coerced.error}`);
      return;
    }
    if (field === "startTime") startValue = coerced.value as number;
    else endValue = coerced.value as number;
    set(out, field, coerced.value);
  }
  if ((start.present || end.present) && endValue > 0 && endValue <= startValue) {
    out.errors.push(`${label}: endTime (${endValue}s) must be after startTime (${startValue}s), or 0 for the end of the video.`);
  }
  const duration = node.data.duration;
  if (typeof duration === "number" && duration > 0 && endValue > duration) {
    out.warnings.push(`${node.id}: endTime ${endValue}s is past the loaded video's ${duration}s; the node will clamp it.`);
  }
}

// --- Remove Background ----------------------------------------------------

function handleRemoveBackground(run: FieldRun): void {
  const model = take(run, "model");
  if (!model.present) return;
  const key = typeof model.value === "string" ? normalizeKey(model.value) : "";
  const match = REMOVE_BACKGROUND_MODELS.find((m) => normalizeKey(m.id) === key || normalizeKey(m.label) === key);
  if (!match) {
    run.out.errors.push(`${run.label}: model must be one of: ${REMOVE_BACKGROUND_MODELS.map((m) => `${m.id} (${m.label})`).join(", ")}.`);
    return;
  }
  set(run.out, "model", match.id);
  // The node drops the previous model's result when the model changes.
  if (match.id !== run.node.data.model) Object.assign(run.out.patch, { outputImage: null, status: "idle", progress: 0 });
}

// --- Frame Grab -----------------------------------------------------------

function handleFrameGrab(run: FieldRun): void {
  const position = take(run, "framePosition");
  if (!position.present) return;
  const coerced = coerceField(run, "framePosition", position.value);
  if ("error" in coerced) {
    run.out.errors.push(`${run.label}: ${coerced.error}`);
    return;
  }
  set(run.out, "framePosition", coerced.value);
  // The node drops the grabbed frame when the position changes.
  if (coerced.value !== run.node.data.framePosition) run.out.patch.outputImage = null;
}

// --- Image Resize ---------------------------------------------------------

function handleImageResize(run: FieldRun): void {
  const pad = take(run, "padColor");
  if (!pad.present) return;
  if (typeof pad.value !== "string" || !/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(pad.value.trim())) {
    run.out.errors.push(`${run.label}: padColor must be a hex color such as #000000 or #00000000 (transparent).`);
    return;
  }
  set(run.out, "padColor", pad.value.trim());
}

// --- GIF Encoder ----------------------------------------------------------

function handleGifEncoder(run: FieldRun): void {
  const target = take(run, "targetMaxBytes");
  if (!target.present) return;
  if (target.value === null || target.value === 0 || target.value === "none") {
    set(run.out, "targetMaxBytes", null, "targetMaxBytes=none");
    return;
  }
  const coerced = coerceField(run, "targetMaxBytes", target.value);
  if ("error" in coerced) run.out.errors.push(`${run.label}: ${coerced.error} Use null for no limit.`);
  else set(run.out, "targetMaxBytes", coerced.value);
}

// --- Switch ---------------------------------------------------------------

interface ListEntryInput {
  id?: unknown;
  name?: unknown;
  label?: unknown;
  enabled?: unknown;
  value?: unknown;
  mode?: unknown;
}

function handleSwitch(run: FieldRun): void {
  const { node, out, label, context } = run;
  const setting = take(run, "switches");
  if (!setting.present) return;
  if (!Array.isArray(setting.value) || setting.value.length === 0) {
    out.errors.push(`${label}: switches must be a non-empty list like [{"name":"Output 1","enabled":true}]. A switch keeps at least one output.`);
    return;
  }
  const existing = Array.isArray(node.data.switches) ? (node.data.switches as Array<{ id: string; name: string; enabled: boolean }>) : [];
  const used = new Set<string>();
  const next: Array<{ id: string; name: string; enabled: boolean }> = [];
  for (const [index, raw] of (setting.value as unknown[]).entries()) {
    const entry: ListEntryInput = typeof raw === "string" ? { name: raw } : (raw as ListEntryInput);
    if (!entry || typeof entry !== "object") {
      out.errors.push(`${label}: switches[${index}] must be an object {name, enabled?}.`);
      return;
    }
    const name = typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : undefined;
    const match =
      (typeof entry.id === "string" ? existing.find((s) => s.id === entry.id && !used.has(s.id)) : undefined) ??
      (name ? existing.find((s) => normalizeKey(s.name) === normalizeKey(name) && !used.has(s.id)) : undefined);
    if (typeof entry.id === "string" && !match) {
      out.errors.push(`${label}: switches[${index}] has id "${entry.id}", which is not one of this switch's outputs (${existing.map((s) => `${s.id} "${s.name}"`).join(", ") || "none"}). Leave id out to add a new output.`);
      return;
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      out.errors.push(`${label}: switches[${index}].enabled must be true or false.`);
      return;
    }
    const id = match?.id ?? context.newId();
    used.add(id);
    next.push({ id, name: (name ?? match?.name ?? `Output ${index + 1}`).slice(0, 60), enabled: (entry.enabled as boolean | undefined) ?? match?.enabled ?? true });
  }
  const removed = existing.filter((s) => !used.has(s.id));
  set(out, "switches", next, `switches=[${next.map((s) => `${s.name}${s.enabled ? "" : " (off)"}`).join(", ")}]`);
  out.handlesMayChange = removed.length > 0;
}

// --- Conditional Switch ---------------------------------------------------

function handleConditionalSwitch(run: FieldRun): void {
  const { node, out, label, context } = run;
  const setting = take(run, "rules");
  if (!setting.present) return;
  if (!Array.isArray(setting.value) || setting.value.length === 0) {
    out.errors.push(`${label}: rules must be a non-empty list like [{"label":"Cats","value":"cat, kitten","mode":"contains"}]. The node keeps at least one rule; the default (Fallback) output is always there.`);
    return;
  }
  const existing = Array.isArray(node.data.rules)
    ? (node.data.rules as Array<{ id: string; label: string; value: string; mode: string; isMatched?: boolean }>)
    : [];
  const used = new Set<string>();
  const next: Array<{ id: string; value: string; mode: string; label: string; isMatched: boolean }> = [];
  for (const [index, raw] of (setting.value as unknown[]).entries()) {
    const entry = raw as ListEntryInput;
    if (!entry || typeof entry !== "object") {
      out.errors.push(`${label}: rules[${index}] must be an object {label, value, mode?}.`);
      return;
    }
    const ruleLabel = typeof entry.label === "string" ? entry.label : typeof entry.name === "string" ? entry.name : undefined;
    const match =
      (typeof entry.id === "string" ? existing.find((r) => r.id === entry.id && !used.has(r.id)) : undefined) ??
      (ruleLabel ? existing.find((r) => normalizeKey(r.label) === normalizeKey(ruleLabel) && !used.has(r.id)) : undefined);
    if (typeof entry.id === "string" && !match) {
      out.errors.push(`${label}: rules[${index}] has id "${entry.id}", which is not one of this node's rules (${existing.map((r) => `${r.id} "${r.label}"`).join(", ") || "none"}). Leave id out to add a rule.`);
      return;
    }
    const value = entry.value === undefined ? match?.value ?? "" : Array.isArray(entry.value) ? entry.value.map(String).join(", ") : entry.value;
    if (typeof value !== "string") {
      out.errors.push(`${label}: rules[${index}].value must be a string (comma-separated alternatives).`);
      return;
    }
    const mode = entry.mode === undefined ? match?.mode ?? "contains" : matchEnum(MATCH_MODES, entry.mode);
    if (!mode) {
      out.errors.push(`${label}: rules[${index}].mode must be one of: ${MATCH_MODES.join(", ")}.`);
      return;
    }
    const id = match?.id ?? `rule-${context.newId()}`;
    used.add(id);
    next.push({ id, value, mode, label: (ruleLabel ?? match?.label ?? `Rule ${index + 1}`).slice(0, 60), isMatched: match?.isMatched ?? false });
  }
  const removed = existing.filter((r) => !used.has(r.id));
  set(out, "rules", next, `rules=[${next.map((r) => `${r.label}: ${r.mode} "${r.value}"`).join("; ")}]`);
  out.handlesMayChange = removed.length > 0;
  // Editing a rule's value or mode resumes evaluation in the node, unless this call sets evaluationPaused itself.
  const edited = next.some((rule) => {
    const before = existing.find((r) => r.id === rule.id);
    return !before || before.value !== rule.value || before.mode !== rule.mode;
  });
  const setsPause = [...run.settings.keys()].some((key) => normalizeKey(key) === normalizeKey("evaluationPaused"));
  if (edited && node.data.evaluationPaused === true && !setsPause) {
    out.patch.evaluationPaused = false;
    out.warnings.push(`${node.id}: rule evaluation resumed (it was paused), as editing a rule in the node does.`);
  }
}

// --- ComfyUI App ----------------------------------------------------------

interface ComfyParamLike {
  id: string;
  label?: string;
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

function handleComfyApp(run: FieldRun): void {
  const { node, out, label } = run;
  const setting = take(run, "paramValues");
  if (!setting.present) return;
  const app = node.data.app as { params?: ComfyParamLike[] } | null | undefined;
  if (!app) {
    out.errors.push(`${label} has no workflow attached; the user must import one before its parameters can be set.`);
    return;
  }
  if (!isRecord(setting.value)) {
    out.errors.push(`${label}: paramValues must be an object {parameterId or label: value}.`);
    return;
  }
  const params = Array.isArray(app.params) ? app.params : [];
  const current = isRecord(node.data.paramValues) ? node.data.paramValues : {};
  if (containsOmitted(current)) {
    out.errors.push(`${label}: its current parameter values are too large to edit safely here; ask the user to change them in the node.`);
    return;
  }
  const merged: Record<string, unknown> = cloneJson(current);
  for (const [key, value] of Object.entries(setting.value)) {
    const param = params.find((p) => p.id === key) ?? params.find((p) => p.label !== undefined && normalizeKey(p.label) === normalizeKey(key));
    if (!param) {
      out.errors.push(`${label}: no parameter "${key}". Parameters: ${params.map((p) => `${p.id}${p.label ? ` "${p.label}"` : ""}`).join(", ") || "none"}.`);
      continue;
    }
    const coerced = coerceComfyParam(param, value);
    if ("error" in coerced) {
      out.errors.push(`${label}: ${coerced.error}`);
      continue;
    }
    merged[param.id] = coerced.value;
    out.changes.push(`${param.label || param.id}=${formatValue(coerced.value)}`);
    if (coerced.note) out.warnings.push(`${node.id}: ${coerced.note}`);
  }
  out.patch.paramValues = merged;
}

const ENUM_OPTIONS_LISTED = 30;

function coerceComfyParam(param: ComfyParamLike, value: unknown): Coerced & { note?: string } {
  const name = param.label || param.id;
  if (Array.isArray(param.enum) && param.enum.length > 0) {
    // A very long option list reaches the draft cut, with a marker in place of the rest.
    const options = param.enum.filter((v) => typeof v !== "string" || !containsMarker(v));
    const cut = options.length < param.enum.length;
    if (typeof value === "string" && containsMarker(value)) {
      return { error: `${name}: ${formatValue(value)} is a placeholder for options you were not shown, not an option. Use a real option name.` };
    }
    const match = matchEnum(options, value);
    if (match !== undefined) return { value: match };
    if (cut && typeof value === "string" && value.trim()) {
      // Only the start of the list is known here; ComfyUI checks the value when the run starts.
      return { value: value.trim(), note: `${name}=${formatValue(value.trim())} is not among the ${options.length} options known here; ComfyUI will check it when the workflow runs.` };
    }
    const listed = options.slice(0, ENUM_OPTIONS_LISTED).join(", ");
    return { error: `${name} must be one of: ${listed}${options.length > ENUM_OPTIONS_LISTED ? `, … (${options.length} options)` : ""}.` };
  }
  switch (param.type) {
    case "boolean":
      return coerce({ field: name, kind: "boolean", description: "" }, value);
    case "integer":
    case "number":
      return coerce({ field: name, kind: param.type, min: param.minimum, max: param.maximum, description: "" }, value);
    case "curve":
      return { error: `${name} is a curve; the user edits it in the node.` };
    default:
      return coerce({ field: name, kind: "string", description: "" }, value);
  }
}

/** Models sometimes send an object setting as its JSON text. */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
