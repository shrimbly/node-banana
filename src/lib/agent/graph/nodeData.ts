/**
 * The part of `node.data` the agent sees: settings plus the structure handles
 * depend on, trimmed of media and bulk. Shared by the browser snapshot and the
 * server draft (for nodes the agent creates), so both describe nodes the same
 * way.
 */

import type { NodeType } from "@/types";
import { NODE_CATALOG } from "./catalog";
import { FULL_TEXT_LIMIT, OMITTED_PREFIX, capText, scrubDeep } from "./scrub";

/**
 * Free-text fields kept whole (up to FULL_TEXT_LIMIT, then capped with a
 * visible marker), so the draft can edit a long prompt without cutting it.
 * The views the model reads show only part of them (describe.ts).
 */
const LONG_TEXT_FIELDS = new Set(["prompt", "template"]);
const MAX_ARRAY_ITEMS_SHOWN = 50;
const MAX_ARRAY_ITEM_LENGTH = 200;
/**
 * ComfyUI combo options are kept in full (checkpoint and LoRA lists run past
 * scrubDeep's 200 items) so settings validate against the real list; the
 * views show a preview. Beyond this many the list is cut with a marker.
 */
const COMFY_ENUM_MAX = 5000;
const COMFY_ENUM_ITEM_LENGTH = 500;

/** Whitelisted, media-free copy of a node's data for the agent. */
export function pickAgentData(type: NodeType, data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data) return out;
  const entry = NODE_CATALOG[type];
  if (!entry) return out;

  for (const field of [...entry.dataFields, "comment"]) {
    const value = data[field];
    if (value === undefined || value === null || value === "") {
      // Keep explicit nulls that carry meaning (switch inputType, gif size limit).
      if (value === null && (field === "inputType" || field === "targetMaxBytes" || field === "easingPreset")) out[field] = null;
      continue;
    }
    switch (field) {
      case "selectedModel": {
        const model = value as { provider?: unknown; modelId?: unknown; displayName?: unknown };
        out.selectedModel = { provider: model.provider, modelId: model.modelId, displayName: model.displayName };
        break;
      }
      case "inputSchema":
        if (Array.isArray(value)) {
          out.inputSchema = value
            .filter((input) => input && typeof input === "object")
            .map((input) => {
              const i = input as { name?: unknown; type?: unknown; label?: unknown; required?: unknown; isArray?: unknown };
              // isArray: the input collects every connection (Omni's reference images).
              return { name: i.name, type: i.type, label: i.label, required: i.required, ...(i.isArray === true ? { isArray: true } : {}) };
            });
        }
        break;
      case "rules":
        if (Array.isArray(value)) {
          out.rules = value
            .filter((rule) => rule && typeof rule === "object")
            .map((rule) => {
              const r = rule as { id?: unknown; label?: unknown; value?: unknown; mode?: unknown };
              return { id: r.id, label: r.label, value: r.value, mode: r.mode };
            });
        }
        break;
      case "app":
        out.app = summarizeComfyApp(value);
        break;
      case "outputItems":
        if (Array.isArray(value)) {
          out.outputItems = value
            .slice(0, MAX_ARRAY_ITEMS_SHOWN)
            .map((item) => (typeof item === "string" ? capText(item, MAX_ARRAY_ITEM_LENGTH) : item));
          if (value.length > MAX_ARRAY_ITEMS_SHOWN) out.outputItemCount = value.length;
        }
        break;
      default:
        out[field] = typeof value === "string" && LONG_TEXT_FIELDS.has(field)
          ? scrubDeep(capText(value, FULL_TEXT_LIMIT), Infinity)
          : scrubDeep(value);
    }
  }
  return out;
}

/** A ComfyUI app contract without its graph or thumbnail. */
function summarizeComfyApp(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const app = value as {
    name?: unknown;
    description?: unknown;
    inputs?: unknown;
    params?: unknown;
    outputs?: unknown;
  };
  const list = (items: unknown, pick: (item: Record<string, unknown>) => Record<string, unknown>) =>
    Array.isArray(items) ? items.filter((i) => i && typeof i === "object").map((i) => pick(i as Record<string, unknown>)) : [];
  const rawParams = list(app.params, (p) => p);
  const summary = scrubDeep({
    name: app.name,
    description: typeof app.description === "string" ? capText(app.description, 300) : undefined,
    inputs: list(app.inputs, (i) => ({ name: i.name, label: i.label, type: i.type, required: i.required })),
    params: rawParams.map((p) => ({
      id: p.id,
      label: p.label,
      type: p.type,
      minimum: p.minimum,
      maximum: p.maximum,
      default: typeof p.default === "object" ? undefined : p.default,
    })),
    outputs: list(app.outputs, (o) => ({ id: o.id, label: o.label, type: o.type })),
  }) as Record<string, unknown>;
  // Enums skip scrubDeep's 200-item cap.
  const params = summary.params as unknown[];
  rawParams.forEach((raw, index) => {
    const param = params[index];
    if (Array.isArray(raw.enum) && param && typeof param === "object") (param as Record<string, unknown>).enum = comfyEnum(raw.enum);
  });
  return summary;
}

function comfyEnum(values: unknown[]): Array<string | number> {
  const options = values
    .filter((v): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
    .map((v) => (typeof v === "string" && v.length > COMFY_ENUM_ITEM_LENGTH ? v.slice(0, COMFY_ENUM_ITEM_LENGTH) : v));
  if (options.length <= COMFY_ENUM_MAX) return options;
  return [...options.slice(0, COMFY_ENUM_MAX), `${OMITTED_PREFIX} ${options.length - COMFY_ENUM_MAX} more items]`];
}
