"use client";

import { useState, useMemo } from "react";
import { selectNodeContent } from "@/store/selectors/nodeContent";
import { useWorkflowStore } from "@/store/workflowStore";
import { calculatePredictedCost, formatCost, hasNonGeminiProviders } from "@/utils/costCalculator";
import { CostDialog } from "./CostDialog";

export function CostIndicator() {
  const [showDialog, setShowDialog] = useState(false);
  const nodes = useWorkflowStore(selectNodeContent);
  const incurredCost = useWorkflowStore((state) => state.incurredCost);

  const predictedCost = useMemo(() => {
    return calculatePredictedCost(nodes);
  }, [nodes]);

  const nonGemini = useMemo(() => hasNonGeminiProviders(nodes), [nodes]);
  const hasAnyNodes = predictedCost.nodeCount > 0;

  if (nonGemini || (!hasAnyNodes && incurredCost === 0)) {
    return null;
  }

  // Always show dollar format (external provider costs not included in total)
  const displayCost = formatCost(predictedCost.totalCost);

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className="px-2 py-0.5 rounded text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
        title="View cost details"
      >
        {displayCost}
      </button>

      {showDialog && (
        <CostDialog
          predictedCost={predictedCost}
          incurredCost={incurredCost}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}
