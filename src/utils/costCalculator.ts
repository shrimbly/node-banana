import { ModelType, Resolution, NanoBananaNodeData, SplitGridNodeData, WorkflowNode } from "@/types";

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

export interface CostBreakdownItem {
  model: ModelType;
  resolution: Resolution;
  count: number;
  unitCost: number;
  subtotal: number;
}

export interface PredictedCostResult {
  totalCost: number;
  breakdown: CostBreakdownItem[];
  nodeCount: number;
}

export function calculatePredictedCost(nodes: WorkflowNode[]): PredictedCostResult {
  const breakdown: Map<string, { model: ModelType; resolution: Resolution; count: number; unitCost: number }> = new Map();

  let nodeCount = 0;

  nodes.forEach((node) => {
    if (node.type === "nanoBanana") {
      const data = node.data as NanoBananaNodeData;
      const model = data.model;
      const resolution = model === "nano-banana" ? "1K" : data.resolution;
      const unitCost = calculateGenerationCost(model, resolution);
      const key = `${model}-${resolution}`;

      const existing = breakdown.get(key);
      if (existing) {
        existing.count++;
      } else {
        breakdown.set(key, { model, resolution, count: 1, unitCost });
      }
      nodeCount++;
    }

    // SplitGrid nodes create child nanoBanana nodes - count those from settings
    // Note: child nodes are in the nodes array, but we count from splitGrid settings
    // to show what WILL be generated when the grid runs
    if (node.type === "splitGrid") {
      const data = node.data as SplitGridNodeData;
      if (data.isConfigured && data.targetCount > 0) {
        const model = data.generateSettings.model;
        const resolution = model === "nano-banana" ? "1K" : data.generateSettings.resolution;
        const unitCost = calculateGenerationCost(model, resolution);
        const key = `splitGrid-${model}-${resolution}`;

        const count = data.targetCount;
        const existing = breakdown.get(key);
        if (existing) {
          existing.count += count;
        } else {
          breakdown.set(key, { model, resolution, count, unitCost });
        }
        nodeCount += count;
      }
    }
  });

  const breakdownArray = Array.from(breakdown.values()).map((item) => ({
    ...item,
    subtotal: item.count * item.unitCost,
  }));

  const totalCost = breakdownArray.reduce((sum, item) => sum + item.subtotal, 0);

  return {
    totalCost,
    breakdown: breakdownArray,
    nodeCount,
  };
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}
