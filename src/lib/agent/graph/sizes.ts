import type { NodeType } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { FIELD_GAP, FIELD_ROW_H, SUMMARY_ROW_H } from "@/components/nodes/ui/tokens";
import { GEMINI_OMNI_PARAMETERS, isGeminiOmni } from "@/lib/providers/geminiOmni";
import { computeShellHeight, parseAspectRatio, type ShellMedia } from "@/utils/nodeDimensions";

/**
 * Rendered heights for unmeasured generation nodes whose settings rows are
 * not known here (another provider's model, whose schema the node fetches
 * when it renders): their settings panel can be long. Over-estimating only
 * widens a gap; under-estimating stacks a new node onto the one above it.
 */
const RENDERED_HEIGHT: Partial<Record<NodeType, number>> = {
  nanoBanana: 460,
  generateVideo: 460,
  generate3d: 440,
  generateAudio: 420,
};

/** Settings rows GenerateImageNode shows per Gemini model: Model, Aspect ratio, then Resolution, Google Search, Image Search. */
const GEMINI_IMAGE_ROWS: Record<string, number> = {
  "nano-banana": 2,
  "nano-banana-2-lite": 2,
  "nano-banana-pro": 4,
  "nano-banana-2": 5,
  "nano-banana-2.1": 5,
};

/** Rows ModelParameters shows for a Gemini video model: Veo's four (getGeminiVideoSchema), Omni's schema (arrays are skipped). */
function geminiVideoRows(modelId: string): number | undefined {
  if (isGeminiOmni(modelId)) return GEMINI_OMNI_PARAMETERS.filter((p) => p.type !== "array").length;
  return modelId.startsWith("veo-") ? 4 : undefined;
}

/** Media cards that do not follow an aspect ratio (Generate3DNode, GenerateAudioNode). */
const FIXED_MEDIA: Partial<Record<NodeType, number>> = { generate3d: 112, generateAudio: 96 };

/** ControlsCard: its 1px border, and the settings panel's padding (pt-1.5 pb-2). */
const CONTROLS_BORDER = 2;
const PANEL_PADDING = 6 + 8;

/**
 * Height to assume for an unmeasured node. A generation node with no model,
 * or a Gemini one, is derived the way NodeShell lays it out: the media card
 * from its aspect, then the controls card with one row per setting. Without
 * `data`, or for another provider's model, the long-panel estimate stands.
 * `width` is the node's own when it has one.
 */
export function estimatedNodeHeight(
  type: NodeType,
  { data, width }: { data?: Record<string, unknown>; width?: number } = {},
): number {
  const base = defaultNodeDimensions[type]?.height ?? 280;
  if (!(type in RENDERED_HEIGHT)) return base;
  const fallback = Math.max(base, RENDERED_HEIGHT[type]!);
  if (!data) return fallback;
  const model = data.selectedModel as { provider?: unknown; modelId?: unknown } | undefined;
  const provider = typeof model?.provider === "string" ? model.provider : type === "nanoBanana" ? "gemini" : undefined;
  const modelId = typeof model?.modelId === "string" ? model.modelId : type === "nanoBanana" && typeof data.model === "string" ? data.model : undefined;

  let rows: number | undefined;
  if (!modelId) rows = 0;
  else if (provider !== "gemini") rows = undefined;
  else if (type === "nanoBanana") rows = GEMINI_IMAGE_ROWS[modelId];
  else if (type === "generateVideo") rows = geminiVideoRows(modelId);
  if (rows === undefined) return fallback;

  const panel = rows > 0 && data.parametersExpanded !== false ? PANEL_PADDING + rows * FIELD_ROW_H + (rows - 1) * FIELD_GAP : 0;
  return computeShellHeight({
    width: width ?? defaultNodeDimensions[type].width,
    media: mediaOf(type, data),
    inputs: Array.isArray(data.inputSchema) && type !== "nanoBanana" ? data.inputSchema.length : 2,
    outputs: 1,
    controlsH: CONTROLS_BORDER + SUMMARY_ROW_H + panel,
  });
}

function mediaOf(type: NodeType, data: Record<string, unknown>): ShellMedia {
  const fixed = FIXED_MEDIA[type];
  if (fixed !== undefined) return { kind: "fixed", height: fixed };
  // GenerateVideoNode shows 16:9 until a video has loaded.
  if (type === "generateVideo") return { kind: "aspect", aspect: 16 / 9 };
  return { kind: "aspect", aspect: parseAspectRatio(typeof data.aspectRatio === "string" ? data.aspectRatio : "1:1") };
}
