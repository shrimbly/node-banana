/**
 * Nodes classic dims (WorkflowCanvas's allNodes): those downstream of a
 * disabled Switch output (`switch-dimmed`, 40%) and those skipped for empty
 * optional inputs (`node-skipped`, 35%, which wins when both apply). Switch
 * and Conditional Switch nodes themselves are never dimmed.
 */

export const SWITCH_DIMMED_OPACITY = 0.4;
export const SKIPPED_OPACITY = 0.35;

const NEVER_DIMMED = new Set(["switch", "conditionalSwitch"]);

/** The classes classic gives a node for its dimming, or undefined. */
export function dimClassName(id: string, type: string | undefined, dimmed: ReadonlySet<string>, skipped: ReadonlySet<string>): string | undefined {
  if (type && NEVER_DIMMED.has(type)) return undefined;
  const classes = [dimmed.has(id) ? "switch-dimmed" : "", skipped.has(id) ? "node-skipped" : ""].filter(Boolean).join(" ");
  return classes || undefined;
}

/** Each dimmed node's opacity, as globals.css gives its classes. */
export function dimOpacities(typeOf: (id: string) => string | undefined, dimmed: ReadonlySet<string>, skipped: ReadonlySet<string>): Map<string, number> {
  const opacities = new Map<string, number>();
  for (const id of dimmed) if (!NEVER_DIMMED.has(typeOf(id) ?? "")) opacities.set(id, SWITCH_DIMMED_OPACITY);
  for (const id of skipped) if (!NEVER_DIMMED.has(typeOf(id) ?? "")) opacities.set(id, SKIPPED_OPACITY);
  return opacities;
}
