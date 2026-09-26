/**
 * What the agent knows about each node type: its purpose, handles, the
 * settings it may change, and the data fields worth showing it.
 *
 * Verified against the node components (the NodeShell sockets), the canvas
 * connection rules and `src/store/utils/nodeDefaults.ts`. Lists the app
 * exports (node titles, Gemini image and Omni models, the LLM catalogue, grid
 * limits, easing names) are imported; the ones still private to a component
 * or route are mirrored here with a note saying where. Settings are a
 * whitelist: anything not listed here is rejected with the valid names.
 * Runtime state (status, outputs, histories, storage refs, uploaded media)
 * and UI-only state (mediaHeight, parametersExpanded) are never listed, so
 * the agent can never write them.
 */

import type {
  AspectRatio,
  BackgroundRemovalModel,
  HandleType,
  MatchMode,
  ModelInputDef,
  ModelType,
  NodeType,
  Resolution,
} from "@/types";
import { GEMINI_IMAGE_MODELS } from "@/types";
import { getAllEasingNames } from "@/lib/easing-functions";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  LEGACY_LLM_MODELS,
  LLM_MODELS,
  LLM_PROVIDER_OPTIONS,
  defaultLLMModel,
  type LLMProvider,
} from "@/lib/llm/catalog";
import { NODE_TITLES } from "@/lib/nodes/handles";
import { GEMINI_OMNI_INPUTS, GEMINI_OMNI_MODELS, GEMINI_OMNI_PARAMETERS } from "@/lib/providers/geminiOmni";
import { buildVeoInputSchema } from "@/store/utils/modelSelection";
import { MAX_GRID_DIMENSION, MIN_GRID_DIMENSION } from "@/store/utils/splitGridTemplate";

/** Handle data types, plus the internal Split Grid "reference" link. */
export type AgentHandleType = HandleType | "reference";

export interface CatalogPort {
  /** Handle id, or a pattern such as `image-N` for numbered handles. */
  id: string;
  /** "any": the handle takes the type of whatever is connected (router, switch, ComfyUI app). */
  type: AgentHandleType | "any";
  label: string;
  /** Inputs only: accepts several connections (images are collected). */
  multi?: boolean;
  note?: string;
}

export type CatalogSettingKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "list"
  | "object"
  /** A model id string, or {provider, modelId}, from search_models. */
  | "model";

export interface CatalogSetting {
  field: string;
  kind: CatalogSettingKind;
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  description: string;
  /** Human note on the default, e.g. "nano-banana-pro (or the user's sticky default)". */
  default?: string;
  /**
   * A few words shown next to the field in the system prompt's catalog, where
   * the name alone would mislead: a unit, a default that matters, the values.
   */
  hint?: string;
}

export interface NodeCatalogEntry {
  type: NodeType;
  /** The name the UI shows for the node. */
  displayName: string;
  purpose: string;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  settings: CatalogSetting[];
  /** Whether the agent may add this node. */
  agentCreatable: boolean;
  /** How to use it well, and what the user has to do themselves. */
  notes: string[];
  /**
   * Real `node.data` fields kept in the agent's snapshot: the settings plus
   * the structure handles depend on (selectedModel, inputSchema, switches, …).
   */
  dataFields: readonly string[];
}

// ---------------------------------------------------------------------------
// Models the agent can set
// ---------------------------------------------------------------------------

// Mirrors the module-private option lists in GenerateImageNode.tsx (which
// picks them by model id); keep in sync when a Gemini image model changes.
export const BASE_ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const EXTENDED_ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
export const ALL_RESOLUTIONS: readonly Resolution[] = ["512", "1K", "2K", "4K"];

export interface ImageModelSpec {
  id: ModelType;
  label: string;
  aspectRatios: readonly AspectRatio[];
  /** Empty: the model has no resolution setting. */
  resolutions: readonly Resolution[];
  googleSearch: boolean;
  imageSearch: boolean;
  note: string;
}

/** What GenerateImageNode offers per Gemini model (its settings render from these rules). */
const IMAGE_MODEL_OPTIONS: Record<ModelType, Omit<ImageModelSpec, "id" | "label">> = {
  "nano-banana": {
    aspectRatios: BASE_ASPECT_RATIOS,
    resolutions: [],
    googleSearch: false,
    imageSearch: false,
    note: "Gemini 2.5 Flash Image: fast; no resolution setting.",
  },
  "nano-banana-2": {
    aspectRatios: EXTENDED_ASPECT_RATIOS,
    resolutions: ["512", "1K", "2K", "4K"],
    googleSearch: true,
    imageSearch: true,
    note: "Gemini 3.1 Flash Image: efficient, 512-4K, extra aspect ratios (1:4, 1:8, 4:1, 8:1), Google and image search.",
  },
  "nano-banana-2-lite": {
    aspectRatios: BASE_ASPECT_RATIOS,
    resolutions: [],
    googleSearch: false,
    imageSearch: false,
    note: "Gemini 3.1 Flash Lite Image: cheapest, 1K only.",
  },
  "nano-banana-pro": {
    aspectRatios: BASE_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    googleSearch: true,
    imageSearch: false,
    note: "Gemini 3 Pro Image: highest quality, 1K-4K, Google Search grounding. The default when the user has not saved another; leave model unset to keep theirs.",
  },
};

/** The Gemini image models, in the order and with the names the node's model menu uses. */
export const IMAGE_MODELS: readonly ImageModelSpec[] = GEMINI_IMAGE_MODELS.map(({ value, label }) => ({
  id: value,
  label,
  ...IMAGE_MODEL_OPTIONS[value],
}));

/** Model ids people use for the Gemini image models, mapped to ours. */
export const IMAGE_MODEL_ALIASES: Record<string, ModelType> = {
  "gemini-2.5-flash-image": "nano-banana",
  "gemini-2.5-flash-image-preview": "nano-banana",
  "gemini-3-pro-image-preview": "nano-banana-pro",
  "gemini-3-pro-image": "nano-banana-pro",
  "gemini-3.1-flash-image-preview": "nano-banana-2",
  "nano-banana-2-flash": "nano-banana-2",
  "nano-banana-lite": "nano-banana-2-lite",
};

export interface VideoModelSpec {
  id: string;
  label: string;
  family: "veo" | "omni";
  /** What the model makes from; "any" takes text, images, video and audio in one model. */
  mode: "text-to-video" | "image-to-video" | "any";
  note: string;
  /** Settable parameters: field → allowed values, in the order the node offers them. */
  parameters: Readonly<Record<string, readonly string[]>>;
  /** The inputSchema the node takes on with this model: it defines the input handles. */
  inputSchema: readonly ModelInputDef[];
}

/**
 * Veo parameters. Mirrors getGeminiVideoSchema in
 * `src/app/api/models/[modelId]/route.ts` (module-private in the route).
 */
export const VEO_PARAMETERS = {
  aspectRatio: ["16:9", "9:16"],
  durationSeconds: ["4", "6", "8"],
  resolution: ["720p", "1080p", "4k"],
} as const;

/** Gemini Omni's enum parameters, from its exported schema. */
export const OMNI_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  GEMINI_OMNI_PARAMETERS.filter((p) => Array.isArray(p.enum) && p.enum.length > 0).map((p) => [p.name, p.enum!.map(String)]),
);

/**
 * The schema the node stores for Omni once ModelParameters has fetched it:
 * the route serves GEMINI_OMNI_INPUTS as they are, so writing the same list
 * keeps the node from rewriting it (sameInputSchema).
 */
const OMNI_INPUT_SCHEMA: readonly ModelInputDef[] = GEMINI_OMNI_INPUTS.map((input) => ({ ...input }));

const veo = (id: string, label: string, mode: VideoModelSpec["mode"], note: string): VideoModelSpec => ({
  id,
  label,
  family: "veo",
  mode,
  note,
  parameters: VEO_PARAMETERS,
  inputSchema: buildVeoInputSchema(id) ?? [],
});

/**
 * The Gemini API's video models (`src/app/api/models/route.ts`
 * GEMINI_VIDEO_MODELS): Veo, whose ids and parameters are private to the
 * routes and mirrored here, and Gemini Omni, from its exported list. Both
 * run on the Gemini API key.
 */
export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  veo("veo-3.1/text-to-video", "Veo 3.1", "text-to-video", "Highest quality, native audio. Inputs: prompt (text-0), negative prompt (text-1)."),
  veo("veo-3.1/image-to-video", "Veo 3.1 I2V", "image-to-video", "Animates a start image. Inputs: image (image-0), prompt (text-0), negative prompt (text-1)."),
  veo("veo-3.1-fast/text-to-video", "Veo 3.1 Fast", "text-to-video", "Faster and cheaper. Inputs: prompt (text-0), negative prompt (text-1)."),
  veo("veo-3.1-fast/image-to-video", "Veo 3.1 Fast I2V", "image-to-video", "Faster image-to-video. Inputs: image (image-0), prompt (text-0), negative prompt (text-1)."),
  ...GEMINI_OMNI_MODELS.map((m) => ({
    id: m.id,
    label: m.name,
    family: "omni" as const,
    mode: "any" as const,
    note: `${m.description} Inputs: prompt (text-0), reference images (image-0, accepts many), video to edit or extend (video-0), audio (audio-0); only the prompt is required.`,
    parameters: OMNI_PARAMETERS,
    inputSchema: OMNI_INPUT_SCHEMA,
  })),
];

/** Every value a video parameter takes on some model, for the catalog's summary of the field (resolutions smallest first). */
function videoParameterValues(field: string): string[] {
  const values = [...new Set(VIDEO_MODELS.flatMap((m) => [...(m.parameters[field] ?? [])]))];
  const lines = (value: string) => {
    const match = value.match(/^(\d+)(p|k)$/i);
    return match ? Number(match[1]) * (match[2].toLowerCase() === "k" ? 540 : 1) : NaN;
  };
  return values.every((v) => Number.isFinite(lines(v))) ? values.sort((a, b) => lines(a) - lines(b)) : values;
}

export interface LLMProviderSpec {
  id: LLMProvider;
  label: string;
  /** What the user needs configured for this provider to run. */
  requires: string;
  /** The models the node's menu offers, first = what the node picks when the provider changes. */
  models: ReadonlyArray<{ id: string; label: string }>;
}

const LLM_PROVIDER_REQUIREMENTS: Record<LLMProvider, string> = {
  google: "a Gemini API key",
  openai: "an OpenAI API key",
  anthropic: "an Anthropic API key",
};

/** LLM providers and their current models, from the app's LLM catalogue (`src/lib/llm/catalog.ts`). */
export const LLM_PROVIDERS: readonly LLMProviderSpec[] = LLM_PROVIDER_OPTIONS.map(({ value, label }) => ({
  id: value,
  label,
  requires: LLM_PROVIDER_REQUIREMENTS[value],
  models: LLM_MODELS.filter((m) => m.provider === value).map((m) => ({ id: m.id, label: m.label })),
}));

/** Ids older workflows carry; never offered, but retired ones name their replacement. */
export const LEGACY_LLM_MODEL_IDS: ReadonlyMap<string, (typeof LEGACY_LLM_MODELS)[number]> = new Map(LEGACY_LLM_MODELS.map((m) => [m.id, m]));

export { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, defaultLLMModel };

// LLMGenerateNode.tsx: temperature 0-2 (0-1 for anthropic), max tokens 256-16384.
export const LLM_TEMPERATURE_MAX: Record<LLMProvider, number> = { google: 2, openai: 2, anthropic: 1 };
export const LLM_MAX_TOKENS = { min: 256, max: 16384 } as const;

// Mirrors MODEL_OPTIONS in RemoveBackgroundNode.tsx.
export const REMOVE_BACKGROUND_MODELS: ReadonlyArray<{ id: BackgroundRemovalModel; label: string }> = [
  { id: "isnet_quint8", label: "Fast" },
  { id: "isnet_fp16", label: "Balanced" },
  { id: "isnet", label: "Quality" },
];

export const MATCH_MODES: readonly MatchMode[] = ["exact", "contains", "starts-with", "ends-with"];

let easingNames: string[] | null = null;
/** Every easing name the Ease Curve node knows (`easing-functions.ts`). */
export function getEasingNames(): string[] {
  if (!easingNames) easingNames = getAllEasingNames();
  return easingNames;
}

// ---------------------------------------------------------------------------
// Settings shared by every node
// ---------------------------------------------------------------------------

export const COMMON_SETTINGS: readonly CatalogSetting[] = [
  {
    field: "comment",
    kind: "string",
    description: "A note for the user shown on the node's header. It is never sent to any model: never put prompts or instructions here. Empty string clears it.",
  },
];

/**
 * Fields the agent may never write, with the reason. Used to turn a wrong
 * field name into a precise error instead of a generic "unknown setting".
 */
export const NEVER_SETTABLE: Record<string, string> = {
  status: "execution state, set when the workflow runs",
  error: "execution state, set when the workflow runs",
  progress: "execution state, set when the workflow runs",
  outputImage: "produced when the workflow runs",
  outputVideo: "produced when the workflow runs",
  outputAudio: "produced when the workflow runs",
  outputText: "produced when the workflow runs",
  output3dUrl: "produced when the workflow runs",
  outputGif: "produced when the workflow runs",
  outputItems: "computed from the connected text",
  inputImages: "filled from connected nodes at run time",
  inputPrompt: "filled from the connected text at run time",
  inputText: "filled from the connected text",
  incomingText: "filled from the connected text",
  sourceImage: "filled from the connected image",
  image: "the user's uploaded image; ask the user to upload one",
  audioFile: "the user's uploaded audio; ask the user to upload one",
  video: "the user's uploaded video; ask the user to upload one",
  imageHistory: "generation history",
  videoHistory: "generation history",
  audioHistory: "generation history",
  inputSchema: "derived from the selected model (set `model` instead)",
  selectedModel: "set `model` instead",
  inputType: "derived from the connected input",
  app: "the imported ComfyUI workflow; the user imports it in the node",
  annotations: "drawn by the user in the annotation editor",
  mediaHeight: "the node's display height, set by the user dragging its edge",
  parametersExpanded: "whether the node's settings card is open, which only the user toggles",
};

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const img = (id: string, label: string, extra: Partial<CatalogPort> = {}): CatalogPort => ({ id, type: "image", label, ...extra });
const txt = (id: string, label: string, extra: Partial<CatalogPort> = {}): CatalogPort => ({ id, type: "text", label, ...extra });
const vid = (id: string, label: string, extra: Partial<CatalogPort> = {}): CatalogPort => ({ id, type: "video", label, ...extra });
const aud = (id: string, label: string, extra: Partial<CatalogPort> = {}): CatalogPort => ({ id, type: "audio", label, ...extra });

const isOptionalSetting: CatalogSetting = {
  field: "isOptional",
  kind: "boolean",
  description: "When true and the node is empty, it and the nodes it feeds are skipped when the workflow runs instead of stopping it (header Optional/Required toggle).",
  default: "false",
};

const modelParametersSetting: CatalogSetting = {
  field: "modelParameters",
  kind: "object",
  description:
    "The chosen model's own settings (what the node's settings card shows), e.g. {\"size\": \"1536x1024\", \"quality\": \"high\"} on an OpenAI image model. Names and allowed values come from the model's schema: setting the model lists them, and a wrong name is rejected with the valid ones. Merged over the current values; null resets one to its default.",
};

const LLM_MODEL_IDS = LLM_PROVIDERS.flatMap((p) => p.models.map((m) => m.id));
const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id);
const title = (type: NodeType): string => NODE_TITLES[type] ?? type;

export const NODE_CATALOG: Record<NodeType, NodeCatalogEntry> = {
  imageInput: {
    type: "imageInput",
    displayName: title("imageInput"),
    purpose: "Holds an image the user uploads; its image output feeds generators, edits and outputs.",
    inputs: [{ id: "reference", type: "reference", label: "Ref", note: "internal Split Grid link; never connect it" }],
    outputs: [img("image", "Image")],
    settings: [isOptionalSetting],
    agentCreatable: true,
    notes: ["You cannot supply image bytes: after adding one, tell the user to upload or drop an image into it."],
    dataFields: ["isOptional"],
  },
  audioInput: {
    type: "audioInput",
    displayName: title("audioInput"),
    purpose: "Holds an audio file the user uploads; can also pass upstream audio through.",
    inputs: [aud("audio", "Audio")],
    outputs: [aud("audio", "Audio")],
    settings: [isOptionalSetting],
    agentCreatable: true,
    notes: ["Tell the user to upload an audio file into it unless audio is connected."],
    dataFields: ["isOptional"],
  },
  videoInput: {
    type: "videoInput",
    displayName: title("videoInput"),
    purpose: "Holds a video the user uploads; can also pass upstream video through.",
    inputs: [vid("video", "Video")],
    outputs: [vid("video", "Video")],
    settings: [],
    agentCreatable: true,
    notes: ["Tell the user to upload a video into it unless video is connected."],
    dataFields: [],
  },
  annotation: {
    type: "annotation",
    displayName: title("annotation"),
    purpose: "The user draws boxes, arrows and text over an image in an editor; outputs the annotated image.",
    inputs: [img("image", "Image")],
    outputs: [img("image", "Image")],
    settings: [],
    agentCreatable: true,
    notes: ["Needs an image connected. The user opens the node to draw; you cannot draw."],
    dataFields: [],
  },
  prompt: {
    type: "prompt",
    displayName: title("prompt"),
    purpose: "Text written by the user or by you: the usual source of prompts for generators and LLMs.",
    inputs: [txt("text", "Text", { note: "optional; when connected, the upstream text overwrites `prompt` each time it changes" })],
    outputs: [txt("text", "Text")],
    settings: [
      { field: "prompt", kind: "string", description: "The prompt text (replaces all of it).", default: "\"\"" },
      {
        field: "promptEdit",
        kind: "object",
        description: "Change part of the current prompt without retyping it: {find, replace} (find must occur exactly once; replace \"\" deletes), {append} or {prepend}, or a list of those applied in order. Use it for long prompts, which the canvas shows only in part.",
        hint: "{find,replace}|{append}|{prepend}",
      },
      { field: "replaceWholeText", kind: "boolean", description: "Only with prompt: confirms that a rewrite which drops the end of a long prompt is intended." },
      { field: "variableName", kind: "string", description: "Name used as @name in a Prompt Constructor template. Letters, digits, underscore; max 30. Empty string clears it." },
      isOptionalSetting,
    ],
    agentCreatable: true,
    notes: [
      "Write the prompt text yourself when the user describes what they want.",
      "A Prompt feeding LLM Generate is the LLM's whole instruction (there is no system prompt): the task, the input, then \"Reply with only …\".",
      "Long prompts are shown cut (with their length) in the canvas block and get_workflow summaries; get_workflow detail \"full\" shows them whole. Change part of one with promptEdit rather than retyping it.",
    ],
    dataFields: ["prompt", "variableName", "isOptional"],
  },
  array: {
    type: "array",
    displayName: title("array"),
    purpose: "Splits one text into items; each outgoing connection carries one item (the i-th connection gets item i), or all items as a batch when batchMode is on.",
    inputs: [txt("text", "Text", { note: "required; the node has no text field of its own" })],
    outputs: [txt("text", "Items", { note: "connect it to several nodes to fan the items out" })],
    settings: [
      { field: "splitMode", kind: "enum", values: ["delimiter", "newline", "regex"], description: "How the text is split.", default: "delimiter", hint: "delimiter|newline|regex" },
      { field: "delimiter", kind: "string", description: "Delimiter for splitMode \"delimiter\". Must match the separator in the text: \",\" for a comma list.", default: "*", hint: "default \"*\"; must match the list" },
      { field: "regexPattern", kind: "string", description: "Pattern for splitMode \"regex\" (max 100 chars).", default: "\"\"" },
      { field: "trimItems", kind: "boolean", description: "Trim whitespace around items.", default: "true" },
      { field: "removeEmpty", kind: "boolean", description: "Drop empty items.", default: "true" },
      { field: "batchMode", kind: "boolean", description: "Send every item to each connected generator as one batch instead of one item per connection.", default: "false" },
    ],
    agentCreatable: true,
    notes: [
      "Feed it from a Prompt (e.g. \"cat * dog * bird\" with delimiter \"*\") or an LLM.",
      "The default delimiter is \"*\": a comma list (\"cat, dog, bird\") needs delimiter \",\", and one item per line needs splitMode \"newline\". Otherwise the whole text is one item and every connection gets all of it.",
      "Fan-out: connect its text output to N nodes; connection i receives item i (set arrayItemIndex on a connection to choose explicitly).",
    ],
    dataFields: ["splitMode", "delimiter", "regexPattern", "trimItems", "removeEmpty", "batchMode", "selectedOutputIndex", "outputItems"],
  },
  promptConstructor: {
    type: "promptConstructor",
    displayName: title("promptConstructor"),
    purpose: "Builds a prompt from a template whose @variables are filled from connected Prompt nodes that have a variableName.",
    inputs: [txt("text", "Text", { multi: true, note: "accepts many; each Prompt's variableName becomes an @variable" })],
    outputs: [txt("text", "Text")],
    settings: [
      { field: "template", kind: "string", description: "Template text using @variableName placeholders (replaces all of it).", default: "\"\"" },
      {
        field: "templateEdit",
        kind: "object",
        description: "Change part of the current template without retyping it: {find, replace} (find must occur exactly once), {append} or {prepend}, or a list of those.",
        hint: "{find,replace}|{append}|{prepend}",
      },
      { field: "replaceWholeText", kind: "boolean", description: "Only with template: confirms that a rewrite which drops the end of a long template is intended." },
    ],
    agentCreatable: true,
    notes: [
      "Set variableName on each connected Prompt and reference it as @name in the template.",
      "Prompts can also reach it through a Router or Switch; an LLM upstream can fill @name by writing <var=\"name\">value</var> in its output.",
    ],
    dataFields: ["template"],
  },
  nanoBanana: {
    type: "nanoBanana",
    displayName: title("nanoBanana"),
    purpose: "Generates an image from a prompt (text, required) and optional reference images (image, accepts many).",
    inputs: [
      img("image", "Image", { multi: true, note: "optional reference/edit images, whatever the model" }),
      txt("text", "Prompt", { note: "required" }),
    ],
    outputs: [img("image", "Image")],
    settings: [
      { field: "model", kind: "model", description: `Any image model search_models finds for a provider the user has a key for: a Gemini id (${IMAGE_MODEL_IDS.join(", ")}) or another provider's (OpenAI, fal, Replicate, Kie, WaveSpeed, ComfyUI) as its exact id or {"provider": "...", "modelId": "..."}.`, default: "omit to use the user's saved default (nano-banana-pro if none)" },
      { field: "aspectRatio", kind: "enum", values: EXTENDED_ASPECT_RATIOS, description: "Output aspect ratio. 1:4, 1:8, 4:1 and 8:1 need nano-banana-2.", default: "omit to use the user's saved default (1:1 if none)" },
      { field: "resolution", kind: "enum", values: ALL_RESOLUTIONS, description: "nano-banana-pro: 1K|2K|4K; nano-banana-2: 512|1K|2K|4K; others have none.", default: "omit to use the user's saved default (1K if none)" },
      { field: "useGoogleSearch", kind: "boolean", description: "Ground the image in Google Search (nano-banana-pro, nano-banana-2).", default: "false" },
      { field: "useImageSearch", kind: "boolean", description: "Use image search (nano-banana-2 only).", default: "false" },
      { ...modelParametersSetting, description: `Other providers' models only (Gemini image models use the fields above). ${modelParametersSetting.description}` },
    ],
    agentCreatable: true,
    notes: [
      "Always connect a text input (a Prompt or LLM). Images are optional; several may be connected.",
      "aspectRatio, resolution and the search options apply to Gemini models; other providers' models take modelParameters instead. Each provider needs its API key, which the user adds in Settings → Providers.",
    ],
    dataFields: ["model", "selectedModel", "aspectRatio", "resolution", "useGoogleSearch", "useImageSearch", "parameters", "inputSchema"],
  },
  generateVideo: {
    type: "generateVideo",
    displayName: title("generateVideo"),
    purpose: "Generates a video from a prompt and, depending on the model, start or reference images, a video to edit, or audio.",
    inputs: [
      img("image", "Image", { multi: true, note: "before a model with inputs is chosen" }),
      vid("video", "Video"),
      txt("text", "Prompt"),
      img("image-0", "Image", { note: "Veo image-to-video start image; Omni reference images (accepts many)" }),
      vid("video-0", "Video", { note: "Omni: video to edit or extend" }),
      aud("audio-0", "Audio", { note: "Omni" }),
      txt("text-0", "Prompt", { note: "Veo and Omni" }),
      txt("text-1", "Neg. Prompt", { note: "Veo negative prompt" }),
    ],
    outputs: [vid("video", "Video")],
    settings: [
      { field: "model", kind: "model", description: "Any video model search_models finds (Veo and Gemini Omni on the Gemini key, Kling, Seedance, Sora… on other providers' keys): its exact id or {\"provider\": \"...\", \"modelId\": \"...\"}. Changing it changes the input handles.", default: "omit to use the user's saved default (none if they have not saved one)" },
      { field: "aspectRatio", kind: "enum", values: videoParameterValues("aspectRatio"), description: "Veo and Omni.", default: "16:9" },
      { field: "durationSeconds", kind: "enum", values: videoParameterValues("durationSeconds"), description: "Veo only: clip length in seconds (Omni takes the duration from the prompt).", default: "8" },
      { field: "resolution", kind: "enum", values: videoParameterValues("resolution"), description: "Veo: 720p|1080p|4k; Omni: 360p|720p|1080p|4k.", default: "720p" },
      { field: "task", kind: "enum", values: videoParameterValues("task"), description: "Omni only: auto infers the task from the prompt; choose one only when the user asks for explicit control.", default: "auto" },
      modelParametersSetting,
    ],
    agentCreatable: true,
    notes: [
      "Set `model` to an id from search_models (nodeType generateVideo). aspectRatio, durationSeconds, resolution and task are shortcuts for Gemini video models; any model's own settings go in modelParameters.",
      "Handles follow the model's inputs, numbered per type (image-0, image-1, text-0, text-1…; the result of setting the model lists them); a schema input name such as \"negative_prompt\" also works as toHandle. With a Veo model they are image-0 (I2V only), text-0 (prompt) and text-1 (negative prompt). With Omni they are image-0 (reference images), video-0, audio-0 and text-0 (prompt).",
    ],
    dataFields: ["selectedModel", "parameters", "inputSchema"],
  },
  generate3d: {
    type: "generate3d",
    displayName: title("generate3d"),
    purpose: "Generates a 3D model (GLB) from an image and/or a prompt.",
    inputs: [img("image", "Image"), txt("text", "Prompt")],
    outputs: [{ id: "3d", type: "3d", label: "3D" }],
    settings: [
      { field: "model", kind: "model", description: "A 3D model from search_models (nodeType generate3d; fal, Replicate, Kie, WaveSpeed or ComfyUI): its exact id or {\"provider\": \"...\", \"modelId\": \"...\"}. The handles follow the model's inputs.", default: "omit to use the user's saved default (none if they have not saved one)" },
      modelParametersSetting,
    ],
    agentCreatable: true,
    notes: [
      "There is no Gemini 3D model: set one from search_models, or when none is available tell the user which provider key to add in Settings → Providers.",
      "Connect its 3d output to a 3D Viewer to see the result.",
    ],
    dataFields: ["selectedModel", "parameters", "inputSchema"],
  },
  generateAudio: {
    type: "generateAudio",
    displayName: title("generateAudio"),
    purpose: "Generates speech, music or sound effects from text.",
    inputs: [txt("text", "Prompt", { note: "handles follow the chosen model's inputs once one is picked" })],
    outputs: [aud("audio", "Audio")],
    settings: [
      { field: "model", kind: "model", description: "A speech, music or sound model from search_models (nodeType generateAudio; Kie, fal, Replicate, WaveSpeed or ComfyUI): its exact id or {\"provider\": \"...\", \"modelId\": \"...\"}.", default: "omit to use the user's saved default (none if they have not saved one)" },
      modelParametersSetting,
    ],
    agentCreatable: true,
    notes: ["With a model chosen, the input handles are the model's input names (e.g. \"prompt\" or \"text\"), as the result of setting the model lists them. There is no Gemini audio model."],
    dataFields: ["selectedModel", "parameters", "inputSchema"],
  },
  llmGenerate: {
    type: "llmGenerate",
    displayName: title("llmGenerate"),
    purpose: "Generates text with an LLM from a prompt (text, required: the LLM's whole instruction plus its input, since there is no system prompt) and optional images; its text output can feed Prompts, Arrays or generators.",
    inputs: [img("image", "Image", { multi: true, note: "optional" }), txt("text", "Prompt", { note: "required" })],
    outputs: [txt("text", "Text")],
    settings: [
      { field: "provider", kind: "enum", values: LLM_PROVIDERS.map((p) => p.id), description: "google needs a Gemini key; openai and anthropic need their own keys.", default: `${DEFAULT_LLM_PROVIDER} (or the user's saved default)` },
      { field: "model", kind: "enum", values: LLM_MODEL_IDS, description: "Must belong to the provider (see search_models with nodeType llmGenerate). Setting a model of another provider switches the provider.", default: `${DEFAULT_LLM_MODEL} (or the user's saved default)` },
      { field: "temperature", kind: "number", min: 0, max: 2, description: "0-2 (anthropic: 0-1).", default: "0.7" },
      { field: "maxTokens", kind: "integer", min: LLM_MAX_TOKENS.min, max: LLM_MAX_TOKENS.max, description: "Maximum output tokens.", default: "8192" },
    ],
    agentCreatable: true,
    notes: [
      "The instructions for the LLM go in the Prompt connected to its text input (there is no system prompt field), e.g. \"Write one detailed image-generation prompt (subject, setting, composition, lighting, style) for: <idea>. Reply with only the prompt.\" A bare idea gives the LLM no task.",
      "Its comment is a note for the user and never reaches the LLM.",
    ],
    dataFields: ["provider", "model", "temperature", "maxTokens"],
  },
  splitGrid: {
    type: "splitGrid",
    displayName: title("splitGrid"),
    purpose: "Cuts an image into rows x cols cells and runs the same small pipeline on every cell (its `cells` setting). Each cell becomes a group of real nodes on the canvas, starting from an Image Input that receives the cell's slice; outputs listed in cells.collect from every cell go into one shared Router, which you connect onward (e.g. to an Output Gallery). It never stitches the cells back into one image.",
    inputs: [img("image", "Image")],
    outputs: [{ id: "reference", type: "reference", label: "Ref", note: "internal; never connect it" }],
    settings: [
      { field: "gridRows", kind: "integer", min: MIN_GRID_DIMENSION, max: MAX_GRID_DIMENSION, description: "Rows.", default: "2" },
      { field: "gridCols", kind: "integer", min: MIN_GRID_DIMENSION, max: MAX_GRID_DIMENSION, description: "Columns.", default: "3" },
      {
        field: "cells",
        kind: "object",
        description:
          "The pipeline every cell runs, like create_workflow: {nodes:[{ref, type, settings?}], connections:[{from, to, fromHandle?, toHandle?}], collect:[{from, fromHandle?}], into?}. \"cell\" is the ref of each cell's image slice (an Image Input). collect lists outputs gathered from every cell into the grid's shared Router; into (a ref or node id, e.g. an Output Gallery) is where that Router connects. Replaces the whole pipeline; null clears it.",
        default: "just the slice",
      },
    ],
    agentCreatable: true,
    notes: [
      'Set cells in the same call that adds the grid. Example, upscale every cell and show them all: settings {"gridRows":3, "gridCols":3, "cells":{"nodes":[{"ref":"ask","type":"prompt","settings":{"prompt":"Upscale this image: keep it identical, sharper and more detailed"}},{"ref":"up","type":"nanoBanana","settings":{"resolution":"4K"}}],"connections":[{"from":"cell","to":"up"},{"from":"ask","to":"up"}],"collect":[{"from":"up"}],"into":"gallery"}} with an outputGallery ref "gallery" in the same call.',
      "When cells.collect is set, a shared Router is created next to the grid (the result gives its id) and connected to cells.into; connect that Router onward, never the per-cell nodes.",
      "The per-cell nodes and groups on the canvas are copies rebuilt from cells whenever the grid or its cells change: change them through cells, never by editing or wiring the copies.",
      "\"Upscale\" per cell means a Generate Image with an upscale prompt and a higher resolution (costs one generation per cell); Image Resize only resamples. Say which you used.",
    ],
    dataFields: ["gridRows", "gridCols", "template", "routerNodeId"],
  },
  output: {
    type: "output",
    displayName: title("output"),
    purpose: "Displays and saves the final image, video or audio.",
    inputs: [img("image", "Image"), vid("video", "Video"), aud("audio", "Audio")],
    outputs: [],
    settings: [{ field: "outputFilename", kind: "string", description: "File name (without extension) used when the result is saved.", default: "\"\"" }],
    agentCreatable: true,
    notes: ["Connect one result to it. Use Output Gallery to show many."],
    dataFields: ["outputFilename"],
  },
  outputGallery: {
    type: "outputGallery",
    displayName: title("outputGallery"),
    purpose: "Shows many images and videos as a scrollable grid.",
    inputs: [img("image", "Image", { multi: true }), vid("video", "Video", { multi: true })],
    outputs: [],
    settings: [],
    agentCreatable: true,
    notes: [],
    dataFields: [],
  },
  imageCompare: {
    type: "imageCompare",
    displayName: title("imageCompare"),
    purpose: "Compares two images with a slider.",
    inputs: [img("image", "A"), img("image-1", "B")],
    outputs: [],
    settings: [],
    agentCreatable: true,
    notes: ["The first image goes to `image` (A), the second to `image-1` (B), picked automatically."],
    dataFields: [],
  },
  videoStitch: {
    type: "videoStitch",
    displayName: title("videoStitch"),
    purpose: "Concatenates videos in order (one per input video-0, video-1, …) with an optional audio track.",
    inputs: [vid("video-N", "Video N", { note: "one clip per handle; the next free one is picked automatically" }), aud("audio", "Audio")],
    outputs: [vid("video", "Output")],
    settings: [{ field: "loopCount", kind: "enum", values: [1, 2, 3], description: "How many times the clip sequence repeats.", default: "1" }],
    agentCreatable: true,
    notes: [],
    dataFields: ["loopCount", "clipOrder"],
  },
  easeCurve: {
    type: "easeCurve",
    displayName: title("easeCurve"),
    purpose: "Retimes a video with an easing speed curve; its easeCurve output passes the curve to other Ease Curve nodes.",
    inputs: [vid("video", "Video In"), { id: "easeCurve", type: "easeCurve", label: "Settings", note: "inherit the curve from another Ease Curve" }],
    outputs: [vid("video", "Video Out"), { id: "easeCurve", type: "easeCurve", label: "Settings" }],
    settings: [
      { field: "easingPreset", kind: "enum", values: getEasingNames(), description: "Named easing curve (also sets bezierHandles).", default: "easeInOutSine" },
      { field: "bezierHandles", kind: "list", description: "Custom cubic-bezier [x1, y1, x2, y2] with x in 0-1 (clears easingPreset)." },
      { field: "outputDuration", kind: "number", min: 0.1, max: 30, description: "Output length in seconds.", default: "1.5", hint: "s" },
    ],
    agentCreatable: true,
    notes: [],
    dataFields: ["easingPreset", "bezierHandles", "outputDuration"],
  },
  videoTrim: {
    type: "videoTrim",
    displayName: title("videoTrim"),
    purpose: "Trims a video to a start and end time.",
    inputs: [vid("video", "Video In")],
    outputs: [vid("video", "Video Out")],
    settings: [
      { field: "startTime", kind: "number", min: 0, description: "Start, in seconds.", default: "0", hint: "s" },
      { field: "endTime", kind: "number", min: 0, description: "End, in seconds (0 = the end of the video).", default: "0", hint: "s; 0=end" },
    ],
    agentCreatable: true,
    notes: [],
    dataFields: ["startTime", "endTime", "duration"],
  },
  videoFrameGrab: {
    type: "videoFrameGrab",
    displayName: title("videoFrameGrab"),
    purpose: "Extracts the first or last frame of a video as an image.",
    inputs: [vid("video", "Video In")],
    outputs: [img("image", "Image Out")],
    settings: [{ field: "framePosition", kind: "enum", values: ["first", "last"], description: "Which frame to grab.", default: "first" }],
    agentCreatable: true,
    notes: ["Useful to chain videos: grab the last frame and feed it to an image-to-video model."],
    dataFields: ["framePosition"],
  },
  removeBackground: {
    type: "removeBackground",
    displayName: title("removeBackground"),
    purpose: "Removes an image's background (runs in the browser).",
    inputs: [img("image", "Image In")],
    outputs: [img("image", "Image Out")],
    settings: [{ field: "model", kind: "enum", values: REMOVE_BACKGROUND_MODELS.map((m) => m.id), description: "isnet_quint8 = Fast, isnet_fp16 = Balanced, isnet = Quality.", default: "isnet_fp16" }],
    agentCreatable: true,
    notes: [],
    dataFields: ["model"],
  },
  imageResize: {
    type: "imageResize",
    displayName: title("imageResize"),
    purpose: "Resizes, fits and re-encodes an image.",
    inputs: [img("image", "Image In")],
    outputs: [img("image", "Image Out")],
    settings: [
      { field: "mode", kind: "enum", values: ["exact", "maxEdge", "scale"], description: "exact = width x height; maxEdge = longest side; scale = percentage.", default: "exact" },
      { field: "width", kind: "integer", min: 1, description: "Width in px (exact mode).", default: "128" },
      { field: "height", kind: "integer", min: 1, description: "Height in px (exact mode).", default: "128" },
      { field: "maxEdge", kind: "integer", min: 1, description: "Longest side in px (maxEdge mode).", default: "128" },
      { field: "scalePct", kind: "integer", min: 1, max: 400, description: "Scale percent (scale mode).", default: "100" },
      { field: "fit", kind: "enum", values: ["contain", "cover", "stretch"], description: "How the image fits (exact mode).", default: "contain" },
      { field: "padColor", kind: "string", description: "Hex padding color for contain, e.g. #00000000 (the node has no field for it; the resize still uses it).", default: "#00000000" },
      { field: "format", kind: "enum", values: ["keep", "png", "jpeg", "webp"], description: "Output format.", default: "png" },
      { field: "quality", kind: "number", min: 0.1, max: 1, description: "jpeg/webp quality.", default: "0.9" },
    ],
    agentCreatable: true,
    notes: [],
    dataFields: ["mode", "width", "height", "maxEdge", "scalePct", "fit", "padColor", "format", "quality"],
  },
  gifEncoder: {
    type: "gifEncoder",
    displayName: title("gifEncoder"),
    purpose: "Assembles frames (one image per input image-0, image-1, …) into an animated GIF.",
    inputs: [img("image-N", "Frame N", { note: "one frame per handle; the next free one is picked automatically" })],
    outputs: [img("image", "GIF Out")],
    settings: [
      { field: "fps", kind: "integer", min: 1, max: 30, description: "Frames per second.", default: "8" },
      { field: "colorCount", kind: "integer", min: 2, max: 256, description: "Palette size.", default: "128" },
      { field: "dither", kind: "boolean", description: "Dither colors.", default: "false" },
      { field: "targetMaxBytes", kind: "integer", min: 1024, description: "Size budget in bytes (null = no limit).", default: "131072" },
      { field: "loopCount", kind: "integer", min: 0, description: "0 = loop forever (the node has no field for it; the encoder still uses it).", default: "0" },
    ],
    agentCreatable: true,
    notes: [],
    dataFields: ["fps", "colorCount", "dither", "targetMaxBytes", "loopCount", "clipOrder"],
  },
  router: {
    type: "router",
    displayName: title("router"),
    purpose: "Pass-through hub: each connected input type is re-exposed as an output of the same type. Tidies wiring and fans one source out.",
    inputs: [{ id: "<type>", type: "any", label: "Any type", note: "handle id = the data type (image, text, video, audio, 3d, easeCurve)", multi: true }],
    outputs: [{ id: "<type>", type: "any", label: "Same type", note: "exists only for types connected to the router's inputs" }],
    settings: [],
    agentCreatable: true,
    notes: ["Connect the input first (in the same call is fine); an output of type X exists only while an input of type X is connected."],
    dataFields: [],
  },
  switch: {
    type: "switch",
    displayName: title("switch"),
    purpose: "Manual gate: routes one input (any type) to named outputs the user toggles on and off.",
    inputs: [{ id: "<type>", type: "any", label: "In", note: "takes the type of the connected source" }],
    outputs: [{ id: "<switch id>", type: "any", label: "Output name", note: "one per entry in `switches`, same type as the input; refer to it by name" }],
    settings: [
      {
        field: "switches",
        kind: "list",
        description: "The COMPLETE list of outputs, in order: [{name, enabled?, id?}]. Existing outputs are matched by id or name and keep their connections; outputs you leave out are deleted with their connections.",
        default: "[{name:\"Output 1\", enabled:true}]",
      },
    ],
    agentCreatable: true,
    notes: ["Outputs appear once the input is connected. Connect from an output by its name (fromHandle: \"Output 1\")."],
    dataFields: ["switches", "inputType"],
  },
  conditionalSwitch: {
    type: "conditionalSwitch",
    displayName: title("conditionalSwitch"),
    purpose: "Gates execution by text rules: nodes connected to a rule's output run only when the incoming text matches it; `default` (shown as Fallback) runs when no rule matches. It does not pass the text on.",
    inputs: [txt("text", "Text")],
    outputs: [txt("<rule id>", "Rule label", { note: "one per rule; refer to it by label" }), txt("default", "Fallback")],
    settings: [
      {
        field: "rules",
        kind: "list",
        description: "The COMPLETE list of rules, at least one: [{label, value, mode?, id?}]. value is comma-separated alternatives (OR); mode is exact | contains | starts-with | ends-with (default contains). Existing rules are matched by id or label; rules left out are deleted with their connections.",
        default: "one empty \"contains\" rule",
      },
      { field: "evaluationPaused", kind: "boolean", description: "When true every output is open. Changing a rule's value or mode turns it off, as in the node.", default: "false" },
    ],
    agentCreatable: true,
    notes: [
      "Feed it text (e.g. an LLM's answer). Connect each rule output (fromHandle = the rule's label, or \"default\" for Fallback) to the text input of a Prompt that should only run on a match: rule → Prompt → generator. It passes no text itself, so do not wire it straight into a generator's prompt.",
    ],
    dataFields: ["rules", "evaluationPaused"],
  },
  glbViewer: {
    type: "glbViewer",
    displayName: title("glbViewer"),
    purpose: "Displays a 3D model; the user can capture the view as an image.",
    inputs: [{ id: "3d", type: "3d", label: "3D" }],
    outputs: [img("image", "Image", { note: "a capture the user takes manually" })],
    settings: [],
    agentCreatable: true,
    notes: [],
    dataFields: [],
  },
  comfyApp: {
    type: "comfyApp",
    displayName: title("comfyApp"),
    purpose: "Runs an imported ComfyUI workflow; its inputs, settings and outputs come from that workflow.",
    inputs: [{ id: "<type>-<i>", type: "any", label: "From the workflow", note: "image-0, text-0, … in the order the workflow declares them" }],
    outputs: [{ id: "<ComfyUI node id>", type: "any", label: "From the workflow", note: "see get_workflow for this node's outputs" }],
    settings: [
      { field: "paramValues", kind: "object", description: "Values for the workflow's parameters, keyed by parameter id or label (merged into the current values)." },
    ],
    agentCreatable: false,
    notes: ["You cannot create one: the user imports a ComfyUI workflow (or picks a saved node) from the canvas menu. You can connect existing ones and set their paramValues."],
    dataFields: ["app", "inputSchema", "paramValues", "savedNodeId"],
  },
};

export const NODE_TYPES = Object.keys(NODE_CATALOG) as NodeType[];

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NODE_CATALOG, value);
}

/** Case- and separator-insensitive lookup of a node type ("generate image", "nano_banana", "Output"). */
export function findNodeType(value: string): NodeType | undefined {
  if (isNodeType(value)) return value;
  const key = normalizeKey(value);
  for (const type of NODE_TYPES) {
    if (normalizeKey(type) === key) return type;
    if (normalizeKey(NODE_CATALOG[type].displayName) === key) return type;
  }
  return NODE_TYPE_ALIASES[key];
}

const NODE_TYPE_ALIASES: Record<string, NodeType> = {
  generateimage: "nanoBanana",
  image: "imageInput",
  imagegeneration: "nanoBanana",
  llm: "llmGenerate",
  text: "prompt",
  video: "generateVideo",
  audio: "generateAudio",
  "3d": "generate3d",
  gallery: "outputGallery",
  trim: "videoTrim",
  framegrab: "videoFrameGrab",
  resize: "imageResize",
  gif: "gifEncoder",
  viewer: "glbViewer",
  "3dviewer": "glbViewer",
};

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.]/g, "");
}

export function getImageModel(id: string | undefined | null): ImageModelSpec | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function getVideoModel(id: string | undefined | null): VideoModelSpec | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

export function getLLMProvider(id: string | undefined | null): LLMProviderSpec | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** The provider a known LLM model id belongs to. */
export function getLLMProviderForModel(modelId: string): LLMProviderSpec | undefined {
  return LLM_PROVIDERS.find((p) => p.models.some((m) => m.id === modelId));
}

/** All settings a node type accepts, including the common ones. */
export function getSettings(type: NodeType): CatalogSetting[] {
  return [...NODE_CATALOG[type].settings, ...COMMON_SETTINGS];
}
