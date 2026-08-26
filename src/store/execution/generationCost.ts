import type { GenerationCostReceipt, SelectedModel } from "@/types";

/**
 * Ensure every successful fal result has a complete request-level receipt.
 * If fal omitted billing metadata, null values deliberately propagate to the
 * UI as an em dash instead of falling back to model estimates.
 */
export function resolveGenerationCost(
  model: SelectedModel,
  receipt: GenerationCostReceipt | undefined
): GenerationCostReceipt | undefined {
  if (model.provider !== "fal") return undefined;

  if (
    receipt?.provider === "fal" &&
    receipt.modelId === model.modelId
  ) {
    return receipt;
  }

  return {
    provider: "fal",
    requestId: receipt?.requestId ?? null,
    modelId: model.modelId,
    units: null,
    unit: null,
    unitPrice: null,
    currency: null,
    cost: null,
  };
}
