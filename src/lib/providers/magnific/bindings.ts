/**
 * Magnific's models, read from its API description.
 *
 * Magnific (api.magnific.com, header `x-magnific-api-key`) has no endpoint
 * that lists its models, and no schema per model. It publishes one OpenAPI
 * document for the whole API, which `npm run magnific:sync` records as
 * spec.json: every POST under /v1/ai with its request schema and the route
 * its task is polled on. Each of those is one model, and this module turns
 * it into a binding: what it produces, the handles it takes (and whether
 * each wants base64 or a URL), its settings, and the request template.
 *
 * Every endpoint is the same API on the way out (a task id, then
 * `status` and `generated[]`), so only the way in is described here. The
 * request template is in the Comfy Router binding language (template.ts)
 * and settings are derived as the Router's are (schema.ts).
 *
 * What the description cannot say is in overrides.ts.
 */
import type { ModelCapability, ModelInput, ModelParameter, ProviderModel } from "../types";
import { resolveParams } from "../comfyRouter/request";
import { deriveParams, flatten, type DerivedParam, type JsonSchema, type OpenApi } from "../comfyRouter/schema";
import { renderTemplate, type ComfyMediaValue, type Json, type MediaEncoding } from "../comfyRouter/template";
import { MAGNIFIC_DOCS_URL } from "./api";
import data from "./spec.json";
import { EXCLUDED, GROUP_OUTPUT, HIDDEN_PARAMS, NAMES, PARAM_OVERRIDES, type MagnificOutput } from "./overrides";

export type { MagnificOutput } from "./overrides";

export interface SpecEndpoint {
  /** The path after /v1/ai/; also the model id. */
  id: string;
  summary: string;
  description: string;
  deprecated?: boolean;
  /** Present when the body is not JSON. */
  contentType?: string;
  /** The route the task is read on, after /v1/ai/; null when the description has none. */
  poll: string | null;
  schema: JsonSchema | null;
}

type Schema = JsonSchema & { maxItems?: number };

/**
 * How a media field takes its file. `either` is decided per request: small
 * images go inline, everything else is uploaded and sent as a URL.
 */
export type MagnificEncoding = "base64" | "url" | "either";

export interface MagnificInput {
  /** The handle's name: the request field it fills (`prompt` and `negative_prompt` for text). */
  name: string;
  type: "text" | "image" | "video" | "audio";
  required: boolean;
  label: string;
  description?: string;
  /** Most values the handle takes. */
  max?: number;
  encoding?: MagnificEncoding;
  /** The request names the file's type beside it, so it must be known even for a URL. */
  needsMime?: boolean;
}

export interface MagnificBinding {
  id: string;
  name: string;
  description: string;
  output: MagnificOutput;
  capabilities: ModelCapability[];
  /** Route the task is read on, after /v1/ai/. */
  poll: string;
  inputs: MagnificInput[];
  params: DerivedParam[];
  /** Request template (see comfyRouter/template.ts). */
  body: Json;
}

const SPEC = data as unknown as { source: string; version: string | null; endpoints: SpecEndpoint[] };
const NO_DOC: OpenApi = {};

/* ------------------------------------------------------------------ the request's shape */

interface Shape {
  properties: Record<string, Schema>;
  required: Set<string>;
}

/**
 * The body's fields. A body that is a choice of shapes (Kling 2.6 takes a
 * text request or an image request) offers every field of every shape, and
 * requires only what all of them require.
 */
function shapeOf(schema: JsonSchema): Shape {
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.length && !schema.properties && !schema.allOf) {
    const branches = union.map((branch) => flatten(NO_DOC, branch)).filter((branch) => branch.properties);
    const properties: Record<string, Schema> = {};
    for (const branch of branches) {
      for (const [name, property] of Object.entries(branch.properties ?? {})) properties[name] ??= property;
    }
    const first = branches[0]?.required ?? [];
    return { properties, required: new Set(first.filter((name) => branches.every((branch) => branch.required?.includes(name)))) };
  }
  const flat = flatten(NO_DOC, schema);
  return { properties: flat.properties ?? {}, required: new Set(flat.required ?? []) };
}

/* ------------------------------------------------------------------ media fields */

type MediaType = "image" | "video" | "audio";

interface MediaField {
  name: string;
  type: MediaType;
  list: boolean;
  max?: number;
  /** For a list of objects: the key that holds the file. */
  itemKey?: string;
  /** The item also names its MIME type. */
  itemMime?: boolean;
  /** `name`, `name_2`, … filled in order (Flux's input_image … input_image_4). */
  slots?: string[];
  encoding: MagnificEncoding;
  description?: string;
}

function mediaType(name: string): MediaType | null {
  if (/audio/.test(name)) return "audio";
  if (/video/.test(name)) return "video";
  if (/image|frame|mask|reference/.test(name)) return "image";
  return null;
}

/** Keys that hold the file when a list's items are objects. */
const ITEM_KEYS = ["image", "url", "image_url", "video_url", "audio_url"];

function plainString(schema: JsonSchema): boolean {
  return schema.type === "string" && !schema.enum && schema.const === undefined;
}

/**
 * Whether the field takes base64, a URL, or either. The description's types
 * are unreliable (a field typed `byte` often takes a URL too), so its words
 * decide: a field that speaks of both takes both.
 */
function encodingOf(name: string, ...schemas: Array<JsonSchema | undefined>): MagnificEncoding {
  const text = schemas.map((schema) => schema?.description ?? "").join(" ");
  const formats = schemas.map((schema) => schema?.format);
  const url = formats.includes("uri") || /(^|_)urls?$/.test(name) || /\burls?\b|https?:\/\//i.test(text);
  const base64 = formats.includes("byte") || /base64/i.test(text);
  if (url && base64) return "either";
  if (base64) return "base64";
  if (url) return "url";
  return "either";
}

function mediaField(name: string, raw: Schema): MediaField | null {
  const type = mediaType(name);
  if (!type) return null;
  const schema = flatten(NO_DOC, raw) as Schema;
  const description = schema.description;
  if (plainString(schema)) return { name, type, list: false, encoding: encodingOf(name, schema), description };
  if (schema.type !== "array" || !schema.items) return null;

  const item = flatten(NO_DOC, schema.items);
  const max = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
  if (plainString(item)) return { name, type, list: true, max, encoding: encodingOf(name, schema, item), description };

  const itemKey = ITEM_KEYS.find((key) => item.properties?.[key] && plainString(flatten(NO_DOC, item.properties[key])));
  if (!itemKey) return null;
  // Anything else an item requires is something the app cannot fill.
  if ((item.required ?? []).some((key) => key !== itemKey && key !== "mime_type")) return null;
  return {
    name,
    type,
    list: true,
    max,
    itemKey,
    itemMime: Boolean(item.properties?.mime_type),
    encoding: encodingOf(itemKey, schema, item, item.properties?.[itemKey]),
    description,
  };
}

/** Fold `name_2`, `name_3`, … into the handle `name`. */
function foldSlots(fields: MediaField[]): MediaField[] {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const folded: MediaField[] = [];
  for (const field of fields) {
    const numbered = /^(.+)_(\d+)$/.exec(field.name);
    const base = numbered ? byName.get(numbered[1]!) : undefined;
    if (base && !base.list && !field.list) {
      base.slots ??= [base.name];
      base.slots.push(field.name);
      base.max = base.slots.length;
      continue;
    }
    folded.push(field);
  }
  return folded;
}

/* ------------------------------------------------------------------ naming */

const ACTION = /^(create|generate|edit|upscale|transform|adjust|extract|enhance|expand|apply|video|lip-sync|motion)\b/i;

/** A word for what the endpoint does with the model, when the model's name alone would not say. */
function modeOf(id: string): { tag: string; always: boolean } | null {
  const group = id.split("/")[0]!;
  if (id.includes("motion-control")) return { tag: "Motion Control", always: true };
  if (id.includes("transition")) return { tag: "Transition", always: true };
  if (id.includes("video-reference")) return { tag: "Video Reference", always: true };
  if (group === "image-expand") return { tag: "Expand", always: true };
  if (group === "video-edit" || /-edit$/.test(id)) return { tag: "Edit", always: true };
  if (group === "reference-to-video") return { tag: "Reference to Video", always: false };
  if (group === "text-to-video") return { tag: "Text to Video", always: false };
  if (group === "image-to-video") return { tag: "Image to Video", always: false };
  return null;
}

/** The model's name from a summary such as "Flux 2 Pro - Create image from text" (either order). */
function baseName(endpoint: SpecEndpoint): string {
  const summary = endpoint.summary.trim();
  const parts = summary.split(" - ");
  if (parts.length === 2) {
    const [left, right] = parts as [string, string];
    return (ACTION.test(left) && !ACTION.test(right) ? right : left).trim();
  }
  return (/\b(?:with|using)\s+(.+)$/i.exec(summary)?.[1] ?? summary).trim();
}

/** First sentence of the endpoint's description, without markdown. */
function describe(endpoint: SpecEndpoint): string {
  const plain = endpoint.description.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.{20,220}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain.slice(0, 200);
  return sentence || endpoint.summary;
}

function toLabel(name: string): string {
  const words = name.replace(/_urls?$/, "").replace(/_/g, " ").trim() || name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function tidy(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const plain = text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  return plain.length <= 160 ? plain : `${plain.slice(0, 159).trimEnd()}…`;
}

/* ------------------------------------------------------------------ deriving a binding */

function capabilitiesOf(output: MagnificOutput, inputs: MagnificInput[]): ModelCapability[] {
  const of = (type: MagnificInput["type"]) => inputs.filter((input) => input.type === type);
  const needs = (type: MagnificInput["type"]) => of(type).some((input) => input.required);
  if (output === "audio") return ["text-to-audio"];
  if (output === "image") {
    if (!of("image").length) return ["text-to-image"];
    return needs("image") ? ["image-to-image"] : ["text-to-image", "image-to-image"];
  }
  // A model driven by a sound track (lip sync, a talking portrait) is listed as that, whatever else it takes.
  if (needs("audio")) return ["audio-to-video"];
  if (needs("video")) return ["video-to-video"];
  if (!of("image").length) return ["text-to-video"];
  return needs("image") ? ["image-to-video"] : ["text-to-video", "image-to-video"];
}

type Derived = Omit<MagnificBinding, "name"> & { base: string; mode: ReturnType<typeof modeOf> };

/** The endpoint's binding, or the reason it has none. */
function derive(endpoint: SpecEndpoint): Derived | string {
  const { id } = endpoint;
  if (EXCLUDED[id]) return EXCLUDED[id]!;
  if (endpoint.deprecated) return "Deprecated by Magnific.";
  const output = GROUP_OUTPUT[id.split("/")[0]!];
  if (!output) return UNPLACED;
  if (!endpoint.poll) return "Has no status route in the API description, so a run could not be followed.";
  if (endpoint.contentType || !endpoint.schema) return "Does not take a JSON body.";

  const shape = shapeOf(endpoint.schema);
  const promptKey = ["prompt", "text"].find((key) => shape.properties[key] && plainString(flatten(NO_DOC, shape.properties[key])));
  const negativeKey = shape.properties.negative_prompt ? "negative_prompt" : undefined;

  const media = foldSlots(
    Object.entries(shape.properties)
      .filter(([name]) => name !== promptKey && name !== negativeKey && !HIDDEN_PARAMS.includes(name))
      .map(([name, schema]) => mediaField(name, schema))
      .filter((field): field is MediaField => field !== null)
  );
  const mediaNames = media.flatMap((field) => field.slots ?? [field.name]);

  const doc: OpenApi = {
    paths: { "/": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: shape.properties, required: [...shape.required] } } } } } } },
  };
  const params = deriveParams(
    doc,
    { exclude: [...mediaNames, ...HIDDEN_PARAMS, ...(promptKey ? [promptKey] : []), ...(negativeKey ? [negativeKey] : [])] },
    PARAM_OVERRIDES[id] ?? {}
  );
  // A required choice with no default is sent as its first option, so a run
  // never fails on a setting the user did not touch.
  for (const param of params) {
    if (param.required && param.default === undefined && param.enum?.length) param.default = param.enum[0];
  }

  const filled = new Set([...mediaNames, ...params.map((param) => param.name), ...(promptKey ? [promptKey] : []), ...(negativeKey ? [negativeKey] : [])]);
  const unfilled = [...shape.required].filter((name) => !filled.has(name));
  if (unfilled.length) return `Requires ${unfilled.map((name) => `"${name}"`).join(" and ")}, which no handle or setting can fill.`;

  const inputs: MagnificInput[] = [];
  if (promptKey) inputs.push({ name: "prompt", type: "text", required: shape.required.has(promptKey), label: "Prompt" });
  if (negativeKey) inputs.push({ name: "negative_prompt", type: "text", required: false, label: "Negative prompt" });
  const body: Json = { $params: true };
  if (promptKey) body[promptKey] = "{{prompt}}";
  if (negativeKey) body[negativeKey] = "{{negative_prompt}}";

  // Required handles first, each group in the description's order.
  const ordered = [...media].sort((a, b) => Number(shape.required.has(b.name)) - Number(shape.required.has(a.name)));
  for (const field of ordered) {
    const description = tidy(field.description);
    inputs.push({
      name: field.name,
      type: field.type,
      required: shape.required.has(field.name),
      label: toLabel(field.name),
      ...(description ? { description } : {}),
      ...(field.list || field.slots ? { max: field.max ?? LIST_MAX } : {}),
      encoding: field.encoding,
      ...(field.itemMime ? { needsMime: true } : {}),
    });
    if (field.slots) {
      body[`$slots_${field.name}`] = { $slots: `input.${field.name}`, keys: field.slots };
    } else if (field.itemKey) {
      body[field.name] = {
        $each: `input.${field.name}`,
        item: { [field.itemKey]: "{{item}}", ...(field.itemMime ? { mime_type: "{{item.mime}}" } : {}) },
      };
    } else {
      body[field.name] = field.list ? `{{input.${field.name}}}` : `{{input.${field.name}[0]}}`;
    }
  }

  return {
    id,
    base: baseName(endpoint),
    mode: modeOf(id),
    description: describe(endpoint),
    output,
    capabilities: capabilitiesOf(output, inputs),
    poll: endpoint.poll,
    inputs,
    params,
    body,
  };
}

/** A list with no stated limit still takes a sensible few. */
const LIST_MAX = 8;
const UNPLACED = "\u0000unplaced";

interface Catalog {
  bindings: Map<string, MagnificBinding>;
  excluded: Record<string, string>;
  unplaced: string[];
}

let catalog: Catalog | null = null;

function build(): Catalog {
  const derived: Derived[] = [];
  const excluded: Record<string, string> = {};
  const unplaced: string[] = [];
  for (const endpoint of SPEC.endpoints) {
    const result = derive(endpoint);
    if (result === UNPLACED) unplaced.push(endpoint.id);
    else if (typeof result === "string") excluded[endpoint.id] = result;
    else derived.push(result);
  }

  // A name is the model's own, plus what the endpoint does with it where
  // that is the point (Edit, Expand) or where two endpoints share the model.
  const shared = new Map<string, number>();
  for (const item of derived) shared.set(item.base, (shared.get(item.base) ?? 0) + 1);
  const bindings = new Map<string, MagnificBinding>();
  for (const { base, mode, ...rest } of derived) {
    const tagged = mode && (mode.always || shared.get(base)! > 1) && !base.toLowerCase().includes(mode.tag.toLowerCase());
    bindings.set(rest.id, { ...rest, name: NAMES[rest.id] ?? (tagged ? `${base} ${mode.tag}` : base) });
  }
  return { bindings, excluded, unplaced };
}

function loaded(): Catalog {
  catalog ??= build();
  return catalog;
}

export function magnificBindings(): MagnificBinding[] {
  return [...loaded().bindings.values()];
}

export function magnificBinding(id: string): MagnificBinding | undefined {
  return loaded().bindings.get(id);
}

/** Endpoints the app does not offer, with the reason for each. */
export function magnificExcluded(): Record<string, string> {
  return loaded().excluded;
}

/** Endpoints in a group overrides.ts does not know. Empty unless Magnific added a kind of endpoint. */
export function magnificUnplaced(): string[] {
  return loaded().unplaced;
}

/** The recorded endpoints, for the suite. */
export function magnificSpecEndpoints(): SpecEndpoint[] {
  return SPEC.endpoints;
}

/* ------------------------------------------------------------------ the node's view */

/** Every model the app offers, for the browse dialog and the agent's search. No request is made. */
export function magnificProviderModels(): ProviderModel[] {
  return magnificBindings().map((binding) => ({
    id: binding.id,
    name: binding.name,
    description: binding.description,
    provider: "magnific",
    capabilities: binding.capabilities,
    pageUrl: MAGNIFIC_DOCS_URL,
  }));
}

/** Node settings: what the user can change (fixed values are sent, not shown). */
export function magnificNodeParameters(binding: MagnificBinding): ModelParameter[] {
  return binding.params.filter((param) => param.fixed === undefined).map(({ at: _at, fixed: _fixed, ...param }) => param);
}

/** Node handles, from the binding's media and text inputs. */
export function magnificNodeInputs(binding: MagnificBinding): ModelInput[] {
  return binding.inputs.map((input) => ({
    name: input.name,
    type: input.type,
    required: input.required,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    ...(input.type !== "text" && (input.max ?? 1) > 1 ? { isArray: true } : {}),
  }));
}

export function magnificNodeSchema(id: string): { parameters: ModelParameter[]; inputs: ModelInput[] } | null {
  const binding = magnificBinding(id);
  return binding ? { parameters: magnificNodeParameters(binding), inputs: magnificNodeInputs(binding) } : null;
}

/* ------------------------------------------------------------------ the request */

export interface MagnificRequestInput {
  prompt: string;
  negativePrompt?: string;
  parameters?: Record<string, unknown>;
  /** Encoded media per handle name. */
  media: Record<string, ComfyMediaValue[]>;
  /** How each handle's media go in this request: `either` already decided. */
  encodings: Record<string, MediaEncoding>;
}

/** Missing required handles, as a message the node can show. */
export function missingMagnificInputs(binding: MagnificBinding, input: MagnificRequestInput): string | null {
  const missing: string[] = [];
  for (const handle of binding.inputs) {
    if (!handle.required || handle.name === "negative_prompt") continue;
    if (handle.name === "prompt") {
      if (!input.prompt.trim()) missing.push("a prompt");
    } else if (!input.media[handle.name]?.length) {
      missing.push(handle.label.toLowerCase());
    }
  }
  return missing.length ? `${binding.name} needs ${missing.join(" and ")}` : null;
}

/** The request body: the user's settings, the prompt, and each handle's media where its field is. */
export function buildMagnificBody(binding: MagnificBinding, input: MagnificRequestInput): Json {
  const media: Record<string, ComfyMediaValue[]> = {};
  for (const handle of binding.inputs) {
    const values = input.media[handle.name];
    if (values?.length) media[handle.name] = values.slice(0, handle.max ?? 1);
  }
  return renderTemplate(binding.body, {
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    params: resolveParams(binding.params, input.parameters),
    spreadParams: binding.params.map((param) => param.name),
    media,
    encodings: input.encodings,
  });
}
