import type { GenerationCostReceipt } from "@/types";

export function formatGenerationCost(
  cost: number | null,
  currency: string | null
): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return "—";

  const maximumFractionDigits = cost >= 1 ? 2 : cost >= 0.01 ? 4 : 8;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits,
    }).format(cost);
  } catch {
    return `$${cost.toFixed(maximumFractionDigits).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
}

export function GenerationCostBadge({
  receipt,
}: {
  receipt: GenerationCostReceipt;
}) {
  return (
    <span
      aria-label="Generation cost"
      className="inline-flex h-5 items-center rounded border border-white/10 bg-black/75 px-1.5 text-[10px] font-medium tabular-nums leading-none text-white/90 shadow-sm backdrop-blur-sm"
    >
      {formatGenerationCost(receipt.cost, receipt.currency)}
    </span>
  );
}
