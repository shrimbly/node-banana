/**
 * The Router's wire formats, as data.
 *
 * `families.json` holds one entry per partner request format: the request
 * template, the media handles it fills, where its settings live in the
 * schema, and where the output (or the partner's error) sits in the
 * response. Each family lists the Router models that speak it, with the
 * name and description the app shows and any per-model narrowing.
 *
 * Models the app cannot drive are listed under `excluded` with the reason
 * (text models, provider aliases with no published schema, inputs the app
 * has no handle for), so coverage is explicit rather than silent.
 */
import type { ModelCapability } from "../types";
import type { ParamOverride, ParamsSpec } from "./schema";
import type { MediaEncoding, ResultSpec } from "./template";
import data from "./families.json";

export type RouterOutput = "image" | "video" | "audio" | "3d";

/**
 * How the Router runs the model: through its queue (submit, poll, collect),
 * or on the model's own route in one request. The queue cannot hold a
 * partner's raw bytes, so a family whose answer is the asset itself
 * (ElevenLabs) is `sync`; the Router refuses it on the queued route with
 * `not_enabled`.
 */
export type RouterTransport = "queue" | "sync";

export interface RouterInput {
  name: string;
  type: "text" | "image" | "video" | "audio";
  required: boolean;
  label: string;
  description?: string;
  /** Most values the handle takes. */
  max?: number;
  encoding?: MediaEncoding;
}

export interface RouterModelEntry {
  id: string;
  name: string;
  description: string;
  capabilities: ModelCapability[];
  /** Some media go up as uploads (the partner takes URLs only). */
  uploads?: boolean;
  output?: RouterOutput;
  inputs?: RouterInput[];
  params?: ParamsSpec;
  paramOverrides?: Record<string, ParamOverride>;
  body?: unknown;
  result?: ResultSpec;
  transport?: RouterTransport;
  /**
   * Who can serve the model, first being the default. "comfy" is Comfy's own
   * routing to the model's maker; the others (fal, Higgsfield, Runware,
   * WaveSpeed) run the same model and take the same request, chosen with
   * `?model_provider=` on the submit.
   */
  providers?: string[];
}

export interface RouterFamily {
  family: string;
  provider: string;
  output: RouterOutput;
  inputs: RouterInput[];
  params: ParamsSpec;
  paramOverrides?: Record<string, ParamOverride>;
  body: unknown;
  result: ResultSpec;
  transport?: RouterTransport;
  models: RouterModelEntry[];
  notes?: string;
}

/** A model with its family's defaults applied: everything needed to call it. */
export interface RouterBinding {
  id: string;
  name: string;
  description: string;
  family: string;
  provider: string;
  output: RouterOutput;
  capabilities: ModelCapability[];
  uploads: boolean;
  inputs: RouterInput[];
  params: ParamsSpec;
  paramOverrides: Record<string, ParamOverride>;
  body: unknown;
  result: ResultSpec;
  transport: RouterTransport;
  /** Serving providers, default first; empty when the model has one. */
  providers: string[];
}

const FAMILIES = (data as unknown as { families: RouterFamily[] }).families;
export const EXCLUDED_ROUTER_MODELS: Record<string, string> = (data as unknown as { excluded: Record<string, string> }).excluded;

/** Per setting: the model's fields win, the family's fill the rest. */
function mergeOverrides(
  family: Record<string, ParamOverride> = {},
  model: Record<string, ParamOverride> = {}
): Record<string, ParamOverride> {
  const out: Record<string, ParamOverride> = { ...family };
  for (const [name, override] of Object.entries(model)) out[name] = { ...(family[name] ?? {}), ...override };
  return out;
}

function bind(family: RouterFamily, model: RouterModelEntry): RouterBinding {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    family: family.family,
    provider: family.provider,
    output: model.output ?? family.output,
    capabilities: model.capabilities,
    uploads: model.uploads ?? false,
    inputs: model.inputs ?? family.inputs,
    params: model.params ?? family.params,
    paramOverrides: mergeOverrides(family.paramOverrides, model.paramOverrides),
    body: model.body ?? family.body,
    result: model.result ?? family.result,
    transport: model.transport ?? family.transport ?? "queue",
    providers: model.providers ?? [],
  };
}

const BY_ID = new Map<string, RouterBinding>();
for (const family of FAMILIES) {
  for (const model of family.models) BY_ID.set(model.id, bind(family, model));
}

export function routerBinding(id: string): RouterBinding | undefined {
  return BY_ID.get(id);
}

export function routerBindings(): RouterBinding[] {
  return [...BY_ID.values()];
}
