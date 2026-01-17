"use client";

import { useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { PredictedCostResult, CostBreakdownItem, formatCost } from "@/utils/costCalculator";
import { ProviderType } from "@/types/providers";

interface CostDialogProps {
  predictedCost: PredictedCostResult;
  incurredCost: number;
  onClose: () => void;
}

/**
 * Provider icon component - colored dot with provider indicator
 */
function ProviderIcon({ provider }: { provider: ProviderType }) {
  const colors: Record<ProviderType, { bg: string; text: string }> = {
    gemini: { bg: "bg-green-500/20", text: "text-green-300" },
    fal: { bg: "bg-purple-500/20", text: "text-purple-300" },
    replicate: { bg: "bg-blue-500/20", text: "text-blue-300" },
    openai: { bg: "bg-teal-500/20", text: "text-teal-300" },
  };

  const labels: Record<ProviderType, string> = {
    gemini: "G",
    fal: "f",
    replicate: "R",
    openai: "O",
  };

  const color = colors[provider] || colors.gemini;

  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${color.bg} ${color.text} text-xs font-medium`}>
      {labels[provider]}
    </span>
  );
}

/**
 * Get display name for provider
 */
function getProviderDisplayName(provider: ProviderType): string {
  const names: Record<ProviderType, string> = {
    gemini: "Gemini",
    fal: "fal.ai",
    replicate: "Replicate",
    openai: "OpenAI",
  };
  return names[provider] || provider;
}

/**
 * Get model page URL for external providers
 */
function getModelUrl(provider: ProviderType, modelId: string): string | null {
  if (provider === "replicate") {
    // modelId format: "owner/model" or "owner/model:version"
    const baseModelId = modelId.split(":")[0];
    return `https://replicate.com/${baseModelId}`;
  }
  if (provider === "fal") {
    // modelId format: "fal-ai/flux/dev" or similar
    return `https://fal.ai/models/${modelId}`;
  }
  return null;
}

/**
 * External link icon component
 */
function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

export function CostDialog({ predictedCost, incurredCost, onClose }: CostDialogProps) {
  const resetIncurredCost = useWorkflowStore((state) => state.resetIncurredCost);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleReset = () => {
    if (confirm("Reset incurred cost to $0.00?")) {
      resetIncurredCost();
    }
  };

  // Separate Gemini (reliable pricing) from external providers (unreliable pricing)
  const geminiItems = predictedCost.breakdown.filter((item) => item.provider === "gemini");
  const externalItems = predictedCost.breakdown.filter(
    (item) => item.provider === "fal" || item.provider === "replicate"
  );

  // Group external items by provider
  const externalByProvider = new Map<ProviderType, CostBreakdownItem[]>();
  externalItems.forEach((item) => {
    const existing = externalByProvider.get(item.provider);
    if (existing) {
      existing.push(item);
    } else {
      externalByProvider.set(item.provider, [item]);
    }
  });

  const geminiTotal = geminiItems.reduce((sum, item) => sum + (item.subtotal ?? 0), 0);
  const externalNodeCount = externalItems.reduce((sum, item) => sum + item.count, 0);

  const hasGemini = geminiItems.length > 0;
  const hasExternal = externalItems.length > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="bg-neutral-800 rounded-lg p-6 w-[400px] border border-neutral-700 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-100">
            Workflow Costs
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          {/* Gemini Cost Section - prices are reliable */}
          {hasGemini && (
            <div className="bg-neutral-900 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <ProviderIcon provider="gemini" />
                <span className="text-sm text-neutral-300">Gemini Cost</span>
                <span className="ml-auto text-lg font-semibold text-green-400">
                  {formatCost(geminiTotal)}
                </span>
              </div>

              <div className="space-y-1 pl-7">
                {geminiItems.map((item, idx) => (
                  <div key={idx} className="flex justify-between text-xs">
                    <span className="text-neutral-500">
                      {item.count}x {item.modelName}
                    </span>
                    <span className="text-neutral-400">
                      {item.subtotal !== null ? formatCost(item.subtotal) : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* External Providers Section - show model links instead of prices */}
          {hasExternal && (
            <div className="bg-neutral-900 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-neutral-300">External Providers</span>
                <span className="text-xs text-neutral-500">
                  {externalNodeCount} node{externalNodeCount !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="space-y-3">
                {Array.from(externalByProvider.entries()).map(([provider, items]) => (
                  <div key={provider}>
                    <div className="flex items-center gap-2 text-xs text-neutral-400 mb-1">
                      <ProviderIcon provider={provider} />
                      <span>{getProviderDisplayName(provider)}</span>
                    </div>
                    <div className="space-y-1 pl-7">
                      {items.map((item, idx) => {
                        const modelUrl = getModelUrl(provider, item.modelId);
                        return (
                          <div key={idx} className="flex items-center justify-between text-xs">
                            <span className="text-neutral-500">
                              {item.count}x {item.modelName}
                            </span>
                            {modelUrl && (
                              <a
                                href={modelUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300 flex items-center gap-1"
                              >
                                View model
                                <ExternalLinkIcon />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-neutral-600 mt-3">
                Pricing varies by model, hardware, and usage. Check provider for details.
              </p>
            </div>
          )}

          {/* No nodes message */}
          {predictedCost.nodeCount === 0 && (
            <div className="bg-neutral-900 rounded-lg p-4">
              <p className="text-xs text-neutral-500">
                No generation nodes in workflow
              </p>
            </div>
          )}

          {/* Incurred Cost Section - Gemini only */}
          <div className="bg-neutral-900 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-neutral-400">Incurred Cost</span>
              <span className="text-lg font-semibold text-green-400">
                {formatCost(incurredCost)}
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              Actual API spend from Gemini generations
            </p>

            {incurredCost > 0 && (
              <button
                onClick={handleReset}
                className="mt-3 text-xs text-neutral-400 hover:text-red-400 transition-colors"
              >
                Reset to $0.00
              </button>
            )}
          </div>

          {/* Pricing Note */}
          <div className="text-xs text-neutral-600">
            <p>Gemini pricing: $0.039-$0.24/image. External providers not tracked.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
