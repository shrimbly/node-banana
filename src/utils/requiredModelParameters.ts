import type { RequiredModelParameter } from "@/types";

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

export function getMissingRequiredModelParameters(
  requiredParameters: RequiredModelParameter[] | undefined,
  parameters: Record<string, unknown> | undefined
): RequiredModelParameter[] {
  return (requiredParameters || []).filter(
    (parameter) => !hasValue(parameters?.[parameter.name])
  );
}

export function formatMissingRequiredModelParameters(
  missingParameters: RequiredModelParameter[]
): string {
  const labels = missingParameters.map((parameter) => parameter.label).join(", ");
  return `Missing required field${missingParameters.length === 1 ? "" : "s"}: ${labels}`;
}
