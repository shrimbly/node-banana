/**
 * The one list of text (LLM) models Node Banana offers.
 *
 * Every dropdown, the `/api/llm` route, the node defaults and the assistant's
 * own model come from here. To add, rename or retire a model, edit this file
 * only. Verified against the providers' live model lists and docs on
 * 2026-09-10; the drift check in `__tests__/catalog.test.ts` keeps the docs
 * in step with it.
 *
 * This module is imported by `@/types`, so it must not import from there.
 */

export type LLMProvider = "google" | "openai" | "anthropic";

export const LLM_PROVIDER_OPTIONS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

export interface LLMModelEntry {
  /** The id stored in workflows and shown in the dropdown value. */
  id: string;
  provider: LLMProvider;
  label: string;
  /** What the provider API is actually sent. Defaults to `id`. */
  apiId?: string;
}

/**
 * Models offered in the dropdowns, in display order. The first entry per
 * provider is what a node gets when it switches to that provider.
 */
export const LLM_MODELS = [
  // Google — https://ai.google.dev/gemini-api/docs/models
  { id: "gemini-3.8-flash", provider: "google", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", provider: "google", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", provider: "google", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", provider: "google", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", provider: "google", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", provider: "google", label: "Gemini 3.1 Pro (preview)" },
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash" },
  // OpenAI — https://developers.openai.com/api/docs/models
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna" },
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol" },
  { id: "gpt-6-astra", provider: "openai", label: "GPT-6 Astra" },
  // Anthropic — https://platform.claude.com/docs/en/models/overview
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5" },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1" },
] as const satisfies readonly LLMModelEntry[];

/** An id currently offered in the dropdowns. */
export type LLMModelId = (typeof LLM_MODELS)[number]["id"];

/**
 * Any model id a workflow may carry: a current id, or one from an older
 * release that `resolveLLMModel` still knows how to run or replace.
 */
export type LLMModelType = LLMModelId | (string & {});

export interface LegacyLLMModel extends LLMModelEntry {
  /**
   * `served`: the provider still runs it, so it keeps working but is no
   * longer offered. `retired`: gone upstream; requests are moved to
   * `replacement` and the workflow is told.
   */
  status: "served" | "retired";
  replacement?: LLMModelId;
}

/**
 * Ids Node Banana shipped in the past. Saved workflows reference them, so
 * they must stay resolvable; nothing here appears in a dropdown unless a
 * node already has it selected.
 */
export const LEGACY_LLM_MODELS: readonly LegacyLLMModel[] = [
  { id: "gemini-3-flash-preview", provider: "google", label: "Gemini 3 Flash (preview)", status: "served" },
  { id: "gemini-3-pro-preview", provider: "google", label: "Gemini 3 Pro (preview)", status: "retired", replacement: "gemini-3.1-pro-preview" },
  { id: "gpt-4.1-mini", provider: "openai", label: "GPT-4.1 Mini", status: "served" },
  { id: "gpt-4.1-nano", provider: "openai", label: "GPT-4.1 Nano", status: "served" },
  { id: "claude-sonnet-4.5", provider: "anthropic", label: "Claude Sonnet 4.5", apiId: "claude-sonnet-4-5-20250929", status: "served" },
  { id: "claude-opus-4.6", provider: "anthropic", label: "Claude Opus 4.6", apiId: "claude-opus-4-6", status: "served" },
  // Same model as the current entry; the id was spelled with a dot.
  { id: "claude-haiku-4.5", provider: "anthropic", label: "Claude Haiku 4.5", status: "retired", replacement: "claude-haiku-4-5" },
];

export const DEFAULT_LLM_PROVIDER: LLMProvider = "google";
export const DEFAULT_LLM_MODEL: LLMModelId = "gemini-3.8-flash";

/**
 * The model behind Node Banana's own Gemini-only features: the chat
 * assistant, prompt-to-workflow and proposals. Google only, because those
 * routes are written against the Gemini SDK.
 */
export const ASSISTANT_MODEL = "gemini-3.8-flash";

const currentById = new Map<string, LLMModelEntry>(LLM_MODELS.map((m) => [m.id, m]));
const legacyById = new Map<string, LegacyLLMModel>(LEGACY_LLM_MODELS.map((m) => [m.id, m]));

/** The first current model for a provider: what a node gets on a provider switch. */
export function defaultLLMModel(provider: LLMProvider): LLMModelId {
  const first = LLM_MODELS.find((m) => m.provider === provider);
  if (!first) throw new Error(`No LLM models for provider ${provider}`);
  return first.id;
}

/** Display name for any known id; the raw id when unknown. */
export function llmModelLabel(id: string): string {
  const current = currentById.get(id);
  if (current) return current.label;
  const legacy = legacyById.get(id);
  if (legacy) return `${legacy.label} (legacy)`;
  return id;
}

/**
 * Dropdown options for a provider. A node whose stored model is a legacy id
 * keeps it selectable, labelled as such, until the user picks another.
 */
export function llmModelOptions(
  provider: LLMProvider,
  current?: string | null,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = LLM_MODELS.filter((m) => m.provider === provider).map(
    (m) => ({ value: m.id, label: m.label }),
  );
  const known = current ? (currentById.get(current) ?? legacyById.get(current)) : undefined;
  if (current && !options.some((o) => o.value === current) && (!known || known.provider === provider)) {
    options.push({ value: current, label: llmModelLabel(current) });
  }
  return options;
}

export function isCurrentLLMModel(id: string): id is LLMModelId {
  return currentById.has(id);
}

export interface ResolvedLLMModel {
  /** The catalogue id that will run: the requested one, or its replacement. */
  id: string;
  provider: LLMProvider;
  label: string;
  /** What to send to the provider API. */
  apiId: string;
  /** Present when the requested id was retired and another model was used. */
  substitution?: { from: string; note: string };
}

/**
 * Turn a stored (provider, model) pair into something the provider API
 * accepts. Returns null for an id the catalogue has never seen, or one that
 * belongs to a different provider.
 */
export function resolveLLMModel(provider: LLMProvider, id: string): ResolvedLLMModel | null {
  const current = currentById.get(id);
  if (current) {
    if (current.provider !== provider) return null;
    return { id: current.id, provider, label: current.label, apiId: current.apiId ?? current.id };
  }

  const legacy = legacyById.get(id);
  if (!legacy || legacy.provider !== provider) return null;

  if (legacy.status === "served" || !legacy.replacement) {
    return { id: legacy.id, provider, label: legacy.label, apiId: legacy.apiId ?? legacy.id };
  }

  const replacement = currentById.get(legacy.replacement);
  if (!replacement) return null;
  return {
    id: replacement.id,
    provider,
    label: replacement.label,
    apiId: replacement.apiId ?? replacement.id,
    substitution: {
      from: legacy.id,
      note: `${legacy.label} (${legacy.id}) is no longer available; used ${replacement.label} (${replacement.id}) instead.`,
    },
  };
}

/** One line per provider, for prose that lists the menu (the chat assistant's node docs). */
export function describeLLMModels(): string {
  return LLM_PROVIDER_OPTIONS.map(({ value, label }) => {
    const names = LLM_MODELS.filter((m) => m.provider === value).map((m) => m.label);
    return `${names.join(", ")} (${label})`;
  }).join(" / ");
}
