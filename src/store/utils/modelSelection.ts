/**
 * What picking a model in the browse dialog writes onto a generation node.
 * The four generation nodes and the multi-select "change model" action share
 * this so a model lands the same way whichever surface chose it.
 */

import type { ModelInputDef, NodeType, SelectedModel, WorkflowNodeData } from "@/types";
import type { ProviderModel } from "@/lib/providers/types";

export const GENERATE_NODE_TYPES = ["nanoBanana", "generateVideo", "generate3d", "generateAudio"] as const;
export type GenerateNodeType = (typeof GENERATE_NODE_TYPES)[number];

/** Node titles, as the canvas headers show them. */
export const GENERATE_NODE_LABEL: Record<GenerateNodeType, string> = {
  nanoBanana: "Generate Image",
  generateVideo: "Generate Video",
  generate3d: "Generate 3D",
  generateAudio: "Generate Audio",
};

export function isGenerateNodeType(type: string | undefined): type is GenerateNodeType {
  return (GENERATE_NODE_TYPES as readonly string[]).includes(type ?? "");
}

/** The capability filter the browse dialog opens on for a generation node type. */
export function capabilityForGenerateNode(type: GenerateNodeType): "image" | "video" | "3d" | "audio" {
  switch (type) {
    case "nanoBanana":
      return "image";
    case "generateVideo":
      return "video";
    case "generate3d":
      return "3d";
    case "generateAudio":
      return "audio";
  }
}

/** Returns true for Gemini-native Veo video models */
export function isVeoModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.startsWith("veo-");
}

/** Build the hardcoded inputSchema for a Veo model, or undefined for non-Veo */
export function buildVeoInputSchema(modelId: string): ModelInputDef[] | undefined {
  if (!isVeoModel(modelId)) return undefined;
  const isI2V = modelId.includes("image-to-video");
  const inputs: ModelInputDef[] = [
    { name: "prompt", type: "text", required: true, label: "Prompt" },
    { name: "negative_prompt", type: "text", required: false, label: "Neg. Prompt" },
  ];
  if (isI2V) {
    inputs.unshift({ name: "image", type: "image", required: true, label: "Image" });
  }
  return inputs;
}

/**
 * The node data a freshly chosen model replaces: the selection itself and a
 * cleared parameter set, since the old model's parameters mean nothing to the
 * new one. A Veo video model also brings its fixed input schema, so its
 * handles render in the same update.
 */
export function modelSelectionData(type: GenerateNodeType, model: ProviderModel): Partial<WorkflowNodeData> {
  const selectedModel: SelectedModel = {
    provider: model.provider,
    modelId: model.id,
    displayName: model.name,
    ...(type === "nanoBanana" ? { capabilities: model.capabilities } : {}),
  };
  if (type === "generateVideo") {
    return { selectedModel, parameters: {}, inputSchema: buildVeoInputSchema(model.id) } as Partial<WorkflowNodeData>;
  }
  return { selectedModel, parameters: {} } as Partial<WorkflowNodeData>;
}

/** The one generation type every node shares, or null when they differ or are not generators. */
export function sharedGenerateType(nodes: ReadonlyArray<{ type?: NodeType | string }>): GenerateNodeType | null {
  if (nodes.length === 0) return null;
  const first = nodes[0].type;
  if (!isGenerateNodeType(first)) return null;
  return nodes.every((node) => node.type === first) ? first : null;
}
