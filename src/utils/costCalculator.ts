import { ModelType, Resolution, MODEL_DISPLAY_NAMES, NanoBananaNodeData, GenerateVideoNodeData, Generate3DNodeData, WorkflowNode, ProviderType } from "@/types";

// Pricing in USD per image (Gemini API)
export const PRICING = {
  "nano-banana": {
    "512": 0.039,
    "1K": 0.039,
    "2K": 0.039, // nano-banana only supports 1K
    "4K": 0.039,
  },
  "nano-banana-pro": {
    "512": 0.134,
    "1K": 0.134,
    "2K": 0.134,
    "4K": 0.24,
  },
  "nano-banana-2": {
    "512": 0.045,
    "1K": 0.067,
    "2K": 0.101,
    "4K": 0.151,
  },
  "nano-banana-2-lite": {
    "512": 0.034,
    "1K": 0.034,
    "2K": 0.034, // nano-banana-2-lite only supports 1K
    "4K": 0.034,
  },
} as const;

export function calculateGenerationCost(model: ModelType, resolution: Resolution): number {
  // nano-banana and nano-banana-2-lite only support 1K resolution (flat pricing)
  if (model === "nano-banana" || model === "nano-banana-2-lite") {
    return PRICING[model]["1K"];
  }
  return PRICING[model][resolution];
}

/**
 * Pricing info for external provider models
 */
export interface ModelPricing {
  unitCost: number;
  unit: string;  // "image", "video", "second", etc.
}

/**
 * Get cost info from ProviderModel pricing field
 * Returns null if pricing is unavailable (e.g., Replicate has no pricing API)
 */
export function getModelCost(pricing: { type: 'per-run' | 'per-second'; amount: number } | null | undefined): ModelPricing | null {
  if (!pricing) return null;
  return {
    unitCost: pricing.amount,
    unit: pricing.type === 'per-run' ? 'image' : 'second',
  };
}

/**
 * Cost breakdown item supporting multiple providers
 */
export interface CostBreakdownItem {
  provider: ProviderType;
  modelId: string;
  modelName: string;
  count: number;
  unitCost: number | null;  // null means pricing unavailable
  unit: string;  // "image", "video", "second", etc.
  subtotal: number | null;  // null if unitCost is null
}

/**
 * Result of predicted cost calculation
 */
export interface PredictedCostResult {
  totalCost: number;  // Only includes known pricing
  breakdown: CostBreakdownItem[];
  nodeCount: number;
  unknownPricingCount: number;  // Count of items without pricing
}

/**
 * Legacy cost breakdown item for backward compatibility
 * @deprecated Use CostBreakdownItem instead
 */
export interface LegacyCostBreakdownItem {
  model: ModelType;
  resolution: Resolution;
  count: number;
  unitCost: number;
  subtotal: number;
}

/**
 * Calculate predicted cost for all generation nodes in the workflow.
 * Handles nanoBanana (image) and generateVideo (video) nodes.
 *
 * @param nodes - Workflow nodes to analyze
 * @param modelPricing - Optional map of modelId -> pricing for external providers.
 *                       If not provided, only Gemini models get pricing.
 * @returns PredictedCostResult with total cost, breakdown, and counts
 */
export function calculatePredictedCost(
  nodes: Pick<WorkflowNode, "id" | "type" | "data">[],
  modelPricing?: Map<string, ModelPricing>
): PredictedCostResult {
  // Group by provider + modelId for breakdown
  const breakdown: Map<string, CostBreakdownItem> = new Map();
  let nodeCount = 0;
  let unknownPricingCount = 0;

  /**
   * Helper to add an item to the breakdown map
   */
  function addToBreakdown(
    provider: ProviderType,
    modelId: string,
    modelName: string,
    unit: string,
    unitCost: number | null,
    count: number = 1
  ) {
    const key = `${provider}:${modelId}`;
    const existing = breakdown.get(key);
    if (existing) {
      existing.count += count;
      if (existing.subtotal !== null && unitCost !== null) {
        existing.subtotal += count * unitCost;
      }
    } else {
      breakdown.set(key, {
        provider,
        modelId,
        modelName,
        count,
        unitCost,
        unit,
        subtotal: unitCost !== null ? count * unitCost : null,
      });
    }
    nodeCount += count;
    if (unitCost === null) {
      unknownPricingCount += count;
    }
  }

  /**
   * Get pricing for a model.
   * First checks modelPricing map, then falls back to hardcoded Gemini pricing.
   */
  function getPricing(
    provider: ProviderType,
    modelId: string,
    resolution?: Resolution
  ): { unitCost: number; unit: string } | null {
    // Check external pricing map first
    if (modelPricing?.has(modelId)) {
      return modelPricing.get(modelId)!;
    }

    // Fallback to hardcoded Gemini pricing for legacy models
    if (provider === "gemini") {
      if (modelId === "nano-banana" || modelId === "gemini-2.5-flash-image") {
        return { unitCost: PRICING["nano-banana"]["1K"], unit: "image" };
      }
      if (modelId === "nano-banana-pro" || modelId === "gemini-3-pro-image-preview") {
        const res = resolution || "1K";
        return { unitCost: PRICING["nano-banana-pro"][res], unit: "image" };
      }
      if (modelId === "nano-banana-2" || modelId === "gemini-3.1-flash-image-preview") {
        const res = resolution || "1K";
        return { unitCost: PRICING["nano-banana-2"][res], unit: "image" };
      }
      if (modelId === "nano-banana-2-lite" || modelId === "gemini-3.1-flash-lite-image") {
        // 1K-only flat pricing, like nano-banana — resolution is ignored
        return { unitCost: PRICING["nano-banana-2-lite"]["1K"], unit: "image" };
      }
    }

    // No pricing available (e.g., Replicate)
    return null;
  }

  nodes.forEach((node) => {
    // Handle nanoBanana (image generation) nodes
    if (node.type === "nanoBanana") {
      const data = node.data as NanoBananaNodeData;

      // Determine provider and model info
      let provider: ProviderType;
      let modelId: string;
      let modelName: string;

      if (data.selectedModel) {
        // New multi-provider model selection
        provider = data.selectedModel.provider;
        modelId = data.selectedModel.modelId;
        modelName = data.selectedModel.displayName;
      } else {
        // Legacy Gemini-only model
        provider = "gemini";
        modelId = data.model;
        modelName = MODEL_DISPLAY_NAMES[data.model] || data.model;
      }

      const resolution = data.model === "nano-banana" ? "1K" : data.resolution;
      const pricing = getPricing(provider, modelId, resolution);
      const unitCost = pricing?.unitCost ?? null;
      const unit = pricing?.unit ?? "image";

      addToBreakdown(provider, modelId, modelName, unit, unitCost);
    }

    // Handle generateVideo nodes
    if (node.type === "generateVideo") {
      const data = node.data as GenerateVideoNodeData;

      // generateVideo requires selectedModel (no legacy fallback)
      if (data.selectedModel) {
        const provider = data.selectedModel.provider;
        const modelId = data.selectedModel.modelId;
        const modelName = data.selectedModel.displayName;

        const pricing = getPricing(provider, modelId);
        const unitCost = pricing?.unitCost ?? null;
        const unit = pricing?.unit ?? "video";

        addToBreakdown(provider, modelId, modelName, unit, unitCost);
      }
    }

    // SplitGrid cell nodes are real nodes on the canvas (materialized from the
    // cell template), so any generate nodes they contain are already counted
    // above — no separate splitGrid estimate needed.
  });

  const breakdownArray = Array.from(breakdown.values());
  const totalCost = breakdownArray.reduce(
    (sum, item) => sum + (item.subtotal ?? 0),
    0
  );

  return {
    totalCost,
    breakdown: breakdownArray,
    nodeCount,
    unknownPricingCount,
  };
}

/**
 * Check whether any generation node in the workflow uses a non-Gemini provider.
 * Used to hide the CostIndicator when pricing data would be incomplete/misleading.
 */
export function hasNonGeminiProviders(nodes: Pick<WorkflowNode, "id" | "type" | "data">[]): boolean {
  return nodes.some((node) => {
    if (node.type === "nanoBanana") {
      const data = node.data as NanoBananaNodeData;
      return data.selectedModel?.provider !== undefined && data.selectedModel.provider !== "gemini";
    }
    if (node.type === "generateVideo") {
      const data = node.data as GenerateVideoNodeData;
      return data.selectedModel?.provider !== undefined && data.selectedModel.provider !== "gemini";
    }
    if (node.type === "generate3d") {
      const data = node.data as Generate3DNodeData;
      return data.selectedModel?.provider !== undefined && data.selectedModel.provider !== "gemini";
    }
    if (node.type === "generateAudio") {
      return true; // Audio nodes are always non-Gemini
    }
    return false;
  });
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}
