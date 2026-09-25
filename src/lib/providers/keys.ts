/**
 * Provider API keys for server-side model listing and schema lookups.
 *
 * `listModels` (./registry) and `getModelSchema` (./schema) take their keys
 * as a plain object so any server code can call them. A route builds that
 * object from the request with `providerKeysFromHeaders`: a key sent by the
 * client wins, otherwise the server's `.env` key serves.
 *
 * Server only: the Comfy fallback reads the Comfy env vars.
 */

import { COMFY_ROUTER_HEADER, resolveComfyRouterKey } from "@/app/api/generate/providers/comfy";

export interface ProviderKeys {
  replicate?: string;
  fal?: string;
  kie?: string;
  wavespeed?: string;
  openai?: string;
  gemini?: string;
  comfy?: string;
}

/**
 * Header names accepted for each provider, in order of preference. The
 * models routes and the generate route historically spell the Replicate and
 * fal.ai headers differently; both are read.
 */
const KEY_SOURCES: Record<Exclude<keyof ProviderKeys, "comfy">, { headers: string[]; env: string }> = {
  replicate: { headers: ["X-Replicate-Key", "X-Replicate-API-Key"], env: "REPLICATE_API_KEY" },
  fal: { headers: ["X-Fal-Key", "X-Fal-API-Key"], env: "FAL_API_KEY" },
  kie: { headers: ["X-Kie-Key"], env: "KIE_API_KEY" },
  wavespeed: { headers: ["X-WaveSpeed-Key"], env: "WAVESPEED_API_KEY" },
  openai: { headers: ["X-OpenAI-API-Key"], env: "OPENAI_API_KEY" },
  gemini: { headers: ["X-Gemini-API-Key"], env: "GEMINI_API_KEY" },
};

/**
 * Resolve every provider key for a request: the header if present, else the
 * env variable. Comfy Router goes through `resolveComfyRouterKey` (header,
 * then COMFY_API_KEY, then COMFY_CLOUD_API_KEY). Providers with no key are
 * left out of the result; empty strings count as absent.
 */
export function providerKeysFromHeaders(headers: Headers): ProviderKeys {
  const keys: ProviderKeys = {};

  for (const [provider, source] of Object.entries(KEY_SOURCES) as Array<
    [keyof typeof KEY_SOURCES, (typeof KEY_SOURCES)[keyof typeof KEY_SOURCES]]
  >) {
    const fromHeader = source.headers.map((name) => headers.get(name)).find(Boolean);
    const value = fromHeader || process.env[source.env];
    if (value) keys[provider] = value;
  }

  const comfy = resolveComfyRouterKey(headers.get(COMFY_ROUTER_HEADER));
  if (comfy) keys.comfy = comfy;

  return keys;
}
