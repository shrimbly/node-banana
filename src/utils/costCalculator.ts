import { ModelType, Resolution, NanoBananaNodeData, GenerateVideoNodeData, SplitGridNodeData, WorkflowNode, ProviderType } from "@/types";

// Pricing in USD per image (Gemini API)
export const PRICING = {
  "nano-banana": {
    "1K": 0.039,
    "2K": 0.039, // nano-banana only supports 1K
    "4K": 0.039,
  },
  "nano-banana-pro": {
    "1K": 0.134,
    "2K": 0.134,
    "4K": 0.24,
  },
} as const;

export function calculateGenerationCost(model: ModelType, resolution: Resolution): number {
  // nano-banana only supports 1K resolution
  if (model === "nano-banana") {
    return PRICING["nano-banana"]["1K"];
  }
  return PRICING["nano-banana-pro"][resolution];
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
  nodes: WorkflowNode[],
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
      if (modelId === "nano-banana" || modelId === "gemini-2.5-flash-preview-image-generation") {
        return { unitCost: PRICING["nano-banana"]["1K"], unit: "image" };
      }
      if (modelId === "nano-banana-pro" || modelId === "gemini-3-pro-image-preview") {
        const res = resolution || "1K";
        return { unitCost: PRICING["nano-banana-pro"][res], unit: "image" };
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
        modelName = data.model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";
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

    // SplitGrid nodes create child nanoBanana nodes - count those from settings
    // Note: child nodes are in the nodes array, but we count from splitGrid settings
    // to show what WILL be generated when the grid runs
    if (node.type === "splitGrid") {
      const data = node.data as SplitGridNodeData;
      if (data.isConfigured && data.targetCount > 0) {
        const model = data.generateSettings.model;
        const resolution = model === "nano-banana" ? "1K" : data.generateSettings.resolution;
        const modelName = model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";

        const pricing = getPricing("gemini", model, resolution);
        const unitCost = pricing?.unitCost ?? null;
        const unit = pricing?.unit ?? "image";

        addToBreakdown("gemini", model, modelName, unit, unitCost, data.targetCount);
      }
    }
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

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}
